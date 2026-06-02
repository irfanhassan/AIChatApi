#!/bin/bash
set -euo pipefail

echo "--- Installing CDK dependencies"
cd "${BUILDKITE_BUILD_CHECKOUT_PATH}/.buildkite"
npm ci

echo "--- Compiling TypeScript"
node --max-old-space-size=1024 node_modules/.bin/tsc --skipLibCheck
echo "--- Compiled files:"
find dist -name "*.js" 2>/dev/null || echo "dist folder not found!"

echo "--- Deploying to Fargate"
npx cdk deploy --require-approval never --parameters "ImageTag=${BUILDKITE_COMMIT}" --region ap-southeast-2
