variable "project_id" {
  type = string
}

variable "name" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "accessors" {
  description = "Service account emails that read the secrets at runtime."
  type        = list(string)
}

# Secret containers only — values are added out of band (`gcloud secrets versions add`), never in state.
# Payment provider credentials live under `payments/<tenant|platform>/<provider>/<merchantRef>` (D-042, B6.1) and
# are created by the API's secret adapter, not here.
locals {
  secrets = [
    "database-app-password",
    "database-migrator-password",
    "jwt-signing-key",
    "data-key-kek",
    "mqtt-ingest-password",
    "web-session-secret",
    "liff-session-secret",
    "line-channel-secret",
    "sms-provider-key",
    "ota-signing-public-key",
  ]
}

resource "google_secret_manager_secret" "secret" {
  for_each  = toset(local.secrets)
  secret_id = "${var.name}-${each.key}"
  labels    = var.labels

  replication {
    user_managed {
      replicas {
        location = "asia-southeast3"
      }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = {
    for pair in setproduct(local.secrets, var.accessors) : "${pair[0]}/${pair[1]}" => { secret = pair[0], member = pair[1] }
  }
  secret_id = google_secret_manager_secret.secret[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.member}"
}

output "ids" {
  value = { for k, s in google_secret_manager_secret.secret : k => s.secret_id }
}
