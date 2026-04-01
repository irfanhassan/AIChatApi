namespace AIChatApi.Models;

public record ChatRequest(
    string Message,
    string? ConversationId = null,
    string? SystemPrompt = null,
    float? Temperature = null,
    float? TopP = null,
    int? MaxTokens = null);

public record ChatResponse(string ConversationId, string Reply, DateTime Timestamp);

public class Conversation
{
    public string Id { get; init; } = Guid.NewGuid().ToString();
    public List<(string Role, string Content)> History { get; } = [];
}
