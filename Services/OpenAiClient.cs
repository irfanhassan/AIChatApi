using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace AIChatApi.Services;

public class OpenAiClient(IHttpClientFactory httpClientFactory, string apiKey, string model) : IAiClient
{
    public async Task<string> CompleteAsync(IEnumerable<AiMessage> messages, AiCompletionOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new Dictionary<string, object>
        {
            ["model"] = model,
            ["messages"] = messages.Select(m => new { role = m.Role, content = m.Content }).ToArray()
        };

        if (options?.Temperature is not null) body["temperature"] = options.Temperature;
        if (options?.TopP is not null)         body["top_p"]       = options.TopP;
        if (options?.MaxTokens is not null)    body["max_tokens"]  = options.MaxTokens;

        var json = JsonSerializer.Serialize(body);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");

        var http = httpClientFactory.CreateClient();
        var response = await http.SendAsync(request, cancellationToken);
        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"OpenAI error {(int)response.StatusCode}: {responseJson}");

        using var doc = JsonDocument.Parse(responseJson);
        return doc.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString() ?? string.Empty;
    }
}
