using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace AIChatApi.Services;

public class EmbeddingService(IHttpClientFactory httpClientFactory, string apiKey)
{
    private const string Model = "text-embedding-3-small";
    private const int Dimensions = 1536;

    public async Task<float[]> EmbedAsync(string text, CancellationToken cancellationToken = default)
    {
        var results = await EmbedBatchAsync([text], cancellationToken);
        return results[0];
    }

    public async Task<List<float[]>> EmbedBatchAsync(IEnumerable<string> texts, CancellationToken cancellationToken = default)
    {
        var body = JsonSerializer.Serialize(new { model = Model, input = texts, dimensions = Dimensions });
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/embeddings");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var http = httpClientFactory.CreateClient();
        var response = await http.SendAsync(request, cancellationToken);
        var json = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"OpenAI embeddings error {(int)response.StatusCode}: {json}");

        using var doc = JsonDocument.Parse(json);
        return doc.RootElement
            .GetProperty("data")
            .EnumerateArray()
            .OrderBy(e => e.GetProperty("index").GetInt32())
            .Select(e => e.GetProperty("embedding").EnumerateArray().Select(v => v.GetSingle()).ToArray())
            .ToList();
    }
}
