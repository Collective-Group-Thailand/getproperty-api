locals {
  env = terraform.workspace

  # Sizing per workspace; anything not listed falls back to dev.
  sizes = {
    dev = {
      sql_tier          = "db-custom-1-3840"
      sql_ha            = false
      sql_disk_gb       = 20
      redis_tier        = "BASIC"
      redis_memory_gb   = 1
      api_min_instances = 0
      api_max_instances = 3
      deletion_protect  = false
    }
    uat = {
      sql_tier          = "db-custom-2-7680"
      sql_ha            = false
      sql_disk_gb       = 50
      redis_tier        = "BASIC"
      redis_memory_gb   = 1
      api_min_instances = 1
      api_max_instances = 5
      deletion_protect  = true
    }
    prod = {
      sql_tier          = "db-custom-4-15360"
      sql_ha            = true
      sql_disk_gb       = 200
      redis_tier        = "STANDARD_HA"
      redis_memory_gb   = 2
      api_min_instances = 2
      api_max_instances = 20
      deletion_protect  = true
    }
  }
  size = lookup(local.sizes, local.env, local.sizes["dev"])

  name = "gp-${local.env}"
  labels = {
    app         = "getproperty"
    environment = local.env
    managed_by  = "terraform"
  }
}
