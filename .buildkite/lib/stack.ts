import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ECR repo — Buildkite will push images here
    const repo = new ecr.Repository(this, "AIChatApiRepo", {
      repositoryName: "aichatapi",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // VPC with 2 AZs
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2 });

    // ECS cluster
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    // Reference the secret created in Step 2
    const openAiSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "OpenAiSecret",
      "/aichatapi/prod/openai-api-key"
    );

    // Image tag passed in at deploy time (e.g. git commit SHA)
    const imageTag = new cdk.CfnParameter(this, "ImageTag", {
      type: "String",
      default: "latest",
    });

    // Fargate service behind an ALB
    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "Service",
      {
        cluster,
        cpu: 512,
        memoryLimitMiB: 1024,
        desiredCount: 1,
        taskImageOptions: {
          image: ecs.ContainerImage.fromEcrRepository(repo, imageTag.valueAsString),
          containerPort: 8080,
          environment: {
            ASPNETCORE_ENVIRONMENT: "Production",
            OpenAI__Model: "gpt-4o-mini",
          },
          secrets: {
            // Injected as env var OpenAI__ApiKey at runtime
            OpenAI__ApiKey: ecs.Secret.fromSecretsManager(openAiSecret),
          },
        },
        publicLoadBalancer: true,
      }
    );

    // Health check
    service.targetGroup.configureHealthCheck({ path: "/openapi/v1.json" });

    new cdk.CfnOutput(this, "LoadBalancerDns", {
      value: service.loadBalancer.loadBalancerDnsName,
    });
  }
}
