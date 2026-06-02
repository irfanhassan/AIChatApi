#!/bin/bash
set -euo pipefail

ECR_REPO="847143401367.dkr.ecr.ap-southeast-2.amazonaws.com/aichatapi"
IMAGE_TAG="${BUILDKITE_COMMIT}"

echo "--- Creating ECR repo if it doesn't exist"
if ! aws ecr describe-repositories --repository-names aichatapi --region ap-southeast-2 2>/dev/null; then
  aws ecr create-repository --repository-name aichatapi --region ap-southeast-2
fi

echo "--- Logging in to ECR"
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin "${ECR_REPO}"

echo "--- Building Docker image"
docker build -t "${ECR_REPO}:${IMAGE_TAG}" -t "${ECR_REPO}:latest" "${BUILDKITE_BUILD_CHECKOUT_PATH}"

echo "--- Pushing Docker image"
docker push "${ECR_REPO}:${IMAGE_TAG}"
docker push "${ECR_REPO}:latest"
