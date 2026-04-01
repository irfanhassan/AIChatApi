namespace AIChatApi.Services;

/// <summary>
/// Common message passed to any AI provider.
/// </summary>
public record AiMessage(string Role, string Content);

/// <summary>
/// Provider-agnostic completion options.
/// </summary>
public record AiCompletionOptions(float? Temperature = null, float? TopP = null, int? MaxTokens = null);

/// <summary>
/// Abstraction over any AI chat provider (OpenAI, Claude, Gemini, …).
/// Implement this interface to swap providers without touching ChatService.
/// </summary>
public interface IAiClient
{
    /// <summary>
    /// Sends the full conversation history to the provider and returns the assistant reply.
    /// </summary>
    Task<string> CompleteAsync(IEnumerable<AiMessage> messages, AiCompletionOptions? options = null, CancellationToken cancellationToken = default);
}
