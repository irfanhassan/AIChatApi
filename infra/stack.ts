import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
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
  }
}
