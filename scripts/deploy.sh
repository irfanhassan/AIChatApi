#!/bin/bash

echo "--- Installing CDK dependencies"
cd "${BUILDKITE_BUILD_CHECKOUT_PATH}/.buildkite"
npm ci

echo "--- Compiling TypeScript"
node --max-old-space-size=1024 node_modules/.bin/tsc --listEmittedFiles 2>&1 || echo "tsc exited with error"
echo "--- Compiled files:"
find dist -name "*.js" 2>/dev/null || echo "dist folder not found!"
echo "--- Current directory contents:"
ls -la

echo "--- Deploying to Fargate"
npx cdk deploy --require-approval never --parameters "ImageTag=${BUILDKITE_COMMIT}" --region ap-southeast-2
