variable "project_id" {
  type = string
}

variable "name" {
  type = string
}

locals {
  services = ["api", "worker", "ingest", "web", "liff"]
  # Least privilege per runtime; bucket and secret grants are made by their modules.
  project_roles = {
    api    = ["roles/cloudsql.client", "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent", "roles/iam.serviceAccountTokenCreator"]
    worker = ["roles/cloudsql.client", "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent", "roles/iam.serviceAccountTokenCreator", "roles/secretmanager.admin"]
    ingest = ["roles/cloudsql.client", "roles/logging.logWriter", "roles/monitoring.metricWriter"]
    web    = ["roles/logging.logWriter", "roles/monitoring.metricWriter"]
    liff   = ["roles/logging.logWriter", "roles/monitoring.metricWriter"]
  }
}

resource "google_service_account" "runtime" {
  for_each     = toset(local.services)
  account_id   = "${var.name}-${each.key}"
  display_name = "getproperty ${each.key} runtime"
}

resource "google_project_iam_member" "runtime" {
  for_each = {
    for pair in flatten([for s, roles in local.project_roles : [for r in roles : { service = s, role = r }]]) :
    "${pair.service}/${pair.role}" => pair
  }
  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.runtime[each.value.service].email}"
}

output "service_accounts" {
  value = { for k, sa in google_service_account.runtime : k => sa.email }
}
