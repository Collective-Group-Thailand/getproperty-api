output "environment" {
  value = local.env
}

output "service_urls" {
  value = {
    api    = module.run_api.uri
    worker = module.run_worker.uri
    ingest = module.run_ingest.uri
    web    = module.run_web.uri
    liff   = module.run_liff.uri
  }
}

output "buckets" {
  value = module.storage.buckets
}

output "sql_connection_name" {
  value = module.cloudsql.connection_name
}

output "emqx_cluster" {
  value = module.emqx.cluster_name
}
