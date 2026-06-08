using AIChatApi.Models;
using Anthropic.SDK;
using Anthropic.SDK.Constants;
using Anthropic.SDK.Messaging;
using UglyToad.PdfPig;

namespace AIChatApi.Services;

public class RagService(VectorStore store, EmbeddingService embeddingService, AnthropicClient anthropic)
{
    private const int ChunkSize = 500;
    private const int ChunkOverlap = 50;

    public async Task<UploadDocumentResponse> IngestAsync(Stream pdfStream, string fileName, CancellationToken cancellationToken = default)
    {
        var text = ExtractText(pdfStream);
        var chunks = ChunkText(text);
        var embeddings = await embeddingService.EmbedBatchAsync(chunks, cancellationToken);

        var documentId = store.AddDocument(fileName);
        for (var i = 0; i < chunks.Count; i++)
            store.AddChunk(documentId, i, chunks[i], embeddings[i]);

        return new UploadDocumentResponse(documentId, fileName, chunks.Count);
    }

    public async Task<RagQueryResponse> QueryAsync(string question, int topK = 5, CancellationToken cancellationToken = default)
    {
        var queryEmbedding = await embeddingService.EmbedAsync(question, cancellationToken);
        var chunks = store.Search(queryEmbedding, topK);

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

    public List<DocumentSummary> ListDocuments() => store.ListDocuments();

    public bool DeleteDocument(Guid id) => store.DeleteDocument(id);

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
