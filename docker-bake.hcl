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

variable "HARNESSES" {
  default = {
    deepagents     = { stage = "deepagents", adapter = "deepagents", adapter_id = "nvidia.fabric.langchain.deepagents", extra = "deepagents" }
    claude         = { stage = "generic", adapter = "claude", adapter_id = "nvidia.fabric.claude", extra = "claude" }
    codex          = { stage = "codex", adapter = "codex", adapter_id = "nvidia.fabric.codex", extra = "codex" }
    mini-swe-agent = { stage = "mini-swe-agent", adapter = "mini-swe-agent", adapter_id = "nvidia.fabric.mini-swe-agent", extra = "mini-swe-agent" }
    nooa           = { stage = "generic", adapter = "nooa", adapter_id = "nvidia.fabric.nooa", extra = "nooa", targets = "nvidia.nooa.arc-solver nvidia.nooa.coding-agent" }
    nooa-bench     = { stage = "generic", adapter = "nooa", adapter_id = "nvidia.fabric.nooa.bench-agent", extra = "nooa" }
    remote-agent   = { stage = "generic", adapter = "remote-agent", adapter_id = "nvidia.fabric.remote-agent", extra = "remote-agent" }
    openclaw       = { stage = "openclaw", adapter = "openclaw", adapter_id = "nvidia.fabric.openclaw", extra = "openclaw" }
    hermes         = { stage = "hermes", adapter = "hermes", adapter_id = "nvidia.fabric.hermes", extra = "hermes-agent" }
    pi             = { stage = "pi", adapter = "", adapter_id = "nvidia.fabric.pi", extra = "" }
    opencode       = { stage = "opencode", adapter = "", adapter_id = "nvidia.fabric.opencode", extra = "" }
  }
}

group "default" {
  targets = ["openclaw"]
}

target "_fabric" {
  context = "."
  # The remote sources that versions.json pins for this image, which
  # `cargo images fetch` and `cargo images build` place here.
  contexts = { sources = ".build/image-sources/fabric" }
  dockerfile = "image/fabric/Dockerfile"
  platforms = [AGENT_PLATFORM]
  # Docker's containerd image store would otherwise push each platform's
  # image as an index with a provenance attestation, whose manifest a node
  # that pulls one platform doesn't hold. Release attestations come from
  # release-attest.yml instead.
  attest = ["type=provenance,disabled=true"]
}

target "agents" {
  inherits = ["_fabric"]
  name = harness
  matrix = { harness = keys(HARNESSES) }
  target = HARNESSES[harness].stage
  args = {
    HARNESS = harness
    ADAPTER = HARNESSES[harness].adapter
    # The Fabric extra whose locked dependencies the image installs.
    EXTRA = HARNESSES[harness].extra
    ADAPTER_ID = HARNESSES[harness].adapter_id
    # The workflow targets the generic stage declares for the adapter.
    TARGET_IDS = lookup(HARNESSES[harness], "targets", "")
    # The stage that `cargo images build` catalogs and labels.
    STAGE = HARNESSES[harness].stage
  }
  tags = ["${IMAGE_PREFIX}:${harness}"]
}

# The agent images a release stages. claude stays out: its claude-agent-sdk
# wheels bundle Anthropic's proprietary Claude Code CLI, which NVIDIA has no
# permission to redistribute (#13524). CI still builds and checks it with the
# other agents, and users build it locally.
group "release-agents" {
  targets = [for harness in keys(HARNESSES) : harness if harness != "claude"]
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
  contexts = { supervisor = "target:supervisor", sources = ".build/image-sources/vllm" }
  dockerfile = "image/vllm/Dockerfile"
  tags = ["nc-prototype-vllm:rust-v1"]
}

target "ollama" {
  inherits = ["_runtime"]
  contexts = { supervisor = "target:supervisor", sources = ".build/image-sources/ollama" }
  dockerfile = "image/ollama/Dockerfile"
  tags = ["nc-prototype-ollama:rust-v1"]
}

target "llama-cpp" {
  inherits = ["_runtime"]
  contexts = { supervisor = "target:supervisor", sources = ".build/image-sources/llama-cpp" }
  dockerfile = "image/llama-cpp/Dockerfile"
  tags = ["nc-prototype-llama-cpp:rust-v1"]
}

target "nim" {
  inherits = ["_runtime"]
  dockerfile = "image/nim/Dockerfile"
  tags = ["nc-prototype-nim:rust-v1"]
}

group "runtimes" {
  targets = ["vllm", "ollama", "llama-cpp"]
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
