variable "project_id" {
  type = string
}

variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "deletion_protect" {
  type = bool
}

variable "writers" {
  description = "Bucket key => service account emails allowed to read and write objects."
  type        = map(list(string))
}

locals {
  buckets = {
    # Contracts, invoices, receipts, photos, ID documents (encrypted at rest; private; signed URLs only).
    documents = { versioning = true, retention_days = 0 }
    # Exports and DSR packages: short-lived.
    exports = { versioning = false, retention_days = 7 }
    # Signed gateway OTA artefacts.
    ota = { versioning = true, retention_days = 0 }
    # Dropped telemetry partitions (D-162) archived as Parquet.
    archive = { versioning = false, retention_days = 0 }
  }
}

resource "google_storage_bucket" "bucket" {
  for_each                    = local.buckets
  name                        = "${var.project_id}-${each.key}"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protect
  labels                      = var.labels

  versioning {
    enabled = each.value.versioning
  }

  dynamic "lifecycle_rule" {
    for_each = each.value.retention_days > 0 ? [each.value.retention_days] : []
    content {
      action {
        type = "Delete"
      }
      condition {
        age = lifecycle_rule.value
      }
    }
  }

  cors {
    # Browser uploads with V4 signed URLs (documents.presign).
    origin          = ["*"]
    method          = ["PUT", "GET"]
    response_header = ["Content-Type", "x-goog-meta-sha256"]
    max_age_seconds = 600
  }
}

resource "google_storage_bucket_iam_member" "writer" {
  for_each = {
    for pair in flatten([
      for bucket, members in var.writers : [for m in members : { bucket = bucket, member = m }]
    ]) : "${pair.bucket}/${pair.member}" => pair
  }
  bucket = google_storage_bucket.bucket[each.value.bucket].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${each.value.member}"
}

output "buckets" {
  value = { for k, b in google_storage_bucket.bucket : k => b.name }
}
