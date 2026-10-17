# terraform workspace select uat && terraform plan -var-file=envs/uat.tfvars
project_id  = "getproperty-uat"
domain      = "uat.getproperty.co"
alert_email = "ops@getproperty.co"
images = {
  api    = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/api:latest"
  worker = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/api:latest"
  ingest = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/api:latest"
  web    = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/web:latest"
  liff   = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/liff:latest"
}
