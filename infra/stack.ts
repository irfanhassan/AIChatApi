import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = ecr.Repository.fromRepositoryName(this, "AIChatApiRepo", "aichatapi");

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const openAiSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "OpenAiSecret",
      "/aichatapi/prod/openai-api-key"
    );

    const anthropicSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AnthropicSecret",
      "/aichatapi/prod/anthropic-api-key"
    );

    const qdrantUrlSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "QdrantUrlSecret",
      "/aichatapi/prod/qdrant-url"
    );

    const qdrantKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "QdrantKeySecret",
      "/aichatapi/prod/qdrant-api-key"
    );

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
        OpenAI__ApiKey:    ecs.Secret.fromSecretsManager(openAiSecret),
        Anthropic__ApiKey: ecs.Secret.fromSecretsManager(anthropicSecret),
        Qdrant__Url:       ecs.Secret.fromSecretsManager(qdrantUrlSecret),
        Qdrant__ApiKey:    ecs.Secret.fromSecretsManager(qdrantKeySecret),
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
    const buildkiteAgentToken = secretsmanager.Secret.fromSecretNameV2(
      this,
      "BuildkiteAgentToken",
      "/aichatapi/buildkite/agent-token"
    );

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
    userData.addCommands(
      "set -euo pipefail",
      // Install Docker
      "dnf install -y docker",
      "systemctl enable --now docker",
      "usermod -aG docker ec2-user",
      // Install AWS CLI v2
      'curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip',
      "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install",
      // Install Node.js (for CDK deploy step)
      "dnf install -y nodejs npm",
      "npm install -g aws-cdk",
      // Install Buildkite agent via official install script
      'curl -fsSL "https://raw.githubusercontent.com/buildkite/agent/main/install.sh" | bash',
      // Configure agent token from Secrets Manager
      `TOKEN=$(aws secretsmanager get-secret-value --secret-id /aichatapi/buildkite/agent-token --region ap-southeast-2 --query SecretString --output text)`,
      `sed -i "s|token=\\"xxx\\"|token=\\"$TOKEN\\"|" /root/.buildkite-agent/buildkite-agent.cfg`,
      // Create systemd service
      `cat > /etc/systemd/system/buildkite-agent.service << 'EOF'
[Unit]
Description=Buildkite Agent
After=network.target

[Service]
Type=simple
User=root
ExecStart=/root/.buildkite-agent/bin/buildkite-agent start
Restart=always
RestartSec=5
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF`,
      "systemctl daemon-reload",
      "systemctl enable --now buildkite-agent"
    );

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
