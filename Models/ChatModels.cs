namespace AIChatApi.Models;

public record ChatRequest(string Message, string? ConversationId = null);

public record ChatResponse(string ConversationId, string Reply, DateTime Timestamp);

public class Conversation
{
    public string Id { get; init; } = Guid.NewGuid().ToString();
    public List<(string Role, string Content)> History { get; } = [];
}
