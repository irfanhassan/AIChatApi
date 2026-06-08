using System.Collections.Concurrent;
using AIChatApi.Models;

namespace AIChatApi.Services;

public class VectorStore
{
    private record ChunkRecord(Guid Id, Guid DocumentId, int ChunkIndex, string Content, float[] Embedding);
    private record DocumentRecord(Guid Id, string FileName, DateTime UploadedAt);

    private readonly ConcurrentDictionary<Guid, DocumentRecord> _documents = new();
    private readonly ConcurrentBag<ChunkRecord> _chunks = new();

    public Guid AddDocument(string fileName)
    {
        var id = Guid.NewGuid();
        _documents[id] = new DocumentRecord(id, fileName, DateTime.UtcNow);
        return id;
    }

    public void AddChunk(Guid documentId, int chunkIndex, string content, float[] embedding) =>
        _chunks.Add(new ChunkRecord(Guid.NewGuid(), documentId, chunkIndex, content, embedding));

    public List<string> Search(float[] queryEmbedding, int topK) =>
        _chunks
            .Select(c => (c.Content, Score: CosineSimilarity(c.Embedding, queryEmbedding)))
            .OrderByDescending(x => x.Score)
            .Take(topK)
            .Select(x => x.Content)
            .ToList();

    public List<DocumentSummary> ListDocuments() =>
        _documents.Values
            .Select(d => new DocumentSummary(d.Id, d.FileName, d.UploadedAt,
                _chunks.Count(c => c.DocumentId == d.Id)))
            .OrderByDescending(d => d.UploadedAt)
            .ToList();

    public bool DeleteDocument(Guid id)
    {
        if (!_documents.TryRemove(id, out _)) return false;
        foreach (var chunk in _chunks.Where(c => c.DocumentId == id).ToList())
            _chunks.TryTake(out _);
        return true;
    }

    private static float CosineSimilarity(float[] a, float[] b)
    {
        var dot = 0f; var normA = 0f; var normB = 0f;
        for (var i = 0; i < a.Length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
        return normA == 0 || normB == 0 ? 0 : dot / (MathF.Sqrt(normA) * MathF.Sqrt(normB));
    }
}
