using System.Collections.Concurrent;
using AIChatApi.Models;
using Qdrant.Client;
using Qdrant.Client.Grpc;

namespace AIChatApi.Services;

public class VectorStore
{
    private const string Collection = "chunks";
    private const ulong VectorSize = 1536;

    private readonly QdrantClient _client;
    private readonly ConcurrentDictionary<Guid, (string FileName, DateTime UploadedAt)> _documents = new();

    public VectorStore(QdrantClient client)
    {
        _client = client;
        EnsureCollectionAsync().GetAwaiter().GetResult();
    }

    public async Task<Guid> AddDocumentAsync(string fileName, CancellationToken ct = default)
    {
        var id = Guid.NewGuid();
        _documents[id] = (fileName, DateTime.UtcNow);
        return await Task.FromResult(id);
    }

    public async Task AddChunksAsync(Guid documentId, List<string> contents, List<float[]> embeddings, CancellationToken ct = default)
    {
        var points = contents.Select((content, i) => new PointStruct
        {
            Id = Guid.NewGuid(),
            Vectors = embeddings[i],
            Payload =
            {
                ["document_id"] = documentId.ToString(),
                ["chunk_index"]  = i,
                ["content"]      = content,
            }
        }).ToList();

        await _client.UpsertAsync(Collection, points, cancellationToken: ct);
    }

    public async Task<List<string>> SearchAsync(float[] queryEmbedding, int topK, CancellationToken ct = default)
    {
        var results = await _client.SearchAsync(Collection, queryEmbedding, limit: (ulong)topK, cancellationToken: ct);
        return results.Select(r => r.Payload["content"].StringValue).ToList();
    }

    public List<DocumentSummary> ListDocuments() =>
        _documents.Select(kv => new DocumentSummary(kv.Key, kv.Value.FileName, kv.Value.UploadedAt, 0))
                  .OrderByDescending(d => d.UploadedAt)
                  .ToList();

    public async Task<bool> DeleteDocumentAsync(Guid id, CancellationToken ct = default)
    {
        if (!_documents.TryRemove(id, out _)) return false;

        await _client.DeleteAsync(Collection,
            new Filter { Must = { new Condition { Field = new FieldCondition {
                Key = "document_id",
                Match = new Match { Text = id.ToString() }
            }}}},
            cancellationToken: ct);

        return true;
    }

    private async Task EnsureCollectionAsync()
    {
        var collections = await _client.ListCollectionsAsync();
        if (collections.Any(c => c == Collection)) return;

        await _client.CreateCollectionAsync(Collection,
            new VectorParams { Size = VectorSize, Distance = Distance.Cosine });
    }
}
