using AIChatApi.Data;
using AIChatApi.Models;
using Anthropic.SDK;
using Anthropic.SDK.Constants;
using Anthropic.SDK.Messaging;
using Dapper;
using Pgvector;
using UglyToad.PdfPig;

namespace AIChatApi.Services;

public class RagService(DbConnectionFactory db, EmbeddingService embeddingService, AnthropicClient anthropic)
{
    private const int ChunkSize = 500;
    private const int ChunkOverlap = 50;

    public async Task<UploadDocumentResponse> IngestAsync(Stream pdfStream, string fileName, CancellationToken cancellationToken = default)
    {
        var text = ExtractText(pdfStream);
        var chunks = ChunkText(text);
        var embeddings = await embeddingService.EmbedBatchAsync(chunks, cancellationToken);

        using var conn = db.Create();

        var documentId = await conn.ExecuteScalarAsync<Guid>(
            "INSERT INTO documents (file_name) VALUES (@fileName) RETURNING id",
            new { fileName });

        for (var i = 0; i < chunks.Count; i++)
        {
            await conn.ExecuteAsync(
                "INSERT INTO document_chunks (document_id, chunk_index, content, embedding) VALUES (@documentId, @chunkIndex, @content, @embedding)",
                new { documentId, chunkIndex = i, content = chunks[i], embedding = new Vector(embeddings[i]) });
        }

        return new UploadDocumentResponse(documentId, fileName, chunks.Count);
    }

    public async Task<RagQueryResponse> QueryAsync(string question, int topK = 5, CancellationToken cancellationToken = default)
    {
        var queryEmbedding = new Vector(await embeddingService.EmbedAsync(question, cancellationToken));

        using var conn = db.Create();

        var chunks = (await conn.QueryAsync<string>(
            "SELECT content FROM document_chunks ORDER BY embedding <=> @embedding LIMIT @topK",
            new { embedding = queryEmbedding, topK })).ToList();

        if (chunks.Count == 0)
            return new RagQueryResponse("No relevant documents found.", []);

        var context = string.Join("\n\n---\n\n", chunks);
        var prompt = $"""
            Answer the question using only the context below. If the answer is not in the context, say so.

            Context:
            {context}

            Question: {question}
            """;

        var response = await anthropic.Messages.GetClaudeMessageAsync(new MessageParameters
        {
            Model = AnthropicModels.Claude46Sonnet,
            MaxTokens = 1024,
            Messages = [new Message { Role = RoleType.User, Content = [new TextContent { Text = prompt }] }]
        }, cancellationToken);

        var answer = response.Content.OfType<TextContent>().FirstOrDefault()?.Text ?? "";
        return new RagQueryResponse(answer, chunks);
    }

    public async Task<List<DocumentSummary>> ListDocumentsAsync(CancellationToken cancellationToken = default)
    {
        using var conn = db.Create();
        var rows = await conn.QueryAsync<(Guid Id, string FileName, DateTime UploadedAt, int ChunkCount)>(
            "SELECT d.id, d.file_name, d.uploaded_at, COUNT(c.id)::int AS chunk_count FROM documents d LEFT JOIN document_chunks c ON c.document_id = d.id GROUP BY d.id");
        return rows.Select(r => new DocumentSummary(r.Id, r.FileName, r.UploadedAt, r.ChunkCount)).ToList();
    }

    public async Task<bool> DeleteDocumentAsync(Guid id, CancellationToken cancellationToken = default)
    {
        using var conn = db.Create();
        var affected = await conn.ExecuteAsync("DELETE FROM documents WHERE id = @id", new { id });
        return affected > 0;
    }

    private static string ExtractText(Stream pdfStream)
    {
        using var pdf = PdfDocument.Open(pdfStream);
        return string.Join(" ", pdf.GetPages().Select(p => p.Text));
    }

    private static List<string> ChunkText(string text)
    {
        var chunks = new List<string>();
        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var i = 0;
        while (i < words.Length)
        {
            var chunk = string.Join(" ", words.Skip(i).Take(ChunkSize));
            if (!string.IsNullOrWhiteSpace(chunk))
                chunks.Add(chunk);
            i += ChunkSize - ChunkOverlap;
        }
        return chunks;
    }
}
