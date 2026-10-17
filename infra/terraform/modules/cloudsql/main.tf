variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "network_id" {
  type = string
}

variable "tier" {
  type = string
}

variable "high_availability" {
  type = bool
}

variable "disk_gb" {
  type = number
}

variable "deletion_protect" {
  type = bool
}

variable "labels" {
  type = map(string)
}

# PostgreSQL 18 (schema-design §1; D-162: no timescaledb on Cloud SQL — native partitions + rollups).
# UNVERIFIED: `POSTGRES_18` availability in asia-southeast3 at launch.
resource "google_sql_database_instance" "main" {
  name                = "${var.name}-pg"
  region              = var.region
  database_version    = "POSTGRES_18"
  deletion_protection = var.deletion_protect

  settings {
    tier              = var.tier
    edition           = "ENTERPRISE"
    availability_type = var.high_availability ? "REGIONAL" : "ZONAL"
    disk_size         = var.disk_gb
    disk_autoresize   = true
    user_labels       = var.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "19:00" # 02:00 Asia/Bangkok
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
      }
    }

    maintenance_window {
      day  = 7
      hour = 20 # Sunday 03:00 Asia/Bangkok
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "max_connections"
      value = "400"
    }

    insights_config {
      query_insights_enabled = true
    }
  }
}

resource "google_sql_database" "app" {
  name     = "getproperty"
  instance = google_sql_database_instance.main.name
}

output "connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "private_ip" {
  value = google_sql_database_instance.main.private_ip_address
}

output "database_name" {
  value = google_sql_database.app.name
}
