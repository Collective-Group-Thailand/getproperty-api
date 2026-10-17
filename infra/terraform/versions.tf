terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.10"
    }
  }

  # Partial configuration: `terraform init -backend-config="bucket=<state bucket>"`.
  # One state per workspace (dev / uat / prod) under the same prefix.
  backend "gcs" {
    prefix = "getproperty"
  }
}
