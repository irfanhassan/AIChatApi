using AIChatApi.Services;
using OpenAI.Chat;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddControllers();

var apiKey = builder.Configuration["OpenAI:ApiKey"]
    ?? throw new InvalidOperationException("OpenAI:ApiKey is not configured.");

// To swap providers, replace OpenAiClient with another IAiClient implementation.
builder.Services.AddSingleton(new ChatClient(
    model: builder.Configuration["OpenAI:Model"] ?? "gpt-4o-mini",
    apiKey: apiKey));

builder.Services.AddSingleton<IAiClient, OpenAiClient>();
builder.Services.AddSingleton<IChatService, ChatService>();

var app = builder.Build();

app.MapOpenApi();
app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "AIChatApi v1"));

app.MapControllers();

app.Run();
