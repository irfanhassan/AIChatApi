using AIChatApi.Models;
using System.Collections.Concurrent;

namespace AIChatApi.Services;

public class ChatService(IAiClient aiClient) : IChatService
{
    private readonly ConcurrentDictionary<string, Conversation> _conversations = new();

    public async Task<ChatResponse> SendAsync(ChatRequest request)
    {
        var conversation = request.ConversationId is not null
            && _conversations.TryGetValue(request.ConversationId, out var existing)
                ? existing
                : CreateConversation();

        conversation.History.Add(("user", request.Message));

        var messages = conversation.History
            .Select(m => new AiMessage(m.Role, m.Content));

        var reply = await aiClient.CompleteAsync(messages);

        conversation.History.Add(("assistant", reply));

        return new ChatResponse(conversation.Id, reply, DateTime.UtcNow);
    }

    public Conversation? GetConversation(string id) =>
        _conversations.GetValueOrDefault(id);

    private Conversation CreateConversation()
    {
        var c = new Conversation();
        _conversations[c.Id] = c;
        return c;
    }
}
