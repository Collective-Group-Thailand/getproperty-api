#!/bin/bash
# Runs when LocalStack is ready (like getpack's): creates the dev bucket (private; meter photos, slips, documents),
# a verified SES sender (SES_FROM_ADDRESS) and an empty dev secret so AWS_SECRETS_ID can be exercised locally.
set -euo pipefail
awslocal s3api create-bucket --bucket getproperty-dev --create-bucket-configuration LocationConstraint=ap-southeast-1
awslocal ses verify-email-identity --email-address no-reply@getproperty.co
awslocal secretsmanager create-secret --name getproperty/dev --secret-string '{}' >/dev/null
echo "localstack: getproperty-dev bucket, SES identity and getproperty/dev secret ready"
