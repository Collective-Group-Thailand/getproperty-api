variable "project_id" {
  description = "GCP project of this environment (one project per workspace: dev, uat, prod)."
  type        = string
}

variable "region" {
  description = "Primary region (D-160: Bangkok, asia-southeast3; PDPA data residency preference)."
  type        = string
  default     = "asia-southeast3"
}

variable "domain" {
  description = "Public base domain of the environment (e.g. dev.getproperty.co)."
  type        = string
}

variable "images" {
  description = "Container images per service (Artifact Registry, pinned by digest in CI)."
  type = object({
    api    = string
    worker = string
    ingest = string
    web    = string
    liff   = string
  })
}

variable "alert_email" {
  description = "Where uptime and error-budget alerts go."
  type        = string
}
