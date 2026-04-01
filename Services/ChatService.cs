using AIChatApi.Models;
using System.Collections.Concurrent;

namespace AIChatApi.Services;

public class ChatService(IAiClient aiClient, IConfiguration config) : IChatService
{
    private readonly ConcurrentDictionary<string, Conversation> _conversations = new();

    public async Task<ChatResponse> SendAsync(ChatRequest request)
    {
        var conversation = request.ConversationId is not null
            && _conversations.TryGetValue(request.ConversationId, out var existing)
                ? existing
                : CreateConversation();

        conversation.History.Add(("user", request.Message));

        // Build message list, prepending system prompt when present
        var systemPrompt = request.SystemPrompt ?? config["OpenAI:SystemPrompt"];
        var allMessages = new List<AiMessage>();
        if (!string.IsNullOrWhiteSpace(systemPrompt))
            allMessages.Add(new AiMessage("system", systemPrompt));
        allMessages.AddRange(conversation.History.Select(m => new AiMessage(m.Role, m.Content)));

        // Merge per-request overrides with config defaults
        var temperature = request.Temperature
            ?? (float.TryParse(config["OpenAI:Temperature"], out var t) ? t : (float?)null);
        var topP = request.TopP
            ?? (float.TryParse(config["OpenAI:TopP"], out var p) ? p : (float?)null);
        var maxTokens = request.MaxTokens
            ?? (int.TryParse(config["OpenAI:MaxTokens"], out var m) ? m : (int?)null);

        var reply = await aiClient.CompleteAsync(allMessages, new AiCompletionOptions(temperature, topP, maxTokens));

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
