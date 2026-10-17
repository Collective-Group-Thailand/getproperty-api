variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "network_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "labels" {
  type = map(string)
}

# EMQX (MQTT broker for gateways, D-160) on GKE Autopilot; the EMQX operator + cluster CR are applied by the
# platform runbook (Helm), not by this module. Gateways connect with mTLS on 8883 through an internal-to-external
# TCP load balancer created by the EMQX Service.
resource "google_container_cluster" "emqx" {
  name                = "${var.name}-emqx"
  location            = var.region
  enable_autopilot    = true
  network             = var.network_id
  subnetwork          = var.subnet_id
  deletion_protection = true
  resource_labels     = var.labels

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  release_channel {
    channel = "REGULAR"
  }
}

resource "google_compute_address" "mqtt" {
  name   = "${var.name}-mqtt"
  region = var.region
}

output "cluster_name" {
  value = google_container_cluster.emqx.name
}

output "mqtt_url" {
  # In-VPC listener used by the ingest service (gateways use the public address on 8883).
  value = "mqtts://emqx.${var.name}.internal:8883"
}

output "public_address" {
  value = google_compute_address.mqtt.address
}
