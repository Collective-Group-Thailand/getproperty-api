# getproperty on GCP (D-160): Cloud Run (api, worker, ingest, web, liff), Cloud SQL PostgreSQL 18, Memorystore
# (BullMQ — no Cloud Tasks), GCS buckets, GKE Autopilot for EMQX, Secret Manager, IAM. Workspaces: dev, uat, prod.
# UNVERIFIED: written without `terraform validate` against the providers (no terraform binary in the build
# sandbox); `pnpm infra:lint` checks it structurally. Run `terraform fmt -check && terraform validate` in CI.

module "network" {
  source = "./modules/network"
  name   = local.name
  region = var.region
}

module "iam" {
  source     = "./modules/iam"
  project_id = var.project_id
  name       = local.name
}

module "storage" {
  source           = "./modules/storage"
  project_id       = var.project_id
  name             = local.name
  region           = var.region
  labels           = local.labels
  deletion_protect = local.size.deletion_protect
  writers          = {
    documents = [module.iam.service_accounts["api"], module.iam.service_accounts["worker"]]
    exports   = [module.iam.service_accounts["worker"]]
    ota       = [module.iam.service_accounts["api"]]
    archive   = [module.iam.service_accounts["worker"]]
  }
}

module "secrets" {
  source     = "./modules/secrets"
  project_id = var.project_id
  name       = local.name
  labels     = local.labels
  accessors  = [
    module.iam.service_accounts["api"],
    module.iam.service_accounts["worker"],
    module.iam.service_accounts["ingest"],
  ]
}

module "cloudsql" {
  source            = "./modules/cloudsql"
  name              = local.name
  region            = var.region
  network_id        = module.network.network_id
  tier              = local.size.sql_tier
  high_availability = local.size.sql_ha
  disk_gb           = local.size.sql_disk_gb
  deletion_protect  = local.size.deletion_protect
  labels            = local.labels
  depends_on        = [module.network]
}

module "memorystore" {
  source     = "./modules/memorystore"
  name       = local.name
  region     = var.region
  network_id = module.network.network_id
  tier       = local.size.redis_tier
  memory_gb  = local.size.redis_memory_gb
  labels     = local.labels
  depends_on = [module.network]
}

module "emqx" {
  source     = "./modules/gke-emqx"
  name       = local.name
  region     = var.region
  network_id = module.network.network_id
  subnet_id  = module.network.subnet_id
  labels     = local.labels
}

locals {
  common_env = {
    NODE_ENV              = "production"
    APP_ENV               = local.env
    OBJECT_STORAGE_DRIVER = "gcs"
    SECRETS_DRIVER        = "gcp"
    GCS_BUCKET_DOCUMENTS  = module.storage.buckets["documents"]
    GCS_BUCKET_EXPORTS    = module.storage.buckets["exports"]
    GCP_PROJECT_ID        = var.project_id
    REDIS_HOST            = module.memorystore.host
    REDIS_PORT            = tostring(module.memorystore.port)
    DATABASE_HOST         = module.cloudsql.private_ip
    DATABASE_NAME         = module.cloudsql.database_name
  }
  # Secret Manager secret ids mounted as env vars (values are never in state).
  common_secrets = {
    DATABASE_PASSWORD = module.secrets.ids["database-app-password"]
    JWT_SIGNING_KEY   = module.secrets.ids["jwt-signing-key"]
    DATA_KEY_KEK      = module.secrets.ids["data-key-kek"]
  }
}

module "run_api" {
  source          = "./modules/cloudrun"
  name            = "${local.name}-api"
  region          = var.region
  image           = var.images.api
  service_account = module.iam.service_accounts["api"]
  vpc_subnet_id   = module.network.subnet_id
  min_instances   = local.size.api_min_instances
  max_instances   = local.size.api_max_instances
  public          = true
  # Client IP (D-229, RUNBOOK §11): one hop for Cloud Run's front end; the BFFs (web, liff) reach the API from the
  # subnet (Private Google Access) or the NAT address, and their forwarded end-user address is trusted from there.
  env = merge(local.common_env, {
    PROCESS_ROLE        = "api"
    TRUST_PROXY         = "1"
    TRUSTED_PROXY_CIDRS = "${module.network.subnet_cidr},${module.network.egress_ip}/32"
  })
  secrets         = local.common_secrets
  labels          = local.labels
}

module "run_worker" {
  source          = "./modules/cloudrun"
  name            = "${local.name}-worker"
  region          = var.region
  image           = var.images.worker
  service_account = module.iam.service_accounts["worker"]
  vpc_subnet_id   = module.network.subnet_id
  # BullMQ consumers + the scheduler: always on, CPU always allocated.
  min_instances   = 1
  max_instances   = 4
  cpu_always_on   = true
  public          = false
  env             = merge(local.common_env, { PROCESS_ROLE = "worker" })
  secrets         = local.common_secrets
  labels          = local.labels
}

module "run_ingest" {
  source          = "./modules/cloudrun"
  name            = "${local.name}-ingest"
  region          = var.region
  image           = var.images.ingest
  service_account = module.iam.service_accounts["ingest"]
  vpc_subnet_id   = module.network.subnet_id
  # MQTT subscriber to EMQX (shared subscription): always on.
  min_instances   = 1
  max_instances   = 4
  cpu_always_on   = true
  public          = false
  env             = merge(local.common_env, { PROCESS_ROLE = "ingest", MQTT_URL = module.emqx.mqtt_url })
  secrets         = merge(local.common_secrets, { MQTT_PASSWORD = module.secrets.ids["mqtt-ingest-password"] })
  labels          = local.labels
}

module "run_web" {
  source          = "./modules/cloudrun"
  name            = "${local.name}-web"
  region          = var.region
  image           = var.images.web
  service_account = module.iam.service_accounts["web"]
  vpc_subnet_id   = module.network.subnet_id
  min_instances   = local.size.api_min_instances
  max_instances   = 10
  public          = true
  env             = { API_INTERNAL_URL = module.run_api.uri, APP_ENV = local.env }
  secrets         = { SESSION_SECRET = module.secrets.ids["web-session-secret"] }
  labels          = local.labels
}

module "run_liff" {
  source          = "./modules/cloudrun"
  name            = "${local.name}-liff"
  region          = var.region
  image           = var.images.liff
  service_account = module.iam.service_accounts["liff"]
  vpc_subnet_id   = module.network.subnet_id
  min_instances   = local.size.api_min_instances
  max_instances   = 10
  public          = true
  # TRUSTED_HOPS: X-Forwarded-For entries appended by our edge, counted from the right (Cloud Run front end = 1).
  env             = { API_INTERNAL_URL = module.run_api.uri, APP_ENV = local.env, TRUSTED_HOPS = "1" }
  secrets         = { SESSION_SECRET = module.secrets.ids["liff-session-secret"] }
  labels          = local.labels
}
