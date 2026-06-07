using AIChatApi.Data;
using AIChatApi.Models;
using AIChatApi.Services;
using Anthropic.SDK;

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

var anthropicKey = builder.Configuration["Anthropic:ApiKey"]?.Trim();
if (string.IsNullOrWhiteSpace(anthropicKey))
    throw new InvalidOperationException("Anthropic:ApiKey is not configured.");

var connectionString = builder.Configuration.GetConnectionString("Postgres")!;
builder.Services.AddSingleton(new DbConnectionFactory(connectionString));
builder.Services.AddSingleton(sp =>
    new EmbeddingService(sp.GetRequiredService<IHttpClientFactory>(), apiKey));
builder.Services.AddSingleton(new AnthropicClient(anthropicKey));
builder.Services.AddScoped<RagService>();

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

app.MapPost("/api/documents", async (IFormFile file, RagService rag) =>
{
    if (file.Length == 0) return Results.BadRequest("Empty file.");
    using var stream = file.OpenReadStream();
    var result = await rag.IngestAsync(stream, file.FileName);
    return Results.Ok(result);
})
.WithName("UploadDocument")
.WithSummary("Upload a PDF to the RAG knowledge base.")
.DisableAntiforgery();

app.MapGet("/api/documents", async (RagService rag) =>
    Results.Ok(await rag.ListDocumentsAsync()))
.WithName("ListDocuments")
.WithSummary("List all uploaded documents.");

app.MapDelete("/api/documents/{id:guid}", async (Guid id, RagService rag) =>
    await rag.DeleteDocumentAsync(id) ? Results.NoContent() : Results.NotFound())
.WithName("DeleteDocument")
.WithSummary("Delete a document and all its chunks.");

app.MapPost("/api/rag/query", async (RagQueryRequest request, RagService rag) =>
    Results.Ok(await rag.QueryAsync(request.Question, request.TopK)))
.WithName("RagQuery")
.WithSummary("Ask a question against the uploaded documents.");

app.MapGet("/rag", () => Results.Content("""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>RAG</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; justify-content: center; padding: 32px 16px; }
    #app { width: 100%; max-width: 800px; display: flex; flex-direction: column; gap: 24px; }
    h1 { font-size: 1.4rem; color: #111; }
    h2 { font-size: 1rem; color: #444; margin-bottom: 12px; }
    .card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .drop-zone { border: 2px dashed #ccc; border-radius: 8px; padding: 32px; text-align: center; cursor: pointer; color: #888; transition: border-color 0.2s; }
    .drop-zone.dragover { border-color: #0084ff; color: #0084ff; }
    .drop-zone input { display: none; }
    .btn { padding: 10px 20px; background: #0084ff; color: white; border: none; border-radius: 8px; font-size: 0.95rem; cursor: pointer; }
    .btn:disabled { background: #aaa; cursor: default; }
    .btn-danger { background: #e00; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #eee; color: #666; }
    td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
    .query-row { display: flex; gap: 8px; }
    #question { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 1rem; outline: none; }
    #question:focus { border-color: #0084ff; }
    #answer { margin-top: 16px; padding: 16px; background: #f8f9fa; border-radius: 8px; white-space: pre-wrap; line-height: 1.6; display: none; }
    #sources { margin-top: 12px; display: none; }
    .source { margin-top: 8px; padding: 10px; background: #fff3cd; border-radius: 6px; font-size: 0.85rem; color: #555; white-space: pre-wrap; }
    .status { font-size: 0.85rem; color: #888; margin-top: 8px; }
    .error { color: #c00; }
  </style>
</head>
<body>
  <div id="app">
    <h1>RAG — Document Q&amp;A</h1>

    <div class="card">
      <h2>Upload PDF</h2>
      <div class="drop-zone" id="dropZone">
        <input type="file" id="fileInput" accept=".pdf"/>
        Drag &amp; drop a PDF here, or <strong>click to browse</strong>
      </div>
      <div class="status" id="uploadStatus"></div>
    </div>

    <div class="card">
      <h2>Documents</h2>
      <table>
        <thead><tr><th>File</th><th>Uploaded</th><th>Chunks</th><th></th></tr></thead>
        <tbody id="docList"><tr><td colspan="4" style="color:#aaa">Loading...</td></tr></tbody>
      </table>
    </div>

    <div class="card">
      <h2>Ask a Question</h2>
      <div class="query-row">
        <input id="question" placeholder="What is this document about?" />
        <button class="btn" id="askBtn" onclick="ask()">Ask</button>
      </div>
      <div id="answer"></div>
      <div id="sources"></div>
    </div>
  </div>

  <script>
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const uploadStatus = document.getElementById('uploadStatus');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); uploadFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => uploadFile(fileInput.files[0]));

    async function uploadFile(file) {
      if (!file) return;
      uploadStatus.textContent = `Uploading ${file.name}...`;
      uploadStatus.className = 'status';
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/api/documents', { method: 'POST', body: form });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        uploadStatus.textContent = `✓ Uploaded — ${data.chunkCount} chunks indexed.`;
        loadDocs();
      } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
        uploadStatus.className = 'status error';
      }
    }

    async function loadDocs() {
      const res = await fetch('/api/documents');
      const docs = await res.json();
      const tbody = document.getElementById('docList');
      if (docs.length === 0) { tbody.innerHTML = '<tr><td colspan="4" style="color:#aaa">No documents uploaded yet.</td></tr>'; return; }
      tbody.innerHTML = docs.map(d => `
        <tr>
          <td>${d.fileName}</td>
          <td>${new Date(d.uploadedAt).toLocaleString()}</td>
          <td>${d.chunkCount}</td>
          <td><button class="btn btn-danger" onclick="deleteDoc('${d.id}')">Delete</button></td>
        </tr>`).join('');
    }

    async function deleteDoc(id) {
      await fetch('/api/documents/' + id, { method: 'DELETE' });
      loadDocs();
    }

    async function ask() {
      const question = document.getElementById('question').value.trim();
      if (!question) return;
      const btn = document.getElementById('askBtn');
      const answerEl = document.getElementById('answer');
      const sourcesEl = document.getElementById('sources');
      btn.disabled = true;
      answerEl.style.display = 'block';
      answerEl.textContent = 'Thinking...';
      sourcesEl.style.display = 'none';
      try {
        const res = await fetch('/api/rag/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, topK: 5 })
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        answerEl.textContent = data.answer;
        sourcesEl.style.display = 'block';
        sourcesEl.innerHTML = '<strong style="font-size:0.85rem;color:#666">Sources</strong>' +
          data.sources.map(s => `<div class="source">${s.substring(0, 300)}${s.length > 300 ? '…' : ''}</div>`).join('');
      } catch (err) {
        answerEl.textContent = 'Error: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }

    loadDocs();
  </script>
</body>
</html>
""", "text/html"));

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
