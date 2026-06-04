# AIChatApi

ASP.NET Core 10 REST API providing a stateful chat interface backed by OpenAI. Deployed to AWS Fargate via Buildkite CI/CD and AWS CDK.

---

## Architecture Overview

```
Developer pushes code
        │
        ▼
   Buildkite Agent (EC2)
        │
        ├─── Step 1: scripts/build.sh
        │         Build Docker image → push to ECR
        │
        └─── Step 2: CDK deploy (inline in pipeline.yml)
                  Update ECS task definition → rolling restart
                         │
                         ▼
                ECS Fargate Task
             (public IP, port 8080)
                         │
                         ▼
                  OpenAI API (HTTPS)
```

---

## Repository Structure

```
AIChatApi/
├── AIChatApi.csproj          # .NET project
├── Program.cs                # App entry point, DI wiring, all endpoints
├── Dockerfile                # Multi-stage build
├── Services/
│   ├── IAiClient.cs          # AI provider abstraction
│   ├── OpenAiClient.cs       # OpenAI implementation via raw HttpClient
│   └── ChatService.cs        # Conversation state (in-memory)
├── Models/
│   └── ChatModels.cs         # Request/response records
├── scripts/
│   └── build.sh              # CI step 1: build and push Docker image to ECR
└── .buildkite/
    ├── pipeline.yml          # Buildkite pipeline (2 steps)
    ├── bin/
    │   └── buildkite.ts      # CDK app entry point
    ├── lib/
    │   └── stack.ts          # CDK stack: VPC, ECS Fargate, Secrets
    ├── cdk.json              # CDK config (app: node dist/bin/buildkite.js)
    └── tsconfig.json         # TypeScript compiler config (commonjs, outDir: dist)
```

---

## Build Pipeline

Every push triggers the Buildkite pipeline defined in `.buildkite/pipeline.yml`. Two sequential steps run on a self-hosted Buildkite agent (EC2 instance).

### `.buildkite/pipeline.yml`

```yaml
steps:
  - label: ":docker: Build & Push"
    key: build
    command: "bash ${BUILDKITE_BUILD_CHECKOUT_PATH}/scripts/build.sh"

  - label: ":rocket: Deploy to Fargate"
    key: deploy
    depends_on: build
    commands:
      - cd "${BUILDKITE_BUILD_CHECKOUT_PATH}/.buildkite" && npm ci
      - node --max-old-space-size=1024 node_modules/.bin/tsc
      - npx cdk deploy --require-approval never --parameters "ImageTag=${BUILDKITE_COMMIT}" --region ap-southeast-2
```

`depends_on: build` ensures deploy only runs if the build step succeeded. The deploy step is inlined directly — no separate deploy script needed.

---

### Step 1 — `scripts/build.sh`

Builds the Docker image and pushes it to Amazon ECR.

1. **Creates the ECR repository** if it does not already exist.
2. **Authenticates Docker** with ECR using a temporary token from `aws ecr get-login-password`.
3. **Builds the Docker image** from the `Dockerfile`, tagged with both the git commit SHA and `latest`.
4. **Pushes both tags** to ECR.

The commit SHA tag is critical — it lets the deploy step reference exactly the image that was just built rather than a potentially stale `latest`.

| Variable | Source | Purpose |
|---|---|---|
| `BUILDKITE_COMMIT` | Buildkite | Git SHA used as the immutable image tag |
| `BUILDKITE_BUILD_CHECKOUT_PATH` | Buildkite | Absolute path to the checked-out repo on the agent |

---

### Step 2 — CDK Deploy (inline)

Compiles the CDK TypeScript code and deploys the updated stack to AWS.

1. **`npm ci`** — installs exact CDK dependencies from `package-lock.json` for reproducible builds.
2. **`tsc`** — compiles `stack.ts` and `buildkite.ts` to JavaScript in `dist/`. The `--max-old-space-size=1024` cap prevents out-of-memory crashes on the `t3.small` agent.
3. **`cdk deploy`** — compares the desired stack state against what is currently deployed in CloudFormation and applies the diff. Passes `ImageTag=$BUILDKITE_COMMIT` so ECS pulls the exact image from step 1.

`--require-approval never` skips the manual confirmation prompt required for unattended CI execution.

---

### `.buildkite/bin/buildkite.ts` — CDK App Entry Point

Instantiates the stack and pins it to a specific AWS account and region:

```typescript
const app = new cdk.App();
new InfraStack(app, 'InfraStack', {
  env: { account: '847143401367', region: 'ap-southeast-2' },
});
```

Hardcoding account and region prevents accidental cross-account deploys.

---

### `.buildkite/lib/stack.ts` — CDK Infrastructure Stack

Defines all AWS infrastructure. Executed by `cdk deploy` after TypeScript compilation.

**Resources:**

| Resource | Details |
|---|---|
| VPC | Default VPC (looked up, not created) |
| ECS Cluster | Fargate — serverless, no EC2 nodes to manage |
| ECR Repository | Imported by name (`aichatapi`) — not created here to avoid conflicts with `build.sh` |
| Fargate Service | 512 CPU, 1024 MB RAM, 1 task, public IP assigned directly |
| Security Group | Inbound TCP 8080 open to the internet |
| Secrets Manager | `/aichatapi/prod/openai-api-key` injected as `OpenAI__ApiKey` at runtime |

**No load balancer** — the Fargate task is assigned a public IP directly on port 8080. This keeps the setup simple and avoids ALB costs. The trade-off is the IP changes on every task restart.

**Image tag parameter:**

```typescript
const imageTag = new cdk.CfnParameter(this, "ImageTag", {
  type: "String",
  default: "latest",
});
```

Set at deploy time to the git commit SHA, ensuring ECS pulls exactly the image built in step 1.

**Environment variables injected into the container:**

| Variable | Value | Source |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Production` | Hardcoded in stack |
| `OpenAI__Model` | `gpt-4o-mini` | Hardcoded in stack |
| `OpenAI__ApiKey` | *(secret)* | AWS Secrets Manager |

> ASP.NET Core maps `__` in environment variable names to `:` in configuration. So `OpenAI__ApiKey` is read as `OpenAI:ApiKey` inside the app.

---

## API Endpoints

### `GET /`
HTML chat UI — open in a browser to chat directly.

### `POST /api/chat`
Send a message. Omit `conversationId` to start a new conversation.

```json
{
  "message": "Hello",
  "conversationId": "optional-existing-id",
  "systemPrompt": "optional override",
  "temperature": 0.7,
  "topP": 1.0,
  "maxTokens": 500
}
```

Response:
```json
{
  "conversationId": "d8458211-0af8-4d40-ae53-aa4b25228656",
  "reply": "Hello! How can I assist you today?",
  "timestamp": "2026-06-04T07:59:10.959Z"
}
```

### `GET /api/chat/{conversationId}`
Returns the full message history for a conversation.

---

## Prerequisites

Before the pipeline can run for the first time:

**1. Buildkite agent (EC2)**
The agent instance needs: Buildkite agent, Docker, AWS CLI, Node.js, npm. Its IAM role needs permissions for ECR, ECS, CloudFormation, S3, Secrets Manager, IAM, and SSM.

**2. CDK bootstrap** — run once per account/region:
```bash
cdk bootstrap aws://847143401367/ap-southeast-2
```

**3. OpenAI API key in Secrets Manager:**
```bash
aws secretsmanager put-secret-value \
  --secret-id /aichatapi/prod/openai-api-key \
  --secret-string "sk-proj-your-key-here" \
  --region ap-southeast-2
```
> Use `--secret-string` directly or the AWS Console. Do not use `echo` — it appends a newline that corrupts the Authorization header.

---

## Finding the Public IP After Deploy

The Fargate task IP changes on every restart. To find it:

**AWS Console:** ECS → Clusters → select cluster → Tasks tab → click the task → Network section → Public IP.

**AWS CLI:**
```powershell
$eni = aws ecs describe-tasks `
  --cluster <cluster-name> --tasks <task-id> --region ap-southeast-2 `
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" `
  --output text

aws ec2 describe-network-interfaces --network-interface-ids $eni `
  --region ap-southeast-2 `
  --query "NetworkInterfaces[0].Association.PublicIp" --output text
```

Then open `http://<public-ip>:8080` in your browser.
