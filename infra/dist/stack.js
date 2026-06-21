"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfraStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecr = require("aws-cdk-lib/aws-ecr");
const ecs = require("aws-cdk-lib/aws-ecs");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
const iam = require("aws-cdk-lib/aws-iam");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
class InfraStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const repo = ecr.Repository.fromRepositoryName(this, "AIChatApiRepo", "aichatapi");
        const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
        const cluster = new ecs.Cluster(this, "Cluster", { vpc });
        const openAiSecret = secretsmanager.Secret.fromSecretNameV2(this, "OpenAiSecret", "/aichatapi/prod/openai-api-key");
        const anthropicSecret = secretsmanager.Secret.fromSecretNameV2(this, "AnthropicSecret", "/aichatapi/prod/anthropic-api-key");
        const qdrantUrlSecret = secretsmanager.Secret.fromSecretNameV2(this, "QdrantUrlSecret", "/aichatapi/prod/qdrant-url");
        const qdrantKeySecret = secretsmanager.Secret.fromSecretNameV2(this, "QdrantKeySecret", "/aichatapi/prod/qdrant-api-key");
        const imageTag = new cdk.CfnParameter(this, "ImageTag", {
            type: "String",
            default: "latest",
        });
        const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
            cpu: 512,
            memoryLimitMiB: 1024,
        });
        taskDef.addContainer("web", {
            image: ecs.ContainerImage.fromEcrRepository(repo, imageTag.valueAsString),
            portMappings: [{ containerPort: 8080 }],
            environment: {
                ASPNETCORE_ENVIRONMENT: "Production",
                OpenAI__Model: "gpt-4o-mini",
            },
            secrets: {
                OpenAI__ApiKey: ecs.Secret.fromSecretsManager(openAiSecret),
                Anthropic__ApiKey: ecs.Secret.fromSecretsManager(anthropicSecret),
                Qdrant__Url: ecs.Secret.fromSecretsManager(qdrantUrlSecret),
                Qdrant__ApiKey: ecs.Secret.fromSecretsManager(qdrantKeySecret),
            },
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: "aichatapi" }),
        });
        const sg = new ec2.SecurityGroup(this, "Sg", { vpc });
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080));
        const service = new ecs.FargateService(this, "Service", {
            cluster,
            taskDefinition: taskDef,
            desiredCount: 1,
            assignPublicIp: true,
            securityGroups: [sg],
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });
        const scaling = service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 });
        scaling.scaleOnCpuUtilization("CpuScaling", { targetUtilizationPercent: 70 });
        // Buildkite agent EC2 instance
        const buildkiteAgentToken = secretsmanager.Secret.fromSecretNameV2(this, "BuildkiteAgentToken", "/aichatapi/buildkite/agent-token");
        const agentRole = new iam.Role(this, "BuildkiteAgentRole", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryFullAccess"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonECS_FullAccess"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMReadOnlyAccess"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSCloudFormationFullAccess"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("IAMFullAccess"),
            ],
        });
        buildkiteAgentToken.grantRead(agentRole);
        const agentSg = new ec2.SecurityGroup(this, "BuildkiteAgentSg", {
            vpc,
            description: "Buildkite agent - outbound only",
        });
        const userData = ec2.UserData.forLinux();
        userData.addCommands("set -euo pipefail", 
        // Install Docker
        "dnf install -y docker", "systemctl enable --now docker", "usermod -aG docker ec2-user", 
        // Install AWS CLI v2
        'curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip', "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install", 
        // Install Node.js (for CDK deploy step)
        "dnf install -y nodejs npm", "npm install -g aws-cdk", 
        // Install Buildkite agent
        'curl -fsSL "https://keys.openpgp.org/vks/v1/by-fingerprint/32A37959C2FA5C3C99EFBC32A79206696452D198" | gpg --dearmor -o /usr/share/keyrings/buildkite-agent-archive-keyring.gpg', 'echo "deb [signed-by=/usr/share/keyrings/buildkite-agent-archive-keyring.gpg] https://apt.buildkite.com/buildkite-agent stable main" > /etc/yum.repos.d/buildkite-agent.repo', "dnf install -y buildkite-agent", 
        // Configure agent token from Secrets Manager
        `TOKEN=$(aws secretsmanager get-secret-value --secret-id /aichatapi/buildkite/agent-token --region ap-southeast-2 --query SecretString --output text)`, `sed -i "s/xxx/$TOKEN/" /etc/buildkite-agent/buildkite-agent.cfg`, "systemctl enable --now buildkite-agent");
        new autoscaling.AutoScalingGroup(this, "BuildkiteAgentAsg", {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            role: agentRole,
            securityGroup: agentSg,
            userData,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            minCapacity: 1,
            maxCapacity: 1,
            updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
        });
    }
}
exports.InfraStack = InfraStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELDJDQUEyQztBQUMzQyxpRUFBaUU7QUFFakUsTUFBYSxVQUFXLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsVUFBVSxDQUFDLGtCQUFrQixDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFFbkYsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBRXhFLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUUxRCxNQUFNLFlBQVksR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUN6RCxJQUFJLEVBQ0osY0FBYyxFQUNkLGdDQUFnQyxDQUNqQyxDQUFDO1FBRUYsTUFBTSxlQUFlLEdBQUcsY0FBYyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FDNUQsSUFBSSxFQUNKLGlCQUFpQixFQUNqQixtQ0FBbUMsQ0FDcEMsQ0FBQztRQUVGLE1BQU0sZUFBZSxHQUFHLGNBQWMsQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQzVELElBQUksRUFDSixpQkFBaUIsRUFDakIsNEJBQTRCLENBQzdCLENBQUM7UUFFRixNQUFNLGVBQWUsR0FBRyxj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QUMsYUFBYSxDQUFDLEVBQUUsRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQztZQUMvRSxZQUFZLEVBQUUsR0FBRyxDQUFDLFlBQVksQ0FBQyxxQkFBcUIsRUFBRTtZQUN0RCxJQUFJLEVBQUUsU0FBUztZQUNmLGFBQWEsRUFBRSxPQUFPO1lBQ3RCLFFBQVE7WUFDUixVQUFVLEVBQUUsRUFBRSxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNLEVBQUU7WUFDakQsV0FBVyxFQUFFLENBQUM7WUFDZCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxXQUFXLENBQUMsWUFBWSxDQUFDLGFBQWEsRUFBRTtTQUN2RCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUF6SUQsZ0NBeUlDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIGVjMiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjMlwiO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWNyXCI7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1lY3NcIjtcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXV0b3NjYWxpbmdcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlclwiO1xuXG5leHBvcnQgY2xhc3MgSW5mcmFTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IHJlcG8gPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUodGhpcywgXCJBSUNoYXRBcGlSZXBvXCIsIFwiYWljaGF0YXBpXCIpO1xuXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tTG9va3VwKHRoaXMsIFwiRGVmYXVsdFZwY1wiLCB7IGlzRGVmYXVsdDogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgXCJDbHVzdGVyXCIsIHsgdnBjIH0pO1xuXG4gICAgY29uc3Qgb3BlbkFpU2VjcmV0ID0gc2VjcmV0c21hbmFnZXIuU2VjcmV0LmZyb21TZWNyZXROYW1lVjIoXG4gICAgICB0aGlzLFxuICAgICAgXCJPcGVuQWlTZWNyZXRcIixcbiAgICAgIFwiL2FpY2hhdGFwaS9wcm9kL29wZW5haS1hcGkta2V5XCJcbiAgICApO1xuXG4gICAgY29uc3QgYW50aHJvcGljU2VjcmV0ID0gc2VjcmV0c21hbmFnZXIuU2VjcmV0LmZyb21TZWNyZXROYW1lVjIoXG4gICAgICB0aGlzLFxuICAgICAgXCJBbnRocm9waWNTZWNyZXRcIixcbiAgICAgIFwiL2FpY2hhdGFwaS9wcm9kL2FudGhyb3BpYy1hcGkta2V5XCJcbiAgICApO1xuXG4gICAgY29uc3QgcWRyYW50VXJsU2VjcmV0ID0gc2VjcmV0c21hbmFnZXIuU2VjcmV0LmZyb21TZWNyZXROYW1lVjIoXG4gICAgICB0aGlzLFxuICAgICAgXCJRZHJhbnRVcmxTZWNyZXRcIixcbiAgICAgIFwiL2FpY2hhdGFwaS9wcm9kL3FkcmFudC11cmxcIlxuICAgICk7XG5cbiAgICBjb25zdCBxZHJhbnRLZXlTZWNyZXQgPSBzZWNyZXRzbWFuYWdlci5TZWNyZXQuZnJvbVNlY3JldE5hbWVWMihcbiAgICAgIHRoaXMsXG4gICAgICBcIlFkcmFudEtleVNlY3JldFwiLFxuICAgICAgXCIvYWljaGF0YXBpL3Byb2QvcWRyYW50LWFwaS1rZXlcIlxuICAgICk7XG5cbiAgICBjb25zdCBpbWFnZVRhZyA9IG5ldyBjZGsuQ2ZuUGFyYW1ldGVyKHRoaXMsIFwiSW1hZ2VUYWdcIiwge1xuICAgICAgdHlwZTogXCJTdHJpbmdcIixcbiAgICAgIGRlZmF1bHQ6IFwibGF0ZXN0XCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCB0YXNrRGVmID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgXCJUYXNrRGVmXCIsIHtcbiAgICAgIGNwdTogNTEyLFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDEwMjQsXG4gICAgfSk7XG5cbiAgICB0YXNrRGVmLmFkZENvbnRhaW5lcihcIndlYlwiLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHJlcG8sIGltYWdlVGFnLnZhbHVlQXNTdHJpbmcpLFxuICAgICAgcG9ydE1hcHBpbmdzOiBbeyBjb250YWluZXJQb3J0OiA4MDgwIH1dLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQVNQTkVUQ09SRV9FTlZJUk9OTUVOVDogXCJQcm9kdWN0aW9uXCIsXG4gICAgICAgIE9wZW5BSV9fTW9kZWw6IFwiZ3B0LTRvLW1pbmlcIixcbiAgICAgIH0sXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIE9wZW5BSV9fQXBpS2V5OiAgICBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihvcGVuQWlTZWNyZXQpLFxuICAgICAgICBBbnRocm9waWNfX0FwaUtleTogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIoYW50aHJvcGljU2VjcmV0KSxcbiAgICAgICAgUWRyYW50X19Vcmw6ICAgICAgIGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHFkcmFudFVybFNlY3JldCksXG4gICAgICAgIFFkcmFudF9fQXBpS2V5OiAgICBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihxZHJhbnRLZXlTZWNyZXQpLFxuICAgICAgfSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3MoeyBzdHJlYW1QcmVmaXg6IFwiYWljaGF0YXBpXCIgfSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCBcIlNnXCIsIHsgdnBjIH0pO1xuICAgIHNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDgwODApKTtcblxuICAgIGNvbnN0IHNlcnZpY2UgPSBuZXcgZWNzLkZhcmdhdGVTZXJ2aWNlKHRoaXMsIFwiU2VydmljZVwiLCB7XG4gICAgICBjbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb246IHRhc2tEZWYsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBhc3NpZ25QdWJsaWNJcDogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbc2ddLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNjYWxpbmcgPSBzZXJ2aWNlLmF1dG9TY2FsZVRhc2tDb3VudCh7IG1pbkNhcGFjaXR5OiAxLCBtYXhDYXBhY2l0eTogNCB9KTtcbiAgICBzY2FsaW5nLnNjYWxlT25DcHVVdGlsaXphdGlvbihcIkNwdVNjYWxpbmdcIiwgeyB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDcwIH0pO1xuXG4gICAgLy8gQnVpbGRraXRlIGFnZW50IEVDMiBpbnN0YW5jZVxuICAgIGNvbnN0IGJ1aWxka2l0ZUFnZW50VG9rZW4gPSBzZWNyZXRzbWFuYWdlci5TZWNyZXQuZnJvbVNlY3JldE5hbWVWMihcbiAgICAgIHRoaXMsXG4gICAgICBcIkJ1aWxka2l0ZUFnZW50VG9rZW5cIixcbiAgICAgIFwiL2FpY2hhdGFwaS9idWlsZGtpdGUvYWdlbnQtdG9rZW5cIlxuICAgICk7XG5cbiAgICBjb25zdCBhZ2VudFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJCdWlsZGtpdGVBZ2VudFJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJlYzIuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBbWF6b25FQzJDb250YWluZXJSZWdpc3RyeUZ1bGxBY2Nlc3NcIiksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFtYXpvbkVDU19GdWxsQWNjZXNzXCIpLFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBbWF6b25TM0Z1bGxBY2Nlc3NcIiksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFtYXpvblNTTVJlYWRPbmx5QWNjZXNzXCIpLFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBV1NDbG91ZEZvcm1hdGlvbkZ1bGxBY2Nlc3NcIiksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIklBTUZ1bGxBY2Nlc3NcIiksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgYnVpbGRraXRlQWdlbnRUb2tlbi5ncmFudFJlYWQoYWdlbnRSb2xlKTtcblxuICAgIGNvbnN0IGFnZW50U2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgXCJCdWlsZGtpdGVBZ2VudFNnXCIsIHtcbiAgICAgIHZwYyxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkJ1aWxka2l0ZSBhZ2VudCAtIG91dGJvdW5kIG9ubHlcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHVzZXJEYXRhID0gZWMyLlVzZXJEYXRhLmZvckxpbnV4KCk7XG4gICAgdXNlckRhdGEuYWRkQ29tbWFuZHMoXG4gICAgICBcInNldCAtZXVvIHBpcGVmYWlsXCIsXG4gICAgICAvLyBJbnN0YWxsIERvY2tlclxuICAgICAgXCJkbmYgaW5zdGFsbCAteSBkb2NrZXJcIixcbiAgICAgIFwic3lzdGVtY3RsIGVuYWJsZSAtLW5vdyBkb2NrZXJcIixcbiAgICAgIFwidXNlcm1vZCAtYUcgZG9ja2VyIGVjMi11c2VyXCIsXG4gICAgICAvLyBJbnN0YWxsIEFXUyBDTEkgdjJcbiAgICAgICdjdXJsIC1mc1NMIFwiaHR0cHM6Ly9hd3NjbGkuYW1hem9uYXdzLmNvbS9hd3NjbGktZXhlLWxpbnV4LXg4Nl82NC56aXBcIiAtbyAvdG1wL2F3c2NsaXYyLnppcCcsXG4gICAgICBcInVuemlwIC1xIC90bXAvYXdzY2xpdjIuemlwIC1kIC90bXAgJiYgL3RtcC9hd3MvaW5zdGFsbFwiLFxuICAgICAgLy8gSW5zdGFsbCBOb2RlLmpzIChmb3IgQ0RLIGRlcGxveSBzdGVwKVxuICAgICAgXCJkbmYgaW5zdGFsbCAteSBub2RlanMgbnBtXCIsXG4gICAgICBcIm5wbSBpbnN0YWxsIC1nIGF3cy1jZGtcIixcbiAgICAgIC8vIEluc3RhbGwgQnVpbGRraXRlIGFnZW50XG4gICAgICAnY3VybCAtZnNTTCBcImh0dHBzOi8va2V5cy5vcGVucGdwLm9yZy92a3MvdjEvYnktZmluZ2VycHJpbnQvMzJBMzc5NTlDMkZBNUMzQzk5RUZCQzMyQTc5MjA2Njk2NDUyRDE5OFwiIHwgZ3BnIC0tZGVhcm1vciAtbyAvdXNyL3NoYXJlL2tleXJpbmdzL2J1aWxka2l0ZS1hZ2VudC1hcmNoaXZlLWtleXJpbmcuZ3BnJyxcbiAgICAgICdlY2hvIFwiZGViIFtzaWduZWQtYnk9L3Vzci9zaGFyZS9rZXlyaW5ncy9idWlsZGtpdGUtYWdlbnQtYXJjaGl2ZS1rZXlyaW5nLmdwZ10gaHR0cHM6Ly9hcHQuYnVpbGRraXRlLmNvbS9idWlsZGtpdGUtYWdlbnQgc3RhYmxlIG1haW5cIiA+IC9ldGMveXVtLnJlcG9zLmQvYnVpbGRraXRlLWFnZW50LnJlcG8nLFxuICAgICAgXCJkbmYgaW5zdGFsbCAteSBidWlsZGtpdGUtYWdlbnRcIixcbiAgICAgIC8vIENvbmZpZ3VyZSBhZ2VudCB0b2tlbiBmcm9tIFNlY3JldHMgTWFuYWdlclxuICAgICAgYFRPS0VOPSQoYXdzIHNlY3JldHNtYW5hZ2VyIGdldC1zZWNyZXQtdmFsdWUgLS1zZWNyZXQtaWQgL2FpY2hhdGFwaS9idWlsZGtpdGUvYWdlbnQtdG9rZW4gLS1yZWdpb24gYXAtc291dGhlYXN0LTIgLS1xdWVyeSBTZWNyZXRTdHJpbmcgLS1vdXRwdXQgdGV4dClgLFxuICAgICAgYHNlZCAtaSBcInMveHh4LyRUT0tFTi9cIiAvZXRjL2J1aWxka2l0ZS1hZ2VudC9idWlsZGtpdGUtYWdlbnQuY2ZnYCxcbiAgICAgIFwic3lzdGVtY3RsIGVuYWJsZSAtLW5vdyBidWlsZGtpdGUtYWdlbnRcIlxuICAgICk7XG5cbiAgICBuZXcgYXV0b3NjYWxpbmcuQXV0b1NjYWxpbmdHcm91cCh0aGlzLCBcIkJ1aWxka2l0ZUFnZW50QXNnXCIsIHtcbiAgICAgIHZwYyxcbiAgICAgIGluc3RhbmNlVHlwZTogZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5UMywgZWMyLkluc3RhbmNlU2l6ZS5NSUNSTyksXG4gICAgICBtYWNoaW5lSW1hZ2U6IGVjMi5NYWNoaW5lSW1hZ2UubGF0ZXN0QW1hem9uTGludXgyMDIzKCksXG4gICAgICByb2xlOiBhZ2VudFJvbGUsXG4gICAgICBzZWN1cml0eUdyb3VwOiBhZ2VudFNnLFxuICAgICAgdXNlckRhdGEsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyB9LFxuICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICBtYXhDYXBhY2l0eTogMSxcbiAgICAgIHVwZGF0ZVBvbGljeTogYXV0b3NjYWxpbmcuVXBkYXRlUG9saWN5LnJvbGxpbmdVcGRhdGUoKSxcbiAgICB9KTtcbiAgfVxufVxuIl19