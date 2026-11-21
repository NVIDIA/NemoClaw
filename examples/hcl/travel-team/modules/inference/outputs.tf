# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Each server, as an inference registration takes it. The readiness read's ref
# reports the local server's values only during apply when the server changes;
# a registration taking that ref would be replaced, which OpenShell refuses
# while sandboxes attach it. The local server is therefore a literal object
# that depends on the read, so a registration that takes it waits until the
# model is ready.
output "local_server" {
  description = "The local model's server, at the address sandboxes use, without a credential."
  value = {
    type              = "inference_server"
    endpoint          = local.sandbox_endpoint
    credential_env    = ""
    credential_source = ""
  }
  depends_on = [data.ollama_readiness.local]
}

# NemoClaw doesn't run the hosted model, so nothing checks it. OpenShell reads
# the key from credential_env during apply; the key never enters OpenTofu
# state.
output "frontier_server" {
  description = "The hosted model's server, with the variable holding its key on the machine running OpenTofu."
  value = {
    type              = "inference_server"
    endpoint          = var.frontier.endpoint
    credential_env    = var.frontier.credential_env
    credential_source = ""
  }
}

output "models" {
  description = "Each model's name and the base URL sandboxes reach it at, by model: local and frontier."
  value = {
    local    = { name = var.local_model.name, endpoint = local.sandbox_endpoint }
    frontier = { name = var.frontier.model, endpoint = var.frontier.endpoint }
  }
}
