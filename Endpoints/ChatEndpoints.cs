using AIChatApi.Models;
using AIChatApi.Services;

namespace AIChatApi.Endpoints;

public static class ChatEndpoints
{
    public static IEndpointRouteBuilder MapChatEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/chat");

        group.MapPost("/", async (ChatRequest request, IChatService chatService) =>
        {
            var response = await chatService.SendAsync(request);
            return Results.Ok(response);
        })
        .WithName("SendMessage")
        .WithSummary("Send a message; omit conversationId to start a new conversation.");

        group.MapGet("/{conversationId}", (string conversationId, IChatService chatService) =>
        {
            var conversation = chatService.GetConversation(conversationId);
            return conversation is null
                ? Results.NotFound()
                : Results.Ok(conversation.History.Select(m => new { m.Role, m.Content }));
        })
        .WithName("GetHistory")
        .WithSummary("Get the full message history for a conversation.");

        return app;
    }
}
