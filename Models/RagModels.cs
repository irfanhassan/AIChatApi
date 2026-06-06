namespace AIChatApi.Models;

public class Document
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string FileName { get; set; } = "";
    public DateTime UploadedAt { get; init; } = DateTime.UtcNow;
    public List<DocumentChunk> Chunks { get; init; } = [];
}

public class DocumentChunk
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public Guid DocumentId { get; set; }
    public Document Document { get; set; } = null!;
    public int ChunkIndex { get; set; }
    public string Content { get; set; } = "";
    public Pgvector.Vector Embedding { get; set; } = null!;
}

public record UploadDocumentResponse(Guid DocumentId, string FileName, int ChunkCount);
public record DocumentSummary(Guid Id, string FileName, DateTime UploadedAt, int ChunkCount);
public record RagQueryRequest(string Question, int TopK = 5);
public record RagQueryResponse(string Answer, List<string> Sources);
