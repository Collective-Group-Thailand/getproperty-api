variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "image" {
  type = string
}

variable "service_account" {
  type = string
}

variable "vpc_subnet_id" {
  type = string
}

variable "min_instances" {
  type = number
}

variable "max_instances" {
  type = number
}

variable "cpu_always_on" {
  description = "Background processes (worker, ingest) keep CPU allocated outside requests."
  type        = bool
  default     = false
}

variable "public" {
  description = "Allow unauthenticated invocations (behind the load balancer / Cloud Armor)."
  type        = bool
}

variable "env" {
  type = map(string)
}

variable "secrets" {
  description = "Env var => Secret Manager secret id (latest version)."
  type        = map(string)
  default     = {}
}

variable "labels" {
  type = map(string)
}

resource "google_cloud_run_v2_service" "service" {
  name     = var.name
  location = var.region
  ingress  = var.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  labels   = var.labels

  template {
    service_account = var.service_account

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        subnetwork = var.vpc_subnet_id
      }
    }

    containers {
      image = var.image

      resources {
        cpu_idle = !var.cpu_always_on
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.public ? 1 : 0
  name     = google_cloud_run_v2_service.service.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "uri" {
  value = google_cloud_run_v2_service.service.uri
}
