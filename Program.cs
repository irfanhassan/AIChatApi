using AIChatApi.Models;
using AIChatApi.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddHttpClient();

var apiKey = builder.Configuration["OpenAI:ApiKey"]?.Trim();
if (string.IsNullOrWhiteSpace(apiKey))
    throw new InvalidOperationException("OpenAI:ApiKey is not configured.");

var model = builder.Configuration["OpenAI:Model"];
if (string.IsNullOrWhiteSpace(model))
    model = "gpt-4o-mini";

builder.Services.AddSingleton<IAiClient>(sp =>
    new OpenAiClient(sp.GetRequiredService<IHttpClientFactory>(), apiKey, model));
builder.Services.AddSingleton<IChatService, ChatService>();

var app = builder.Build();

app.MapOpenApi();
app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "AIChatApi v1"));

app.MapPost("/api/chat", async (ChatRequest request, IChatService chatService) =>
{
    var response = await chatService.SendAsync(request);
    return Results.Ok(response);
})
.WithName("SendMessage")
.WithSummary("Send a message; omit conversationId to start a new conversation.");

app.MapGet("/api/chat/{conversationId}", (string conversationId, IChatService chatService) =>
{
    var conversation = chatService.GetConversation(conversationId);
    if (conversation is null)
        return Results.NotFound();

    return Results.Ok(conversation.History.Select(m => new { m.Role, m.Content }));
})
.WithName("GetHistory")
.WithSummary("Get the full message history for a conversation.");

app.MapGet("/", () => Results.Content("""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>AI Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; }
    #app { background: white; width: 100%; max-width: 720px; height: 90vh; display: flex; flex-direction: column; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); overflow: hidden; }
    #messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .msg.user { background: #0084ff; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
    .msg.ai { background: #f0f2f5; color: #111; align-self: flex-start; border-bottom-left-radius: 4px; }
    .msg.error { background: #ffe0e0; color: #c00; align-self: center; font-size: 0.85rem; }
    #form { display: flex; gap: 8px; padding: 16px; border-top: 1px solid #eee; }
    #input { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 24px; font-size: 1rem; outline: none; }
    #input:focus { border-color: #0084ff; }
    #send { padding: 10px 20px; background: #0084ff; color: white; border: none; border-radius: 24px; font-size: 1rem; cursor: pointer; }
    #send:disabled { background: #aaa; cursor: default; }
  </style>
</head>
<body>
  <div id="app">
    <div id="messages"></div>
    <form id="form">
      <input id="input" placeholder="Type a message..." autocomplete="off"/>
      <button id="send" type="submit">Send</button>
    </form>
  </div>
  <script>
    let conversationId = null;
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');

    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    document.getElementById('form').addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send.disabled = true;
      addMessage('user', text);
      const thinking = addMessage('ai', '...');
      try {
        const body = { message: text };
        if (conversationId) body.conversationId = conversationId;
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('Server error ' + res.status);
        const data = await res.json();
        conversationId = data.conversationId;
        thinking.textContent = data.reply;
      } catch (err) {
        thinking.className = 'msg error';
        thinking.textContent = err.message;
      } finally {
        send.disabled = false;
        input.focus();
      }
    });
  </script>
</body>
</html>
""", "text/html"));

app.Run();
