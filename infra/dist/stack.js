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
        userData.addCommands("set -euo pipefail", 
        // Install Docker
        "dnf install -y docker", "systemctl enable --now docker", "usermod -aG docker ec2-user", 
        // Install AWS CLI v2
        'curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip', "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install", 
        // Install Node.js (for CDK deploy step)
        "dnf install -y nodejs npm", "npm install -g aws-cdk", 
        // Install Buildkite agent via install script
        "mkdir -p /usr/local/lib/buildkite-agent /etc/buildkite-agent /var/log/buildkite-agent", 'curl -fsSL "https://raw.githubusercontent.com/buildkite/agent/main/install.sh" -o /tmp/install-buildkite.sh', "BUILDKITE_INSTALL_DIR=/usr/local/lib/buildkite-agent bash /tmp/install-buildkite.sh", "ln -sf /usr/local/lib/buildkite-agent/bin/buildkite-agent /usr/local/bin/buildkite-agent", 
        // Configure agent token from Secrets Manager
        `TOKEN=$(aws secretsmanager get-secret-value --secret-id /aichatapi/buildkite/agent-token --region ap-southeast-2 --query SecretString --output text)`, 'echo "token=\\"${TOKEN}\\"" > /etc/buildkite-agent/buildkite-agent.cfg', 'echo "name=\\"aichatapi-agent-%hostname\\"" >> /etc/buildkite-agent/buildkite-agent.cfg', 'echo "build-path=\\"/var/lib/buildkite-agent/builds\\"" >> /etc/buildkite-agent/buildkite-agent.cfg', "mkdir -p /var/lib/buildkite-agent/builds", 
        // Create systemd service
        `cat > /etc/systemd/system/buildkite-agent.service << 'EOF'
[Unit]
Description=Buildkite Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/buildkite-agent start --config /etc/buildkite-agent/buildkite-agent.cfg
Restart=always
RestartSec=5
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF`, "systemctl daemon-reload", "systemctl enable --now buildkite-agent");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELDJDQUEyQztBQUMzQyxpRUFBaUU7QUFFakUsTUFBYSxVQUFXLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDdkMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsVUFBVSxDQUFDLGtCQUFrQixDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFFbkYsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBRXhFLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUUxRCxNQUFNLFlBQVksR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUN6RCxJQUFJLEVBQ0osY0FBYyxFQUNkLGdDQUFnQyxDQUNqQyxDQUFDO1FBRUYsTUFBTSxlQUFlLEdBQUcsY0FBYyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FDNUQsSUFBSSxFQUNKLGlCQUFpQixFQUNqQixtQ0FBbUMsQ0FDcEMsQ0FBQztRQUVGLE1BQU0sZUFBZSxHQUFHLGNBQWMsQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQzVELElBQUksRUFDSixpQkFBaUIsRUFDakIsNEJBQTRCLENBQzdCLENBQUM7UUFFRixNQUFNLGVBQWUsR0FBRyxj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QUNFLHlCQUF5QixFQUN6Qix3Q0FBd0MsQ0FDekMsQ0FBQztRQUVGLElBQUksV0FBVyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUMxRCxHQUFHO1lBQ0gsWUFBWSxFQUFFLEdBQUcsQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDO1lBQy9FLFlBQVksRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLHFCQUFxQixFQUFFO1lBQ3RELElBQUksRUFBRSxTQUFTO1lBQ2YsYUFBYSxFQUFFLE9BQU87WUFDdEIsUUFBUTtZQUNSLFVBQVUsRUFBRSxFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU0sRUFBRTtZQUNqRCxXQUFXLEVBQUUsQ0FBQztZQUNkLFdBQVcsRUFBRSxDQUFDO1lBQ2QsWUFBWSxFQUFFLFdBQVcsQ0FBQyxZQUFZLENBQUMsYUFBYSxFQUFFO1NBQ3ZELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQS9KRCxnQ0ErSkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWMyXCI7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSBcImF3cy1jZGstbGliL2F3cy1lY3JcIjtcbmltcG9ydCAqIGFzIGVjcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjc1wiO1xuaW1wb3J0ICogYXMgYXV0b3NjYWxpbmcgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZ1wiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyXCI7XG5cbmV4cG9ydCBjbGFzcyBJbmZyYVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgcmVwbyA9IGVjci5SZXBvc2l0b3J5LmZyb21SZXBvc2l0b3J5TmFtZSh0aGlzLCBcIkFJQ2hhdEFwaVJlcG9cIiwgXCJhaWNoYXRhcGlcIik7XG5cbiAgICBjb25zdCB2cGMgPSBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgXCJEZWZhdWx0VnBjXCIsIHsgaXNEZWZhdWx0OiB0cnVlIH0pO1xuXG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCBcIkNsdXN0ZXJcIiwgeyB2cGMgfSk7XG5cbiAgICBjb25zdCBvcGVuQWlTZWNyZXQgPSBzZWNyZXRzbWFuYWdlci5TZWNyZXQuZnJvbVNlY3JldE5hbWVWMihcbiAgICAgIHRoaXMsXG4gICAgICBcIk9wZW5BaVNlY3JldFwiLFxuICAgICAgXCIvYWljaGF0YXBpL3Byb2Qvb3BlbmFpLWFwaS1rZXlcIlxuICAgICk7XG5cbiAgICBjb25zdCBhbnRocm9waWNTZWNyZXQgPSBzZWNyZXRzbWFuYWdlci5TZWNyZXQuZnJvbVNlY3JldE5hbWVWMihcbiAgICAgIHRoaXMsXG4gICAgICBcIkFudGhyb3BpY1NlY3JldFwiLFxuICAgICAgXCIvYWljaGF0YXBpL3Byb2QvYW50aHJvcGljLWFwaS1rZXlcIlxuICAgICk7XG5cbiAgICBjb25zdCBxZHJhbnRVcmxTZWNyZXQgPSBzZWNyZXRzbWFuYWdlci5TZWNyZXQuZnJvbVNlY3JldE5hbWVWMihcbiAgICAgIHRoaXMsXG4gICAgICBcIlFkcmFudFVybFNlY3JldFwiLFxuICAgICAgXCIvYWljaGF0YXBpL3Byb2QvcWRyYW50LXVybFwiXG4gICAgKTtcblxuICAgIGNvbnN0IHFkcmFudEtleVNlY3JldCA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKFxuICAgICAgdGhpcyxcbiAgICAgIFwiUWRyYW50S2V5U2VjcmV0XCIsXG4gICAgICBcIi9haWNoYXRhcGkvcHJvZC9xZHJhbnQtYXBpLWtleVwiXG4gICAgKTtcblxuICAgIGNvbnN0IGltYWdlVGFnID0gbmV3IGNkay5DZm5QYXJhbWV0ZXIodGhpcywgXCJJbWFnZVRhZ1wiLCB7XG4gICAgICB0eXBlOiBcIlN0cmluZ1wiLFxuICAgICAgZGVmYXVsdDogXCJsYXRlc3RcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHRhc2tEZWYgPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCBcIlRhc2tEZWZcIiwge1xuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICB9KTtcblxuICAgIHRhc2tEZWYuYWRkQ29udGFpbmVyKFwid2ViXCIsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocmVwbywgaW1hZ2VUYWcudmFsdWVBc1N0cmluZyksXG4gICAgICBwb3J0TWFwcGluZ3M6IFt7IGNvbnRhaW5lclBvcnQ6IDgwODAgfV0sXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBBU1BORVRDT1JFX0VOVklST05NRU5UOiBcIlByb2R1Y3Rpb25cIixcbiAgICAgICAgT3BlbkFJX19Nb2RlbDogXCJncHQtNG8tbWluaVwiLFxuICAgICAgfSxcbiAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgT3BlbkFJX19BcGlLZXk6ICAgIGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKG9wZW5BaVNlY3JldCksXG4gICAgICAgIEFudGhyb3BpY19fQXBpS2V5OiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihhbnRocm9waWNTZWNyZXQpLFxuICAgICAgICBRZHJhbnRfX1VybDogICAgICAgZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIocWRyYW50VXJsU2VjcmV0KSxcbiAgICAgICAgUWRyYW50X19BcGlLZXk6ICAgIGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHFkcmFudEtleVNlY3JldCksXG4gICAgICB9LFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7IHN0cmVhbVByZWZpeDogXCJhaWNoYXRhcGlcIiB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsIFwiU2dcIiwgeyB2cGMgfSk7XG4gICAgc2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoODA4MCkpO1xuXG4gICAgY29uc3Qgc2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgXCJTZXJ2aWNlXCIsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbjogdGFza0RlZixcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGFzc2lnblB1YmxpY0lwOiB0cnVlLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtzZ10sXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NhbGluZyA9IHNlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHsgbWluQ2FwYWNpdHk6IDEsIG1heENhcGFjaXR5OiA0IH0pO1xuICAgIHNjYWxpbmcuc2NhbGVPbkNwdVV0aWxpemF0aW9uKFwiQ3B1U2NhbGluZ1wiLCB7IHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogNzAgfSk7XG5cbiAgICAvLyBCdWlsZGtpdGUgYWdlbnQgRUMyIGluc3RhbmNlXG4gICAgY29uc3QgYnVpbGRraXRlQWdlbnRUb2tlbiA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKFxuICAgICAgdGhpcyxcbiAgICAgIFwiQnVpbGRraXRlQWdlbnRUb2tlblwiLFxuICAgICAgXCIvYWljaGF0YXBpL2J1aWxka2l0ZS9hZ2VudC10b2tlblwiXG4gICAgKTtcblxuICAgIGNvbnN0IGFnZW50Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIkJ1aWxka2l0ZUFnZW50Um9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImVjMi5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFtYXpvbkVDMkNvbnRhaW5lclJlZ2lzdHJ5RnVsbEFjY2Vzc1wiKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQW1hem9uRUNTX0Z1bGxBY2Nlc3NcIiksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFtYXpvblMzRnVsbEFjY2Vzc1wiKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQW1hem9uU1NNUmVhZE9ubHlBY2Nlc3NcIiksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFtYXpvblNTTU1hbmFnZWRJbnN0YW5jZUNvcmVcIiksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFXU0Nsb3VkRm9ybWF0aW9uRnVsbEFjY2Vzc1wiKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiSUFNRnVsbEFjY2Vzc1wiKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBidWlsZGtpdGVBZ2VudFRva2VuLmdyYW50UmVhZChhZ2VudFJvbGUpO1xuXG4gICAgY29uc3QgYWdlbnRTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCBcIkJ1aWxka2l0ZUFnZW50U2dcIiwge1xuICAgICAgdnBjLFxuICAgICAgZGVzY3JpcHRpb246IFwiQnVpbGRraXRlIGFnZW50IC0gb3V0Ym91bmQgb25seVwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgdXNlckRhdGEgPSBlYzIuVXNlckRhdGEuZm9yTGludXgoKTtcbiAgICB1c2VyRGF0YS5hZGRDb21tYW5kcyhcbiAgICAgIFwic2V0IC1ldW8gcGlwZWZhaWxcIixcbiAgICAgIC8vIEluc3RhbGwgRG9ja2VyXG4gICAgICBcImRuZiBpbnN0YWxsIC15IGRvY2tlclwiLFxuICAgICAgXCJzeXN0ZW1jdGwgZW5hYmxlIC0tbm93IGRvY2tlclwiLFxuICAgICAgXCJ1c2VybW9kIC1hRyBkb2NrZXIgZWMyLXVzZXJcIixcbiAgICAgIC8vIEluc3RhbGwgQVdTIENMSSB2MlxuICAgICAgJ2N1cmwgLWZzU0wgXCJodHRwczovL2F3c2NsaS5hbWF6b25hd3MuY29tL2F3c2NsaS1leGUtbGludXgteDg2XzY0LnppcFwiIC1vIC90bXAvYXdzY2xpdjIuemlwJyxcbiAgICAgIFwidW56aXAgLXEgL3RtcC9hd3NjbGl2Mi56aXAgLWQgL3RtcCAmJiAvdG1wL2F3cy9pbnN0YWxsXCIsXG4gICAgICAvLyBJbnN0YWxsIE5vZGUuanMgKGZvciBDREsgZGVwbG95IHN0ZXApXG4gICAgICBcImRuZiBpbnN0YWxsIC15IG5vZGVqcyBucG1cIixcbiAgICAgIFwibnBtIGluc3RhbGwgLWcgYXdzLWNka1wiLFxuICAgICAgLy8gSW5zdGFsbCBCdWlsZGtpdGUgYWdlbnQgdmlhIGluc3RhbGwgc2NyaXB0XG4gICAgICBcIm1rZGlyIC1wIC91c3IvbG9jYWwvbGliL2J1aWxka2l0ZS1hZ2VudCAvZXRjL2J1aWxka2l0ZS1hZ2VudCAvdmFyL2xvZy9idWlsZGtpdGUtYWdlbnRcIixcbiAgICAgICdjdXJsIC1mc1NMIFwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2J1aWxka2l0ZS9hZ2VudC9tYWluL2luc3RhbGwuc2hcIiAtbyAvdG1wL2luc3RhbGwtYnVpbGRraXRlLnNoJyxcbiAgICAgIFwiQlVJTERLSVRFX0lOU1RBTExfRElSPS91c3IvbG9jYWwvbGliL2J1aWxka2l0ZS1hZ2VudCBiYXNoIC90bXAvaW5zdGFsbC1idWlsZGtpdGUuc2hcIixcbiAgICAgIFwibG4gLXNmIC91c3IvbG9jYWwvbGliL2J1aWxka2l0ZS1hZ2VudC9iaW4vYnVpbGRraXRlLWFnZW50IC91c3IvbG9jYWwvYmluL2J1aWxka2l0ZS1hZ2VudFwiLFxuICAgICAgLy8gQ29uZmlndXJlIGFnZW50IHRva2VuIGZyb20gU2VjcmV0cyBNYW5hZ2VyXG4gICAgICBgVE9LRU49JChhd3Mgc2VjcmV0c21hbmFnZXIgZ2V0LXNlY3JldC12YWx1ZSAtLXNlY3JldC1pZCAvYWljaGF0YXBpL2J1aWxka2l0ZS9hZ2VudC10b2tlbiAtLXJlZ2lvbiBhcC1zb3V0aGVhc3QtMiAtLXF1ZXJ5IFNlY3JldFN0cmluZyAtLW91dHB1dCB0ZXh0KWAsXG4gICAgICAnZWNobyBcInRva2VuPVxcXFxcIiR7VE9LRU59XFxcXFwiXCIgPiAvZXRjL2J1aWxka2l0ZS1hZ2VudC9idWlsZGtpdGUtYWdlbnQuY2ZnJyxcbiAgICAgICdlY2hvIFwibmFtZT1cXFxcXCJhaWNoYXRhcGktYWdlbnQtJWhvc3RuYW1lXFxcXFwiXCIgPj4gL2V0Yy9idWlsZGtpdGUtYWdlbnQvYnVpbGRraXRlLWFnZW50LmNmZycsXG4gICAgICAnZWNobyBcImJ1aWxkLXBhdGg9XFxcXFwiL3Zhci9saWIvYnVpbGRraXRlLWFnZW50L2J1aWxkc1xcXFxcIlwiID4+IC9ldGMvYnVpbGRraXRlLWFnZW50L2J1aWxka2l0ZS1hZ2VudC5jZmcnLFxuICAgICAgXCJta2RpciAtcCAvdmFyL2xpYi9idWlsZGtpdGUtYWdlbnQvYnVpbGRzXCIsXG4gICAgICAvLyBDcmVhdGUgc3lzdGVtZCBzZXJ2aWNlXG4gICAgICBgY2F0ID4gL2V0Yy9zeXN0ZW1kL3N5c3RlbS9idWlsZGtpdGUtYWdlbnQuc2VydmljZSA8PCAnRU9GJ1xuW1VuaXRdXG5EZXNjcmlwdGlvbj1CdWlsZGtpdGUgQWdlbnRcbkFmdGVyPW5ldHdvcmsudGFyZ2V0XG5cbltTZXJ2aWNlXVxuVHlwZT1zaW1wbGVcbkV4ZWNTdGFydD0vdXNyL2xvY2FsL2Jpbi9idWlsZGtpdGUtYWdlbnQgc3RhcnQgLS1jb25maWcgL2V0Yy9idWlsZGtpdGUtYWdlbnQvYnVpbGRraXRlLWFnZW50LmNmZ1xuUmVzdGFydD1hbHdheXNcblJlc3RhcnRTZWM9NVxuRW52aXJvbm1lbnQ9SE9NRT0vcm9vdFxuXG5bSW5zdGFsbF1cbldhbnRlZEJ5PW11bHRpLXVzZXIudGFyZ2V0XG5FT0ZgLFxuICAgICAgXCJzeXN0ZW1jdGwgZGFlbW9uLXJlbG9hZFwiLFxuICAgICAgXCJzeXN0ZW1jdGwgZW5hYmxlIC0tbm93IGJ1aWxka2l0ZS1hZ2VudFwiXG4gICAgKTtcblxuICAgIG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsIFwiQnVpbGRraXRlQWdlbnRBc2dcIiwge1xuICAgICAgdnBjLFxuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLlQzLCBlYzIuSW5zdGFuY2VTaXplLk1JQ1JPKSxcbiAgICAgIG1hY2hpbmVJbWFnZTogZWMyLk1hY2hpbmVJbWFnZS5sYXRlc3RBbWF6b25MaW51eDIwMjMoKSxcbiAgICAgIHJvbGU6IGFnZW50Um9sZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGFnZW50U2csXG4gICAgICB1c2VyRGF0YSxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDIH0sXG4gICAgICBtaW5DYXBhY2l0eTogMSxcbiAgICAgIG1heENhcGFjaXR5OiAxLFxuICAgICAgdXBkYXRlUG9saWN5OiBhdXRvc2NhbGluZy5VcGRhdGVQb2xpY3kucm9sbGluZ1VwZGF0ZSgpLFxuICAgIH0pO1xuICB9XG59XG4iXX0=