# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Runtime contracts the providers compute from typed settings, for any
# platform to place a container from: no engine, gateway, or SDK takes part.
terraform {
  required_providers {
    vllm   = { source = "nvidia.github.io/nemoclaw/vllm" }
    ollama = { source = "nvidia.github.io/nemoclaw/ollama" }
  }
}

data "vllm_nim_runtime" "llama" {
  backend = "vllm"
  hardware {
    architecture = "amd64"
    min_compute_capability = 89
    min_driver_major = 580
    min_gpu_memory_bytes = 42949672960
  }
  model {
    name = "meta/llama-3.1-8b-instruct"
    profile = "092ed4213624e774d24cdaf84e3b6222839bab2008a21d3c214ab46626366f90"
    min_gpu_memory_bytes = 33000000000
    cache_bytes = 34359738368
  }
  authentication = "bearer"
  memory {
    gpu_memory_gib = 40
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

# Same provider and placement contract; llama.cpp owns the typed GGUF settings.
data "vllm_llama_cpp_runtime" "muse" {
  hardware {
    architecture = "amd64"
    min_compute_capability = 89
    min_gpu_memory_bytes = 34359738368
    min_driver_major = 580
  }
  model {
    repository = "meta-models/Muse-Glimmer-30B-GGUF"
    revision = "43c7eadd41352a299ea8e0a36b3157978dd63596"
    file = "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf"
    sha256 = "4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e"
    size_bytes = 16756683904
  }
  authentication = "bearer"
  serving {
    model_name = "muse-glimmer"
    reasoning_strength = "low"
    port = 18899
  }
  memory {
    gpu_memory_gib = 32
  }
}
