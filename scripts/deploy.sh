#!/bin/bash
set -euo pipefail

echo "--- Installing CDK dependencies"
cd "${BUILDKITE_BUILD_CHECKOUT_PATH}/.buildkite"
npm ci

echo "--- Compiling TypeScript"
node --max-old-space-size=512 node_modules/.bin/tsc

echo "--- Deploying to Fargate"
npx cdk deploy --require-approval never --parameters "ImageTag=${BUILDKITE_COMMIT}" --region ap-southeast-2
