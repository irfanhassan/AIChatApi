using AIChatApi.Models;

namespace AIChatApi.Services;

public interface IChatService
{
    Task<ChatResponse> SendAsync(ChatRequest request);
    Conversation? GetConversation(string id);
}
