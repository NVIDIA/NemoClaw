# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Retained storage keeps the identity it is created with: the volume carries
# it, a refresh reads it back, and a generated identity is generated once.

run "create" {}

# Applies the same configuration again and reads the engine.
run "reapply" {
  assert {
    condition     = local.engine.creates == 3
    error_message = "Reapplying must keep every volume: ${local.engine.creates} created."
  }
  assert {
    condition = (
      vllm_credential_storage.authored.id == "engine/nc-0123456789abcdef-inference-qwen-auth/2026-10-08T00:00:00Z"
      && local.engine.volumes["nc-0123456789abcdef-inference-qwen-auth"].Labels["nemoclaw.nvidia.com/uid"] == var.owner
    )
    error_message = "Authored storage must be the volume labeled with its owner."
  }
  assert {
    condition = (
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$", vllm_credential_storage.generated.owner))
      && can(regex("^[0-9a-f]{32}$", vllm_credential_storage.generated.generation))
    )
    error_message = "An omitted owner must be a random UUID and an omitted generation 32 hexadecimal characters."
  }
  assert {
    condition = alltrue([
      for storage in [
        { volume = "generated-credentials", resource = vllm_credential_storage.generated },
        { volume = "generated-proxy-auth", resource = ollama_proxy_credential_storage.generated },
      ] : local.engine.volumes[storage.volume].Labels["nemoclaw.nvidia.com/uid"] == storage.resource.owner
      && local.engine.volumes[storage.volume].Labels["nemoclaw.nvidia.com/generation"] == storage.resource.generation
    ])
    error_message = "Each volume must carry the identity its storage generated once."
  }
}
