# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "IMAGE_PREFIX" {
  default = "nc-fabric"
}

# Agent images build for this host's platform unless AGENT_PLATFORM selects
# the other one.
variable "AGENT_PLATFORM" {
  default = regex_replace(BAKE_LOCAL_PLATFORM, "/v[0-9]+$", "")
  validation {
    condition = contains(["linux/arm64", "linux/amd64"], AGENT_PLATFORM)
    error_message = "Set AGENT_PLATFORM to linux/arm64 or linux/amd64."
  }
}

variable "PLATFORM_HARNESSES" {
  default = {
    "linux/arm64" = ["deepagents", "claude", "codex", "mini-swe-agent", "nooa", "nooa-bench", "remote-agent", "openclaw", "hermes", "pi"]
    "linux/amd64" = ["deepagents", "claude", "codex", "mini-swe-agent", "nooa", "nooa-bench", "remote-agent", "openclaw", "hermes", "pi"]
  }
}

variable "HARNESSES" {
  default = {
    deepagents     = { stage = "generic", adapter = "deepagents", adapter_id = "nvidia.fabric.langchain.deepagents", extra = "deepagents" }
    claude         = { stage = "generic", adapter = "claude", adapter_id = "nvidia.fabric.claude", extra = "claude" }
    codex          = { stage = "generic", adapter = "codex", adapter_id = "nvidia.fabric.codex", extra = "codex" }
    mini-swe-agent = { stage = "generic", adapter = "mini-swe-agent", adapter_id = "nvidia.fabric.mini-swe-agent", extra = "mini-swe-agent" }
    nooa           = { stage = "generic", adapter = "nooa", adapter_id = "nvidia.fabric.nooa", extra = "nooa" }
    nooa-bench     = { stage = "generic", adapter = "nooa", adapter_id = "nvidia.fabric.nooa.bench-agent", extra = "nooa" }
    remote-agent   = { stage = "generic", adapter = "remote-agent", adapter_id = "nvidia.fabric.remote-agent", extra = "remote-agent" }
    openclaw       = { stage = "openclaw", adapter = "openclaw", adapter_id = "nvidia.fabric.openclaw", extra = "openclaw" }
    hermes         = { stage = "hermes", adapter = "hermes", adapter_id = "nvidia.fabric.hermes", extra = "hermes-agent" }
    pi             = { stage = "pi", adapter = "", adapter_id = "nvidia.fabric.pi", extra = "" }
  }
}

group "default" {
  targets = ["openclaw"]
}

target "_fabric" {
  context = "."
  dockerfile = "image/fabric/Dockerfile"
  platforms = [AGENT_PLATFORM]
}

target "agents" {
  inherits = ["_fabric"]
  name = harness
  matrix = { harness = PLATFORM_HARNESSES[AGENT_PLATFORM] }
  target = HARNESSES[harness].stage
  args = {
    HARNESS = harness
    ADAPTER = HARNESSES[harness].adapter
    # The Fabric extra whose locked dependencies the image installs.
    EXTRA = HARNESSES[harness].extra
    ADAPTER_ID = HARNESSES[harness].adapter_id
    # The stage that `cargo images build` catalogs and labels.
    STAGE = HARNESSES[harness].stage
  }
  tags = ["${IMAGE_PREFIX}:${harness}"]
}

target "ollama-proxy" {
  context = "."
  dockerfile = "image/ollama-proxy/Dockerfile"
  platforms = [AGENT_PLATFORM]
  target = "runtime"
  tags = ["${IMAGE_PREFIX}:ollama-proxy"]
}

# Runtime images always build for the host's platform, so the supervisor
# compiles natively. Fixed timestamps keep a rebuild of the same sources at the
# same digest, which deployments pin.
variable "SOURCE_DATE_EPOCH" {
  default = "1789689600"
}

target "supervisor" {
  context = "."
  dockerfile = "image/supervisor/Dockerfile"
  target = "supervisor"
  platforms = [BAKE_LOCAL_PLATFORM]
  args = { SOURCE_DATE_EPOCH = SOURCE_DATE_EPOCH }
}

target "_runtime" {
  context = "."
  contexts = { supervisor = "target:supervisor" }
  platforms = [BAKE_LOCAL_PLATFORM]
  args = { SOURCE_DATE_EPOCH = SOURCE_DATE_EPOCH }
  attest = ["type=provenance,disabled=true"]
  # Docker's containerd image store can't unpack while rewriting timestamps;
  # it unpacks the image when a container first runs it.
  output = ["type=docker,rewrite-timestamp=true,unpack=false"]
}

target "vllm" {
  inherits = ["_runtime"]
  dockerfile = "image/vllm/Dockerfile"
  tags = ["nc-prototype-vllm:rust-v1"]
}

target "ollama" {
  inherits = ["_runtime"]
  dockerfile = "image/ollama/Dockerfile"
  tags = ["nc-prototype-ollama:rust-v1"]
}

group "runtimes" {
  targets = ["vllm", "ollama"]
}

# Checks use disposable build stages and never start deployed resources.
group "check" {
  targets = ["lint", "unit-tests", "reference-tests", "proxy-tests"]
}

target "lint" {
  inherits = ["_fabric"]
  output = ["type=cacheonly"]
  target = "lint"
}

target "unit-tests" {
  inherits = ["_fabric"]
  output = ["type=cacheonly"]
  target = "unit-tests"
}

target "proxy-tests" {
  inherits = ["ollama-proxy"]
  output = ["type=cacheonly"]
  target = "test"
  tags = []
}

# The reference image runs Fabric with only NemoClaw's test adapter, no production one.
target "dummy" {
  inherits = ["_fabric"]
  target = "dummy"
  args = { HARNESS = "dummy", STAGE = "dummy" }
  tags = ["${IMAGE_PREFIX}:dummy"]
}

target "reference-tests" {
  inherits = ["_fabric"]
  target = "reference-tests"
  args = { HARNESS = "dummy" }
  output = ["type=cacheonly"]
}
