# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Runtime contracts the providers compute from typed settings, for any
# platform to place a container from: no engine, gateway, or SDK takes part.
terraform {
  required_providers {
    vllm   = { source = "registry.opentofu.org/nvidia/vllm" }
    ollama = { source = "registry.opentofu.org/nvidia/ollama" }
  }
}

data "vllm_runtime" "qwen" {
  hardware {
    profile = "dgx-spark"
  }
  model {
    repository = "Qwen/Qwen3-4B"
    revision   = "1cfa9a7208912126459214e8b04321603b3df60c"
  }
  serving {
    port             = 18898
    model_name       = "qwen"
    reasoning_parser = "qwen3"
  }
  memory {
    gpu_memory_gib = 20
  }
}

data "ollama_runtime" "qwen" {
  gpu_count = 1
  hardware {
    profile = "dgx-spark"
  }
  model {
    name   = "qwen3:0.6b"
    digest = "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435"
  }
  serving {
    context_tokens = 8192
  }
}

data "ollama_proxy_runtime" "qwen" {
  bind_address = "127.0.0.1:11435"
  upstream     = "http://127.0.0.1:11434/v1"
  model        = "qwen3:0.6b"
  digest       = "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435"
}

locals {
  vllm         = jsondecode(data.vllm_runtime.qwen.spec)
  launch       = data.vllm_runtime.qwen.launch
  requirements = data.vllm_runtime.qwen.requirements
}
