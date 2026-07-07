#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../stack';

const app = new cdk.App();
new InfraStack(app, 'InfraStack', {
  env: { account: '847143401367', region: 'ap-southeast-2' },
});
