using Anthropic.SDK;
using Anthropic.SDK.Constants;
using Anthropic.SDK.Messaging;

namespace AIChatApi.Services;

public class AnthropicAiClient(AnthropicClient client) : IAiClient
{
    public async Task<string> CompleteAsync(IEnumerable<AiMessage> messages, AiCompletionOptions? options = null, CancellationToken cancellationToken = default)
    {
        var anthropicMessages = messages
            .Where(m => m.Role != "system")
            .Select(m => new Message
            {
                Role = m.Role == "assistant" ? RoleType.Assistant : RoleType.User,
                Content = [new TextContent { Text = m.Content }]
            })
            .ToList();

        var systemPrompt = messages.FirstOrDefault(m => m.Role == "system")?.Content;

        var parameters = new MessageParameters
        {
            Model = AnthropicModels.Claude46Sonnet,
            MaxTokens = options?.MaxTokens ?? 1024,
            Messages = anthropicMessages,
        };

        if (!string.IsNullOrWhiteSpace(systemPrompt))
            parameters.System = [new SystemMessage(systemPrompt)];

        if (options?.Temperature is not null)
            parameters.Temperature = (decimal)options.Temperature;

        var response = await client.Messages.GetClaudeMessageAsync(parameters, cancellationToken);
        return response.Content.OfType<TextContent>().FirstOrDefault()?.Text ?? "";
    }
}
