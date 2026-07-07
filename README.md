# AIChatApi

An ASP.NET Core 10 API with two features built on a shared AI provider abstraction:

- **Chat** — stateful multi-turn conversations powered by OpenAI GPT-4o-mini
- **RAG** — upload PDFs, ask questions, get answers grounded in document content using Claude

---

## Architecture

### Shared AI abstraction

Both features depend on `IAiClient` — a single interface that decouples the application from any specific AI provider:

```
IAiClient
    ├── OpenAiClient      → GPT-4o-mini  (used by Chat)
    └── AnthropicAiClient → Claude       (used by RAG)
```

Swapping providers requires no changes to `ChatService` or `RagService`.

### Chat flow

```
POST /api/chat
      │
      ▼
ChatService
  - looks up or creates conversation
  - maintains full history in memory
      │
      ▼
OpenAiClient → OpenAI /v1/chat/completions
      │
      ▼
reply stored in history, returned to caller
```

### RAG flow

```
POST /api/documents (PDF upload)
      │
      ├── PdfPig extracts text
      ├── text split into 500-word chunks (50-word overlap)
      ├── OpenAI text-embedding-3-small → 1536-dim vectors
      └── Qdrant Cloud stores vectors + chunk text

POST /api/rag/query
      │
      ├── question embedded via OpenAI text-embedding-3-small
      ├── Qdrant cosine similarity search → top 5 chunks
      └── AnthropicAiClient → Claude answers from chunks only
```

**Why two AI providers?**
OpenAI is used for embeddings — Anthropic has no embedding model. Claude is used for answer generation because it follows grounding instructions more strictly, reducing hallucination beyond the source material.

---

## How RAG works — Chunking, Embedding, and Vector DB explained

### Chunking

A PDF can be hundreds of pages long. Sending the entire document to an AI model on every question is expensive and often exceeds the model's context window. Instead the text is split into small, overlapping **chunks** of 500 words with a 50-word overlap (`RagService.ChunkText`):

```
[ word 1 ........... word 500 ]
                 [ word 451 ........... word 950 ]
                                  [ word 901 ........... word 1400 ]
```

The 50-word overlap ensures that a sentence that falls on a boundary is not cut off — it appears in full in at least one of the two adjacent chunks.

### Embedding

Each chunk is converted into a **vector** — an array of 1536 numbers — by sending it to OpenAI's `text-embedding-3-small` model (`EmbeddingService`). A vector captures the *semantic meaning* of the text, not just the words:

```
"The refund window is 30 days"   → [0.12, -0.41, 0.88, ...]   (1536 numbers)
"Returns are accepted within a month" → [0.13, -0.40, 0.86, ...] (very similar)
"How to make pizza"              → [-0.71, 0.22, -0.33, ...]  (very different)
```

Two pieces of text that mean the same thing produce vectors that are mathematically close to each other, even if they use completely different words. This is what makes semantic search possible — you are matching *meaning*, not keywords.

### Vector Database (Qdrant)

The vectors and their original chunk text are stored in **Qdrant Cloud** (`VectorStore`). Each stored item (called a **point**) contains:
- The 1536-number vector
- The original chunk text as a payload field
- The document ID and chunk index

When you ask a question (`POST /api/rag/query`):

1. The question is converted into a vector using the same embedding model
2. Qdrant compares the question vector against all stored vectors using **cosine similarity** — a measure of how similar two vectors are (1.0 = identical meaning, 0.0 = unrelated)
3. The top 5 most similar chunks are returned
4. Those chunks are passed to Claude as context, and Claude answers using only that content

This means the answer is always grounded in your actual documents, not in the model's general training data.

---

## Project structure

```
AIChatApi/
├── Program.cs                   # Endpoints and DI wiring
├── AIChatApi.csproj             # Package references
├── Dockerfile                   # Multi-stage build
├── appsettings.json             # Config keys (values via secrets or env vars)
│
├── Models/
│   ├── ChatModels.cs            # ChatRequest, ChatResponse, Conversation
│   └── RagModels.cs            # UploadDocumentResponse, RagQueryRequest/Response
│
├── Services/
│   ├── IAiClient.cs             # Provider abstraction (AiMessage, AiCompletionOptions)
│   ├── OpenAiClient.cs          # IAiClient → OpenAI chat completions (raw HttpClient)
│   ├── AnthropicAiClient.cs     # IAiClient → Claude via Anthropic.SDK
│   ├── IChatService.cs          # Chat service abstraction
│   ├── ChatService.cs           # Conversation state + delegates to IAiClient
│   ├── EmbeddingService.cs      # OpenAI /v1/embeddings (batched)
│   ├── VectorStore.cs           # Qdrant: create collection, upsert, search, delete
│   └── RagService.cs            # PDF ingestion + question answering
│
├── infra/
│   ├── build.sh                 # CI step 1: Docker build and push to ECR
│   ├── stack.ts                 # CDK: Fargate, security group, Secrets Manager refs
│   ├── bin/app.ts               # CDK app entry point
│   ├── cdk.json                 # CDK config (app: node dist/bin/app.js)
│   ├── package.json             # CDK dependencies
│   └── tsconfig.json            # TypeScript config (commonjs, outDir: dist)
│
└── buildkite/
    └── pipeline.yml             # Two-step pipeline: build then deploy
```

---

## API endpoints

### Chat

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Browser chat UI |
| `POST` | `/api/chat` | Send a message, receive a reply |
| `GET` | `/api/chat/{conversationId}` | Get full conversation history |

**POST /api/chat**
```json
{
  "message": "What is the capital of France?",
  "conversationId": "omit to start a new conversation",
  "systemPrompt": "optional override",
  "temperature": 0.7,
  "topP": 1.0,
  "maxTokens": 500
}
```

### RAG

| Method | Path | Description |
|---|---|---|
| `GET` | `/rag` | Browser RAG UI — upload and query |
| `POST` | `/api/documents` | Upload a PDF (`multipart/form-data`) |
| `GET` | `/api/documents` | List uploaded documents |
| `DELETE` | `/api/documents/{id}` | Delete a document and its vectors |
| `POST` | `/api/rag/query` | Ask a question against uploaded documents |

**POST /api/rag/query**
```json
{
  "question": "What is the refund policy?",
  "topK": 5
}
```

---

## Running locally

### Prerequisites
- .NET 10 SDK
- OpenAI API key — [platform.openai.com](https://platform.openai.com)
- Anthropic API key — [console.anthropic.com](https://console.anthropic.com)
- Qdrant Cloud cluster — free at [cloud.qdrant.io](https://cloud.qdrant.io)

### Setup

```powershell
cd AIChatApi

dotnet user-secrets set "OpenAI:ApiKey"   "sk-..."
dotnet user-secrets set "Anthropic:ApiKey" "sk-ant-..."
dotnet user-secrets set "Qdrant:Url"      "https://your-cluster.qdrant.io:6334"
dotnet user-secrets set "Qdrant:ApiKey"   "your-qdrant-key"

dotnet run
```

- Chat UI: `http://localhost:5000`
- RAG UI: `http://localhost:5000/rag`

---

## Deployment (AWS Fargate)

Every push triggers the Buildkite pipeline defined in `buildkite/pipeline.yml`.

### Step 1 — `infra/build.sh`
Builds the Docker image, tags it with the git commit SHA, and pushes to Amazon ECR.

### Step 2 — CDK deploy (inline)
Compiles `infra/stack.ts` and runs `cdk deploy`, updating the ECS task definition to the new image tag.

### Infrastructure (`infra/stack.ts`)
- Default VPC, ECS Fargate cluster
- Single Fargate task (512 CPU / 1024 MB), public IP assigned directly — no load balancer
- Port 8080 open to the internet via security group
- Secrets injected from AWS Secrets Manager at runtime:

| Secret path | Env var | Purpose |
|---|---|---|
| `/aichatapi/prod/openai-api-key` | `OpenAI__ApiKey` | Chat + embeddings |
| `/aichatapi/prod/anthropic-api-key` | `Anthropic__ApiKey` | RAG answer generation |

> ASP.NET Core maps `__` in env var names to `:` in config, so `OpenAI__ApiKey` is read as `OpenAI:ApiKey`.

### First-time setup

```bash
# Bootstrap CDK once per account/region
cdk bootstrap aws://847143401367/ap-southeast-2

# Store secrets (use --secret-string directly, not echo — avoids trailing newline)
aws secretsmanager create-secret --name /aichatapi/prod/openai-api-key \
  --secret-string "sk-..." --region ap-southeast-2

aws secretsmanager create-secret --name /aichatapi/prod/anthropic-api-key \
  --secret-string "sk-ant-..." --region ap-southeast-2
```

### Finding the public IP

The Fargate task IP changes on every restart. Find it in the AWS Console:
**ECS → Clusters → select cluster → Tasks → click task → Network → Public IP**

Then open `http://<ip>:8080` or `http://<ip>:8080/rag`.

---

## Design decisions

**`IAiClient` abstraction** — both Chat and RAG go through the same interface. Adding a new provider (Bedrock, Gemini) means implementing one interface and changing one DI registration.

**No load balancer** — direct public IP on the Fargate task saves ~$20/month. Trade-off: IP changes on task restart.

**Qdrant Cloud free tier** — 1GB free, persistent across restarts. In production, RDS pgvector or Aurora pgvector would keep everything inside AWS with no third-party dependency.

**In-memory conversation history** — lost on container restart. For production, persist to DynamoDB or Redis.

**Raw HttpClient for OpenAI** — the OpenAI .NET SDK v2.9.1 had a bug where the model name was not serialised into requests when `ChatCompletionOptions` was null. Replaced with direct HTTP calls.

---

## Buildkite Agent (EC2)

The Buildkite agent is an EC2 instance that polls Buildkite for pipeline jobs and executes them on your own AWS infrastructure. It is defined in CDK (`infra/stack.ts`) as an **Auto Scaling Group** with min/max of 1 instance so it is automatically recreated if terminated.

### IAM permissions on the agent

| Policy | Why |
|---|---|
| `AmazonEC2ContainerRegistryFullAccess` | Push Docker images to ECR |
| `AmazonECS_FullAccess` | Update Fargate service during deploy |
| `AWSCloudFormationFullAccess` | CDK deploy uses CloudFormation |
| `IAMFullAccess` | CDK manages IAM roles for the task definition |
| `AmazonS3FullAccess` | CDK bootstrap bucket |
| `AmazonSSMReadOnlyAccess` | Read SSM parameters during deploy |

### Managing the agent instance

```powershell
# Stop (saves compute cost, EBS still billed)
aws ec2 stop-instances --instance-ids <instance-id> --region ap-southeast-2

# Recreate from scratch after terminating
cd infra
npm ci
npx tsc
npx cdk deploy --region ap-southeast-2
```

The Buildkite agent token is stored in Secrets Manager at `/aichatapi/buildkite/agent-token` and fetched at instance boot via the user data script.
