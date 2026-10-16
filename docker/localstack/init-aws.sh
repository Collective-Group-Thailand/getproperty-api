#!/bin/bash
# Runs when LocalStack is ready: creates the dev bucket (private; meter photos, slips, documents) and an
# empty dev secret so AWS_SECRETS_ID can be exercised locally.
set -euo pipefail
awslocal s3api create-bucket --bucket getproperty-dev --create-bucket-configuration LocationConstraint=ap-southeast-1
awslocal secretsmanager create-secret --name getproperty/dev --secret-string '{}' >/dev/null
echo "localstack: getproperty-dev bucket and getproperty/dev secret ready"
