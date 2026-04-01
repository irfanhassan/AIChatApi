using OpenAI.Chat;

namespace AIChatApi.Services;

public class OpenAiClient(ChatClient chatClient) : IAiClient
{
    public async Task<string> CompleteAsync(IEnumerable<AiMessage> messages, AiCompletionOptions? options = null, CancellationToken cancellationToken = default)
    {
        var openAiMessages = messages
            .Select<AiMessage, ChatMessage>(m => m.Role switch
            {
                "system"    => new SystemChatMessage(m.Content),
                "assistant" => new AssistantChatMessage(m.Content),
                _           => new UserChatMessage(m.Content)
            })
            .ToList();

        ChatCompletionOptions? chatOptions = null;
        if (options is { Temperature: not null } or { TopP: not null } or { MaxTokens: not null })
        {
            chatOptions = new ChatCompletionOptions();
            if (options.Temperature is not null) chatOptions.Temperature       = options.Temperature;
            if (options.TopP is not null)         chatOptions.TopP              = options.TopP;
            if (options.MaxTokens is not null)    chatOptions.MaxOutputTokenCount = options.MaxTokens;
        }

        var completion = await chatClient.CompleteChatAsync(openAiMessages, chatOptions, cancellationToken);
        return completion.Value.Content[0].Text;
    }
}
