# terraform workspace select dev && terraform plan -var-file=envs/dev.tfvars
project_id  = "getproperty-dev"
domain      = "dev.getproperty.co"
alert_email = "ops@getproperty.co"
images = {
  api    = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/api:latest"
  worker = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/api:latest"
  ingest = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/api:latest"
  web    = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/web:latest"
  liff   = "asia-southeast3-docker.pkg.dev/getproperty-shared/apps/liff:latest"
}
