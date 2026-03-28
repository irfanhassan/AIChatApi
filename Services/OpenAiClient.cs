using OpenAI.Chat;

namespace AIChatApi.Services;

public class OpenAiClient(ChatClient chatClient) : IAiClient
{
    public async Task<string> CompleteAsync(IEnumerable<AiMessage> messages, CancellationToken cancellationToken = default)
    {
        var openAiMessages = messages
            .Select<AiMessage, ChatMessage>(m => m.Role == "user"
                ? new UserChatMessage(m.Content)
                : new AssistantChatMessage(m.Content))
            .ToList();

        var completion = await chatClient.CompleteChatAsync(openAiMessages, cancellationToken: cancellationToken);
        return completion.Value.Content[0].Text;
    }
}
