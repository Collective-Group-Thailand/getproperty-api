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

variable "memory_gb" {
  type = number
}

variable "labels" {
  type = map(string)
}

# BullMQ queues, the scheduler lock, caches and rate limits (D-160: BullMQ on Memorystore, no Cloud Tasks).
# BullMQ needs `maxmemory-policy noeviction`.
resource "google_redis_instance" "main" {
  name                    = "${var.name}-redis"
  region                  = var.region
  tier                    = var.tier
  memory_size_gb          = var.memory_gb
  redis_version           = "REDIS_7_2"
  authorized_network      = var.network_id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  transit_encryption_mode = "DISABLED"
  labels                  = var.labels

  redis_configs = {
    "maxmemory-policy" = "noeviction"
  }
}

output "host" {
  value = google_redis_instance.main.host
}

output "port" {
  value = google_redis_instance.main.port
}
