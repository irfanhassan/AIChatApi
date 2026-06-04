# AIChatApi

ASP.NET Core 10 REST API that provides a stateful chat interface backed by OpenAI. Deployed to AWS Fargate via Buildkite CI/CD and AWS CDK.

---

## Architecture Overview

```
Developer pushes code
        │
        ▼
   Buildkite Agent (EC2)
        │
        ├─── Step 1: build-and-push.sh
        │         Build Docker image → push to ECR
        │
        └─── Step 2: deploy.sh
                  CDK diff + deploy → update ECS Fargate service
                         │
                         ▼
              Application Load Balancer (public)
                         │
                         ▼
                  ECS Fargate Task
                  (AIChatApi container)
                         │
                         ▼
                  OpenAI API (via HTTPS)
```

---

## Repository Structure

```
AIChatApi/
├── AIChatApi.csproj          # .NET project
├── Program.cs                # App entry point, DI wiring
├── Dockerfile                # Multi-stage build
├── Services/
│   ├── IAiClient.cs          # Provider abstraction
│   ├── OpenAiClient.cs       # OpenAI implementation (raw HttpClient)
│   └── ChatService.cs        # Conversation state management
├── Models/
│   └── ChatModels.cs         # Request/response records
├── scripts/
│   ├── build-and-push.sh     # CI step 1: build Docker image and push to ECR
│   └── deploy.sh             # CI step 2: CDK deploy to Fargate
└── .buildkite/
    ├── pipeline.yml          # Buildkite pipeline definition
    ├── bin/
    │   └── buildkite.ts      # CDK app entry point
    ├── lib/
    │   └── stack.ts          # CDK stack: VPC, ECS, ALB, Secrets
    ├── cdk.json              # CDK configuration
    └── tsconfig.json         # TypeScript compiler config
```

---

## Build Pipeline

Every push to the repository triggers the Buildkite pipeline defined in `.buildkite/pipeline.yml`. It runs two sequential steps on a self-hosted Buildkite agent (EC2 instance with Docker and AWS CLI installed).

### pipeline.yml

```yaml
steps:
  - label: ":docker: Build & Push"
    key: build
    command: "bash scripts/build-and-push.sh"

  - label: ":rocket: Deploy to Fargate"
    key: deploy
    depends_on: build
    command: "bash scripts/deploy.sh"
```

The `depends_on: build` ensures the deploy step only runs if the build and push succeeded.

---

### Step 1 — scripts/build-and-push.sh

**Purpose:** Build the Docker image from the `Dockerfile` and push it to Amazon ECR.

**What it does:**

1. **Creates the ECR repository** if it does not already exist.
2. **Authenticates Docker** with ECR using temporary credentials via `aws ecr get-login-password`.
3. **Builds the Docker image** using the checked-out source as the build context. Tags the image with both the git commit SHA (`$BUILDKITE_COMMIT`) and `latest`.
4. **Pushes both tags** to ECR.

The commit SHA tag is important — it lets the deploy step pin the ECS task to exactly the image that was just built, rather than a potentially stale `latest`.

**Key environment variables used:**
| Variable | Source | Purpose |
|---|---|---|
| `BUILDKITE_COMMIT` | Buildkite | Git SHA used as the image tag |
| `BUILDKITE_BUILD_CHECKOUT_PATH` | Buildkite | Path to the checked-out repo on the agent |

---

### Step 2 — scripts/deploy.sh

**Purpose:** Compile the CDK TypeScript code and deploy the updated infrastructure/service to AWS.

**What it does:**

1. **Installs CDK dependencies** with `npm ci` (uses the lockfile for reproducible installs).
2. **Compiles TypeScript** — the CDK stack is written in TypeScript and must be compiled to JavaScript before CDK can run it. Output goes to `dist/`.
3. **Runs `cdk deploy`** — detects what has changed in the CloudFormation stack and applies the update. Passes `ImageTag=$BUILDKITE_COMMIT` so ECS pulls the exact image built in step 1.

The `--require-approval never` flag allows the deploy to proceed without manual confirmation, which is required for unattended CI execution.

---

### .buildkite/bin/buildkite.ts — CDK App Entry Point

This is the top-level CDK application file. It instantiates the `InfraStack` and binds it to a specific AWS account and region:

```typescript
const app = new cdk.App();
new InfraStack(app, 'InfraStack', {
  env: { account: '847143401367', region: 'ap-southeast-2' },
});
```

Hardcoding the account and region (rather than using environment variables) ensures the stack always deploys to the correct target and prevents accidental cross-account deploys.

---

### .buildkite/lib/stack.ts — CDK Infrastructure Stack

This file defines all AWS infrastructure using the AWS CDK. It is compiled and executed by `cdk deploy`.

**Resources created:**

| Resource | Details |
|---|---|
| VPC | 2 Availability Zones, public + private subnets |
| ECS Cluster | Fargate (serverless — no EC2 nodes to manage) |
| ECR Repository | Imported by name (`aichatapi`) — not created here to avoid conflicts with the push step |
| Fargate Service | 512 CPU units, 1024 MB RAM, 1 desired task |
| Application Load Balancer | Public-facing, routes HTTP to the container on port 8080 |
| Secrets Manager reference | Reads `/aichatapi/prod/openai-api-key` and injects it as `OpenAI__ApiKey` environment variable |

**Image tag parameter:**

```typescript
const imageTag = new cdk.CfnParameter(this, "ImageTag", {
  type: "String",
  default: "latest",
});
```

This CloudFormation parameter is set at deploy time by `deploy.sh` to the current git commit SHA. ECS will pull that specific image tag from ECR, ensuring the deployed version exactly matches what was built.

**Environment variables injected into the container:**

| Variable | Value | Source |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Production` | Hardcoded in stack |
| `OpenAI__Model` | `gpt-4o-mini` | Hardcoded in stack |
| `OpenAI__ApiKey` | *(secret value)* | AWS Secrets Manager at runtime |

> **Note:** ASP.NET Core maps double-underscore (`__`) in environment variable names to the colon (`:`) used in `appsettings.json`. So `OpenAI__ApiKey` becomes `OpenAI:ApiKey` inside the app.

**Health check:**

```typescript
service.targetGroup.configureHealthCheck({ path: "/openapi/v1.json" });
```

The ALB checks `/openapi/v1.json` (the OpenAPI spec endpoint) to determine if the container is healthy before routing traffic to it.

---

## API Endpoints

### POST /api/chat

Send a message. Omit `conversationId` to start a new conversation.

**Request:**
```json
{
  "message": "Hello",
  "conversationId": "optional-existing-id",
  "systemPrompt": "optional system prompt",
  "temperature": 0.7,
  "topP": 1.0,
  "maxTokens": 500
}
```

**Response:**
```json
{
  "conversationId": "d8458211-0af8-4d40-ae53-aa4b25228656",
  "reply": "Hello! How can I assist you today?",
  "timestamp": "2026-06-04T07:59:10.959Z"
}
```

### GET /api/chat/{conversationId}

Retrieve the full message history for a conversation.

---

## Infrastructure Prerequisites

Before the pipeline can run, the following must exist:

1. **Buildkite agent** — EC2 instance with the Buildkite agent, Docker, AWS CLI, Node.js, and npm installed. The instance must have an IAM role with permissions for ECR, ECS, CloudFormation, S3, Secrets Manager, IAM, and SSM.

2. **CDK bootstrap** — Run once per account/region:
   ```bash
   cdk bootstrap aws://847143401367/ap-southeast-2
   ```

3. **OpenAI API key in Secrets Manager** — Store the key without a trailing newline:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id /aichatapi/prod/openai-api-key \
     --secret-string "sk-proj-your-key-here" \
     --region ap-southeast-2
   ```
   > **Important:** Do not use `echo` to pipe the key — it appends a newline which will cause authentication failures. Use `--secret-string` directly or the AWS Console.
