using AIChatApi.Models;
using UglyToad.PdfPig;

namespace AIChatApi.Services;

public class RagService(VectorStore store, EmbeddingService embeddingService, IAiClient aiClient)
{
    private const int ChunkSize = 500;
    private const int ChunkOverlap = 50;

    public async Task<UploadDocumentResponse> IngestAsync(Stream pdfStream, string fileName, CancellationToken cancellationToken = default)
    {
        var text = ExtractText(pdfStream);
        var chunks = ChunkText(text);
        var embeddings = await embeddingService.EmbedBatchAsync(chunks, cancellationToken);

        var documentId = await store.AddDocumentAsync(fileName, cancellationToken);
        await store.AddChunksAsync(documentId, chunks, embeddings, cancellationToken);

        return new UploadDocumentResponse(documentId, fileName, chunks.Count);
    }

    public async Task<RagQueryResponse> QueryAsync(string question, int topK = 5, CancellationToken cancellationToken = default)
    {
        var queryEmbedding = await embeddingService.EmbedAsync(question, cancellationToken);
        var chunks = await store.SearchAsync(queryEmbedding, topK, cancellationToken);

        if (chunks.Count == 0)
            return new RagQueryResponse("No relevant documents found.", []);

        var context = string.Join("\n\n---\n\n", chunks);
        var messages = new[]
        {
            new AiMessage("system", $"Answer the question using only the context below. If the answer is not in the context, say so.\n\nContext:\n{context}"),
            new AiMessage("user", question)
        };

        var answer = await aiClient.CompleteAsync(messages, cancellationToken: cancellationToken);
        return new RagQueryResponse(answer, chunks);
    }

    public List<DocumentSummary> ListDocuments() => store.ListDocuments();

    public async Task<bool> DeleteDocumentAsync(Guid id, CancellationToken ct = default) =>
        await store.DeleteDocumentAsync(id, ct);

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
