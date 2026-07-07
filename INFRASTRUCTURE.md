# Infrastructure & CI/CD Guide

This document explains how the AIChatApi is built, deployed, and managed on AWS.

---

## Overview

```
Developer pushes code to GitHub
        │
        ▼
Buildkite detects the push
        │
        ▼
EC2 t3.medium (Buildkite Agent)
  ├── Step 1: Build Docker image → push to ECR
  └── Step 2: CDK deploy → update Fargate service
        │
        ▼
ECS Fargate runs the API container
```

---

## AWS Resources

All infrastructure is defined in `infra/stack.ts` using AWS CDK and deployed to `ap-southeast-2` (Sydney).

| Resource | Purpose |
|---|---|
| ECR Repository (`aichatapi`) | Stores Docker images tagged by git commit SHA |
| ECS Fargate Cluster | Runs the API container |
| Fargate Service | 1 task (auto-scales to 4 on CPU load) |
| Secrets Manager | Stores all API keys securely |
| EC2 Auto Scaling Group | Runs the Buildkite CI/CD agent |
| IAM Role (`BuildkiteAgentRole`) | Grants EC2 agent permissions to deploy |

---

## Buildkite Agent (EC2)

The Buildkite agent is an EC2 `t3.medium` instance managed by an Auto Scaling Group (min/max: 1). It polls Buildkite for pipeline jobs and executes them on your AWS infrastructure.

### Why EC2 and not Buildkite hosted agents?
You control the IAM permissions, instance size, and what software is installed. The agent needs AWS credentials to push to ECR and run CDK deploys — this is easier on your own EC2 with an IAM role.

### Why Auto Scaling Group instead of a plain EC2 instance?
If the instance is terminated, the ASG automatically recreates it with the same configuration. No manual intervention needed.

### What runs on the instance (user data script)
When a new instance launches, the following is installed automatically:
1. Docker, Git, Node.js, npm
2. AWS CLI v2
3. AWS CDK (`npm install -g aws-cdk`)
4. Buildkite agent (via official install script)
5. Buildkite agent token fetched from Secrets Manager
6. Buildkite agent registered as a systemd service (survives reboots)

### Agent token
Stored in Secrets Manager at `/aichatapi/buildkite/agent-token`. The user data script fetches it on boot and writes it into the agent config. If you need to rotate it:
1. Go to **Buildkite → Agents → Default cluster → Agent Tokens → New Token**
2. Update Secrets Manager:
```powershell
aws secretsmanager put-secret-value --secret-id /aichatapi/buildkite/agent-token --secret-string "bkct_your_new_token" --region ap-southeast-2
```
3. Terminate the current instance — ASG will launch a new one with the new token.

### Connecting to the instance (no SSH key needed)
Use AWS Systems Manager Session Manager:
```powershell
# Get instance ID
aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" --region ap-southeast-2 --query "Reservations[].Instances[].[InstanceId]" --output text

# Connect
aws ssm start-session --target <instance-id> --region ap-southeast-2
```
Or via AWS Console: **EC2 → Instances → select instance → Connect → Session Manager**.

### Checking agent status on the instance
```bash
sudo systemctl status buildkite-agent
sudo journalctl -u buildkite-agent -n 50 --no-pager
```

---

## CI/CD Pipeline (`buildkite/pipeline.yml`)

Two steps run on every push:

### Step 1 — Build & Push (`infra/build.sh`)
- Logs in to ECR
- Builds the Docker image from `Dockerfile`
- Tags it with the git commit SHA and `latest`
- Pushes both tags to ECR

### Step 2 — Deploy to Fargate
- Runs `npm ci` and `tsc` to compile the CDK stack
- Runs `cdk deploy` with the new image tag as a parameter
- CloudFormation updates the ECS task definition to use the new image
- Fargate performs a rolling deployment (old task stays up until new task is healthy)

---

## Secrets Manager

All secrets are stored in Secrets Manager and injected at runtime — never in code or environment files.

| Secret path | Used by | Purpose |
|---|---|---|
| `/aichatapi/prod/openai-api-key` | Fargate task | OpenAI chat + embeddings |
| `/aichatapi/prod/anthropic-api-key` | Fargate task | Claude RAG answers |
| `/aichatapi/prod/qdrant-url` | Fargate task | Qdrant Cloud endpoint (port 6334) |
| `/aichatapi/prod/qdrant-api-key` | Fargate task | Qdrant Cloud auth |
| `/aichatapi/buildkite/agent-token` | EC2 agent | Buildkite agent registration |

---

## Managing Costs

### Stop everything (EC2 + ECS) to save cost

**Step 1 — Stop the Buildkite agent EC2 instance:**
```powershell
aws autoscaling update-auto-scaling-group `
  --auto-scaling-group-name "InfraStack-BuildkiteAgentAsgASG2C77D4EC-GcWuW3mz5NDh" `
  --min-size 0 --desired-capacity 0 `
  --region ap-southeast-2
```

**Step 2 — Find ECS cluster and service names:**
```powershell
aws ecs list-clusters --region ap-southeast-2
aws ecs list-services --cluster <cluster-arn> --region ap-southeast-2
```

**Step 3 — Stop the Fargate service (scale to 0 tasks):**
```powershell
aws ecs update-service `
  --cluster <cluster-name> `
  --service <service-name> `
  --desired-count 0 `
  --region ap-southeast-2
```

### Restart everything when needed

**Step 1 — Start the Buildkite agent EC2 instance:**
```powershell
aws autoscaling update-auto-scaling-group `
  --auto-scaling-group-name "InfraStack-BuildkiteAgentAsgASG2C77D4EC-GcWuW3mz5NDh" `
  --min-size 1 --desired-capacity 1 `
  --region ap-southeast-2
```

**Step 2 — Start the Fargate service:**
```powershell
aws ecs update-service `
  --cluster <cluster-name> `
  --service <service-name> `
  --desired-count 1 `
  --region ap-southeast-2
```

### Or destroy everything with CDK (cheapest — no ongoing costs at all)
```powershell
cd C:\Source\AIChatApi\infra
npx tsc
npx cdk destroy --region ap-southeast-2
```
To recreate from scratch, follow the **Deploying from scratch** section below.

### Fargate costs
The Fargate task (0.5 vCPU / 1GB) costs ~$0.015/hour. It auto-scales up to 4 tasks under load and scales back down.

---

## Deploying from scratch

If the entire stack is deleted or you're setting up a new environment:

### 1. Store secrets in Secrets Manager
```powershell
aws secretsmanager create-secret --name /aichatapi/prod/openai-api-key --secret-string "sk-..." --region ap-southeast-2
aws secretsmanager create-secret --name /aichatapi/prod/anthropic-api-key --secret-string "sk-ant-..." --region ap-southeast-2
aws secretsmanager create-secret --name /aichatapi/prod/qdrant-url --secret-string "https://your-cluster.qdrant.io:6334" --region ap-southeast-2
aws secretsmanager create-secret --name /aichatapi/prod/qdrant-api-key --secret-string "your-qdrant-key" --region ap-southeast-2
aws secretsmanager create-secret --name /aichatapi/buildkite/agent-token --secret-string "bkct_your-buildkite-token" --region ap-southeast-2
```

### 2. Create ECR repository
```powershell
aws ecr create-repository --repository-name aichatapi --region ap-southeast-2
```

### 3. Bootstrap CDK (once per account/region)
```powershell
cd infra
npx cdk bootstrap aws://847143401367/ap-southeast-2
```

### 4. Deploy the stack
```powershell
npm ci
npx tsc
npx cdk deploy --region ap-southeast-2
```

### 5. Push an initial Docker image
```powershell
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 847143401367.dkr.ecr.ap-southeast-2.amazonaws.com
docker build -t 847143401367.dkr.ecr.ap-southeast-2.amazonaws.com/aichatapi:latest .
docker push 847143401367.dkr.ecr.ap-southeast-2.amazonaws.com/aichatapi:latest
```

### 6. Wait for Buildkite agent to connect
After `cdk deploy`, the EC2 instance boots and runs the user data script (~3-4 minutes). Once complete, the agent appears in **Buildkite → Agents**. Trigger a build from there.

---

## Troubleshooting

### Build stuck "Waiting for agent"
The Buildkite agent is not connected. Check:
1. Is the EC2 instance running? `aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" --region ap-southeast-2`
2. Connect via SSM and check: `sudo systemctl status buildkite-agent`
3. If not installed, the user data may have failed: `sudo tail -100 /var/log/cloud-init-output.log`

### Agent loses connection during build
Usually caused by CPU credit exhaustion on burstable instances. The instance is t3.medium which has more credits, but if it happens again upgrade to `t3.large` in `stack.ts`.

### "Invalid access token" error
The Buildkite token in Secrets Manager is wrong or expired. Create a new token in Buildkite and update Secrets Manager (see Agent token section above).

### Fargate task not starting
Check ECS logs: **AWS Console → ECS → Clusters → select cluster → Tasks → select task → Logs**. Usually caused by missing secrets in Secrets Manager or wrong image tag in ECR.
