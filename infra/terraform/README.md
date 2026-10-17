# infra/terraform — getproperty on GCP (D-160, D-207)

Skeleton of the production layout: Cloud Run services `api`, `worker`, `ingest`, `web`, `liff`; Cloud SQL
PostgreSQL 18 (private IP, PITR); Memorystore Redis for BullMQ (`noeviction`, no Cloud Tasks); GCS buckets
`documents`, `exports`, `ota`, `archive`; GKE Autopilot for EMQX; Secret Manager containers (values never in state);
least-privilege runtime service accounts. One state per workspace.

```sh
terraform init -backend-config="bucket=<state bucket>"
terraform workspace select dev   # or uat, prod (create once with `workspace new`)
terraform plan -var-file=envs/dev.tfvars
```

**UNVERIFIED**: written without a terraform binary (the build sandbox cannot download it). `pnpm infra:lint` checks
the structure (balanced blocks, module sources and arguments, declared variables / locals / outputs, every workspace
var file complete); CI must also run `terraform fmt -check -recursive` and `terraform validate` before the first
`apply`. Provider-specific values to confirm on the first plan: `POSTGRES_18` in `asia-southeast3`, Cloud Run direct
VPC egress, the EMQX operator install (Helm, runbook), the Memorystore tier names.
