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
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
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
        userData.addCommands("set -euo pipefail", "export HOME=/root", 
        // Install core tools
        "dnf install -y docker git unzip nodejs npm", "systemctl enable --now docker", 
        // Install AWS CLI v2
        'curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip', "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install", 
        // Install CDK
        "npm install -g aws-cdk", 
        // Install Buildkite agent as root
        'curl -fsSL "https://raw.githubusercontent.com/buildkite/agent/main/install.sh" | bash', 
        // Configure agent token from Secrets Manager
        "TOKEN=$(aws secretsmanager get-secret-value --secret-id /aichatapi/buildkite/agent-token --region ap-southeast-2 --query SecretString --output text)", 'sed -i "s|token=\\"xxx\\"|token=\\"$TOKEN\\"|" /root/.buildkite-agent/buildkite-agent.cfg', 
        // Create systemd service running as root so it has docker access
        `cat > /etc/systemd/system/buildkite-agent.service << 'EOF'
[Unit]
Description=Buildkite Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
Environment=HOME=/root
ExecStart=/root/.buildkite-agent/bin/buildkite-agent start --config /root/.buildkite-agent/buildkite-agent.cfg
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF`, "systemctl daemon-reload", "systemctl enable --now buildkite-agent");
        new autoscaling.AutoScalingGroup(this, "BuildkiteAgentAsg", {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELDJDQUEyQztBQUMzQyxpRUFBaUU7QUFFakUsTUFBYSxVQUFXLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsVUFBVSxDQUFDLGtCQUFrQixDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFFbkYsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBRXhFLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUUxRCxNQUFNLFlBQVksR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUN6RCxJQUFJLEVBQ0osY0FBYyxFQUNkLGdDQUFnQyxDQUNqQyxDQUFDO1FBRUYsTUFBTSxlQUFlLEdBQUcsY0FBYyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FDNUQsSUFBSSxFQUNKLGlCQUFpQixFQUNqQixtQ0FBbUMsQ0FDcEMsQ0FBQztRQUVGLE1BQU0sZUFBZSxHQUFHLGNBQWMsQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQzVELElBQUksRUFDSixpQkFBaUIsRUFDakIsNEJBQTRCLENBQzdCLENBQUM7UUFFRixNQUFNLGVBQWUsR0FBRyxj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QzFELEdBQUc7WUFDSCxZQUFZLEVBQUUsR0FBRyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUM7WUFDaEYsWUFBWSxFQUFFLEdBQUcsQ0FBQyxZQUFZLENBQUMscUJBQXFCLEVBQUU7WUFDdEQsSUFBSSxFQUFFLFNBQVM7WUFDZixhQUFhLEVBQUUsT0FBTztZQUN0QixRQUFRO1lBQ1IsVUFBVSxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTSxFQUFFO1lBQ2pELFdBQVcsRUFBRSxDQUFDO1lBQ2QsV0FBVyxFQUFFLENBQUM7WUFDZCxZQUFZLEVBQUUsV0FBVyxDQUFDLFlBQVksQ0FBQyxhQUFhLEVBQUU7U0FDdkQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBMUpELGdDQTBKQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1lYzJcIjtcbmltcG9ydCAqIGFzIGVjciBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjclwiO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWNzXCI7XG5pbXBvcnQgKiBhcyBhdXRvc2NhbGluZyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWF1dG9zY2FsaW5nXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXJcIjtcblxuZXhwb3J0IGNsYXNzIEluZnJhU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCByZXBvID0gZWNyLlJlcG9zaXRvcnkuZnJvbVJlcG9zaXRvcnlOYW1lKHRoaXMsIFwiQUlDaGF0QXBpUmVwb1wiLCBcImFpY2hhdGFwaVwiKTtcblxuICAgIGNvbnN0IHZwYyA9IGVjMi5WcGMuZnJvbUxvb2t1cCh0aGlzLCBcIkRlZmF1bHRWcGNcIiwgeyBpc0RlZmF1bHQ6IHRydWUgfSk7XG5cbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsIFwiQ2x1c3RlclwiLCB7IHZwYyB9KTtcblxuICAgIGNvbnN0IG9wZW5BaVNlY3JldCA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKFxuICAgICAgdGhpcyxcbiAgICAgIFwiT3BlbkFpU2VjcmV0XCIsXG4gICAgICBcIi9haWNoYXRhcGkvcHJvZC9vcGVuYWktYXBpLWtleVwiXG4gICAgKTtcblxuICAgIGNvbnN0IGFudGhyb3BpY1NlY3JldCA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKFxuICAgICAgdGhpcyxcbiAgICAgIFwiQW50aHJvcGljU2VjcmV0XCIsXG4gICAgICBcIi9haWNoYXRhcGkvcHJvZC9hbnRocm9waWMtYXBpLWtleVwiXG4gICAgKTtcblxuICAgIGNvbnN0IHFkcmFudFVybFNlY3JldCA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKFxuICAgICAgdGhpcyxcbiAgICAgIFwiUWRyYW50VXJsU2VjcmV0XCIsXG4gICAgICBcIi9haWNoYXRhcGkvcHJvZC9xZHJhbnQtdXJsXCJcbiAgICApO1xuXG4gICAgY29uc3QgcWRyYW50S2V5U2VjcmV0ID0gc2VjcmV0c21hbmFnZXIuU2VjcmV0LmZyb21TZWNyZXROYW1lVjIoXG4gICAgICB0aGlzLFxuICAgICAgXCJRZHJhbnRLZXlTZWNyZXRcIixcbiAgICAgIFwiL2FpY2hhdGFwaS9wcm9kL3FkcmFudC1hcGkta2V5XCJcbiAgICApO1xuXG4gICAgY29uc3QgaW1hZ2VUYWcgPSBuZXcgY2RrLkNmblBhcmFtZXRlcih0aGlzLCBcIkltYWdlVGFnXCIsIHtcbiAgICAgIHR5cGU6IFwiU3RyaW5nXCIsXG4gICAgICBkZWZhdWx0OiBcImxhdGVzdFwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgdGFza0RlZiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsIFwiVGFza0RlZlwiLCB7XG4gICAgICBjcHU6IDUxMixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAxMDI0LFxuICAgIH0pO1xuXG4gICAgdGFza0RlZi5hZGRDb250YWluZXIoXCJ3ZWJcIiwge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRWNyUmVwb3NpdG9yeShyZXBvLCBpbWFnZVRhZy52YWx1ZUFzU3RyaW5nKSxcbiAgICAgIHBvcnRNYXBwaW5nczogW3sgY29udGFpbmVyUG9ydDogODA4MCB9XSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFTUE5FVENPUkVfRU5WSVJPTk1FTlQ6IFwiUHJvZHVjdGlvblwiLFxuICAgICAgICBPcGVuQUlfX01vZGVsOiBcImdwdC00by1taW5pXCIsXG4gICAgICB9LFxuICAgICAgc2VjcmV0czoge1xuICAgICAgICBPcGVuQUlfX0FwaUtleTogICAgZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIob3BlbkFpU2VjcmV0KSxcbiAgICAgICAgQW50aHJvcGljX19BcGlLZXk6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKGFudGhyb3BpY1NlY3JldCksXG4gICAgICAgIFFkcmFudF9fVXJsOiAgICAgICBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihxZHJhbnRVcmxTZWNyZXQpLFxuICAgICAgICBRZHJhbnRfX0FwaUtleTogICAgZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIocWRyYW50S2V5U2VjcmV0KSxcbiAgICAgIH0sXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHsgc3RyZWFtUHJlZml4OiBcImFpY2hhdGFwaVwiIH0pLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgXCJTZ1wiLCB7IHZwYyB9KTtcbiAgICBzZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5hbnlJcHY0KCksIGVjMi5Qb3J0LnRjcCg4MDgwKSk7XG5cbiAgICBjb25zdCBzZXJ2aWNlID0gbmV3IGVjcy5GYXJnYXRlU2VydmljZSh0aGlzLCBcIlNlcnZpY2VcIiwge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgYXNzaWduUHVibGljSXA6IHRydWUsXG4gICAgICBzZWN1cml0eUdyb3VwczogW3NnXSxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2FsaW5nID0gc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoeyBtaW5DYXBhY2l0eTogMSwgbWF4Q2FwYWNpdHk6IDQgfSk7XG4gICAgc2NhbGluZy5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oXCJDcHVTY2FsaW5nXCIsIHsgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiA3MCB9KTtcblxuICAgIC8vIEJ1aWxka2l0ZSBhZ2VudCBFQzIgaW5zdGFuY2VcbiAgICBjb25zdCBidWlsZGtpdGVBZ2VudFRva2VuID0gc2VjcmV0c21hbmFnZXIuU2VjcmV0LmZyb21TZWNyZXROYW1lVjIoXG4gICAgICB0aGlzLFxuICAgICAgXCJCdWlsZGtpdGVBZ2VudFRva2VuXCIsXG4gICAgICBcIi9haWNoYXRhcGkvYnVpbGRraXRlL2FnZW50LXRva2VuXCJcbiAgICApO1xuXG4gICAgY29uc3QgYWdlbnRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiQnVpbGRraXRlQWdlbnRSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiZWMyLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQW1hem9uRUMyQ29udGFpbmVyUmVnaXN0cnlGdWxsQWNjZXNzXCIpLFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBbWF6b25FQ1NfRnVsbEFjY2Vzc1wiKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQW1hem9uUzNGdWxsQWNjZXNzXCIpLFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBbWF6b25TU01SZWFkT25seUFjY2Vzc1wiKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZVwiKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQVdTQ2xvdWRGb3JtYXRpb25GdWxsQWNjZXNzXCIpLFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJJQU1GdWxsQWNjZXNzXCIpLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGJ1aWxka2l0ZUFnZW50VG9rZW4uZ3JhbnRSZWFkKGFnZW50Um9sZSk7XG5cbiAgICBjb25zdCBhZ2VudFNnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsIFwiQnVpbGRraXRlQWdlbnRTZ1wiLCB7XG4gICAgICB2cGMsXG4gICAgICBkZXNjcmlwdGlvbjogXCJCdWlsZGtpdGUgYWdlbnQgLSBvdXRib3VuZCBvbmx5XCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCB1c2VyRGF0YSA9IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpO1xuICAgIHVzZXJEYXRhLmFkZENvbW1hbmRzKFxuICAgICAgXCJzZXQgLWV1byBwaXBlZmFpbFwiLFxuICAgICAgXCJleHBvcnQgSE9NRT0vcm9vdFwiLFxuICAgICAgLy8gSW5zdGFsbCBjb3JlIHRvb2xzXG4gICAgICBcImRuZiBpbnN0YWxsIC15IGRvY2tlciBnaXQgdW56aXAgbm9kZWpzIG5wbVwiLFxuICAgICAgXCJzeXN0ZW1jdGwgZW5hYmxlIC0tbm93IGRvY2tlclwiLFxuICAgICAgLy8gSW5zdGFsbCBBV1MgQ0xJIHYyXG4gICAgICAnY3VybCAtZnNTTCBcImh0dHBzOi8vYXdzY2xpLmFtYXpvbmF3cy5jb20vYXdzY2xpLWV4ZS1saW51eC14ODZfNjQuemlwXCIgLW8gL3RtcC9hd3NjbGl2Mi56aXAnLFxuICAgICAgXCJ1bnppcCAtcSAvdG1wL2F3c2NsaXYyLnppcCAtZCAvdG1wICYmIC90bXAvYXdzL2luc3RhbGxcIixcbiAgICAgIC8vIEluc3RhbGwgQ0RLXG4gICAgICBcIm5wbSBpbnN0YWxsIC1nIGF3cy1jZGtcIixcbiAgICAgIC8vIEluc3RhbGwgQnVpbGRraXRlIGFnZW50IGFzIHJvb3RcbiAgICAgICdjdXJsIC1mc1NMIFwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2J1aWxka2l0ZS9hZ2VudC9tYWluL2luc3RhbGwuc2hcIiB8IGJhc2gnLFxuICAgICAgLy8gQ29uZmlndXJlIGFnZW50IHRva2VuIGZyb20gU2VjcmV0cyBNYW5hZ2VyXG4gICAgICBcIlRPS0VOPSQoYXdzIHNlY3JldHNtYW5hZ2VyIGdldC1zZWNyZXQtdmFsdWUgLS1zZWNyZXQtaWQgL2FpY2hhdGFwaS9idWlsZGtpdGUvYWdlbnQtdG9rZW4gLS1yZWdpb24gYXAtc291dGhlYXN0LTIgLS1xdWVyeSBTZWNyZXRTdHJpbmcgLS1vdXRwdXQgdGV4dClcIixcbiAgICAgICdzZWQgLWkgXCJzfHRva2VuPVxcXFxcInh4eFxcXFxcInx0b2tlbj1cXFxcXCIkVE9LRU5cXFxcXCJ8XCIgL3Jvb3QvLmJ1aWxka2l0ZS1hZ2VudC9idWlsZGtpdGUtYWdlbnQuY2ZnJyxcbiAgICAgIC8vIENyZWF0ZSBzeXN0ZW1kIHNlcnZpY2UgcnVubmluZyBhcyByb290IHNvIGl0IGhhcyBkb2NrZXIgYWNjZXNzXG4gICAgICBgY2F0ID4gL2V0Yy9zeXN0ZW1kL3N5c3RlbS9idWlsZGtpdGUtYWdlbnQuc2VydmljZSA8PCAnRU9GJ1xuW1VuaXRdXG5EZXNjcmlwdGlvbj1CdWlsZGtpdGUgQWdlbnRcbkFmdGVyPW5ldHdvcmsudGFyZ2V0IGRvY2tlci5zZXJ2aWNlXG5SZXF1aXJlcz1kb2NrZXIuc2VydmljZVxuXG5bU2VydmljZV1cblR5cGU9c2ltcGxlXG5Vc2VyPXJvb3RcbkVudmlyb25tZW50PUhPTUU9L3Jvb3RcbkV4ZWNTdGFydD0vcm9vdC8uYnVpbGRraXRlLWFnZW50L2Jpbi9idWlsZGtpdGUtYWdlbnQgc3RhcnQgLS1jb25maWcgL3Jvb3QvLmJ1aWxka2l0ZS1hZ2VudC9idWlsZGtpdGUtYWdlbnQuY2ZnXG5SZXN0YXJ0PWFsd2F5c1xuUmVzdGFydFNlYz0xMFxuXG5bSW5zdGFsbF1cbldhbnRlZEJ5PW11bHRpLXVzZXIudGFyZ2V0XG5FT0ZgLFxuICAgICAgXCJzeXN0ZW1jdGwgZGFlbW9uLXJlbG9hZFwiLFxuICAgICAgXCJzeXN0ZW1jdGwgZW5hYmxlIC0tbm93IGJ1aWxka2l0ZS1hZ2VudFwiXG4gICAgKTtcblxuICAgIG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsIFwiQnVpbGRraXRlQWdlbnRBc2dcIiwge1xuICAgICAgdnBjLFxuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLlQzLCBlYzIuSW5zdGFuY2VTaXplLk1FRElVTSksXG4gICAgICBtYWNoaW5lSW1hZ2U6IGVjMi5NYWNoaW5lSW1hZ2UubGF0ZXN0QW1hem9uTGludXgyMDIzKCksXG4gICAgICByb2xlOiBhZ2VudFJvbGUsXG4gICAgICBzZWN1cml0eUdyb3VwOiBhZ2VudFNnLFxuICAgICAgdXNlckRhdGEsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyB9LFxuICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICBtYXhDYXBhY2l0eTogMSxcbiAgICAgIHVwZGF0ZVBvbGljeTogYXV0b3NjYWxpbmcuVXBkYXRlUG9saWN5LnJvbGxpbmdVcGRhdGUoKSxcbiAgICB9KTtcbiAgfVxufVxuIl19