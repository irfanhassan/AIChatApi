namespace AIChatApi.Models;

public record UploadDocumentResponse(Guid DocumentId, string FileName, int ChunkCount);
public record DocumentSummary(Guid Id, string FileName, DateTime UploadedAt, int ChunkCount);
public record RagQueryRequest(string Question, int TopK = 5);
public record RagQueryResponse(string Answer, List<string> Sources);
