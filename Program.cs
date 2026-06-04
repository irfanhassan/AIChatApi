using AIChatApi.Models;
using AIChatApi.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddHttpClient();

var apiKey = builder.Configuration["OpenAI:ApiKey"];
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

app.Run();
