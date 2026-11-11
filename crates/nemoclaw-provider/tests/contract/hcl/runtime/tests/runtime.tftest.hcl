# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Requested settings reach each runtime contract and the vLLM launch. The
# providers decode every contract they return with the runtime's own decoder;
# the schema snapshots and provider unit tests own rejected settings.

run "contracts" {
  command = plan

  assert {
    condition = (
      local.vllm.kind == "vllm"
      && local.vllm.model.repository == "Qwen/Qwen3-4B"
      && local.vllm.serving.modelName == "qwen"
      && local.vllm.serving.port == 18898
      && local.vllm.memory.gpuMemoryGiB == 20
    )
    error_message = "The vLLM contract must carry its settings: ${data.vllm_runtime.qwen.spec}"
  }

  assert {
    condition = (
      local.launch.entrypoint == tolist(["/usr/local/bin/nemoclaw-runtime"])
      && local.launch.port == 18898
      && local.launch.data_path == "/data"
      && local.launch.environment == tomap({ NEMOCLAW_RUNTIME_SPEC = data.vllm_runtime.qwen.spec })
    )
    error_message = "The vLLM launch must run the runtime with its contract on the serving port."
  }

  assert {
    condition = (
      local.requirements.gpu
      && local.requirements.gpu_count == 1
      && local.requirements.shared_memory_bytes == 8192 * 1048576
      && local.requirements.ulimits.memlock == -1
      && local.requirements.ulimits.stack == 67108864
    )
    error_message = "The vLLM requirements must ask for a GPU, shared memory, and its limits: ${jsonencode(local.requirements)}"
  }

  assert {
    condition = (
      jsondecode(data.ollama_runtime.qwen.spec).kind == "ollama"
      && jsondecode(data.ollama_runtime.qwen.spec).model.name == "qwen3:0.6b"
    )
    error_message = "The Ollama contract must carry its model: ${data.ollama_runtime.qwen.spec}"
  }

  assert {
    condition     = data.ollama_runtime.qwen.requirements.gpu_count == data.ollama_runtime.qwen.gpu_count
    error_message = "The Ollama requirements must report the gpu_count input: ${jsonencode(data.ollama_runtime.qwen.requirements)}"
  }

  assert {
    condition = jsondecode(data.ollama_proxy_runtime.qwen.spec) == {
      upstream = "http://127.0.0.1:11434/v1"
      endpoint = "http://127.0.0.1:11435/v1"
      model    = "qwen3:0.6b"
      digest   = "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435"
    }
    error_message = "The proxy contract is its whole configuration: ${data.ollama_proxy_runtime.qwen.spec}"
  }
}
