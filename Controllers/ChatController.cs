using AIChatApi.Models;
using AIChatApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace AIChatApi.Controllers;

[ApiController]
[Route("api/chat")]
public class ChatController(IChatService chatService) : ControllerBase
{
    [HttpPost]
    [EndpointName("SendMessage")]
    [EndpointSummary("Send a message; omit conversationId to start a new conversation.")]
    public async Task<IActionResult> SendMessage([FromBody] ChatRequest request)
    {
        var response = await chatService.SendAsync(request);
        return Ok(response);
    }

    [HttpGet("{conversationId}")]
    [EndpointName("GetHistory")]
    [EndpointSummary("Get the full message history for a conversation.")]
    public IActionResult GetHistory(string conversationId)
    {
        var conversation = chatService.GetConversation(conversationId);
        if (conversation is null)
            return NotFound();

        return Ok(conversation.History.Select(m => new { m.Role, m.Content }));
    }
}
