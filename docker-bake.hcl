# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "IMAGE_PREFIX" {
  default = "nc-fabric"
}

variable "AGENT_PLATFORM" {
  default = ""
  validation {
    condition = contains(["linux/arm64", "linux/amd64"], AGENT_PLATFORM)
    error_message = "Set AGENT_PLATFORM to linux/arm64 or linux/amd64."
  }
}

variable "PLATFORM_LOCKS" {
  default = {
    "linux/arm64" = {
      deepagents     = "dependencies.lock"
      claude         = "claude-dependencies.lock"
      codex          = "codex-dependencies.lock"
      mini-swe-agent = "mini-swe-agent-dependencies.lock"
      nooa           = "nooa-dependencies.lock"
      nooa-bench     = "nooa-dependencies.lock"
      remote-agent   = "remote-agent-dependencies.lock"
      openclaw       = "sdk-dependencies.lock"
      hermes         = "hermes-dependencies.lock"
      pi             = "sdk-dependencies.lock"
    }
    "linux/amd64" = {
      deepagents = "dependencies-linux-amd64.lock"
      openclaw   = "sdk-dependencies-linux-amd64.lock"
    }
  }
}

variable "HARNESSES" {
  default = {
    deepagents     = { stage = "generic", adapter = "deepagents" }
    claude         = { stage = "generic", adapter = "claude" }
    codex          = { stage = "generic", adapter = "codex" }
    mini-swe-agent = { stage = "generic", adapter = "mini-swe-agent" }
    nooa           = { stage = "generic", adapter = "nooa" }
    nooa-bench     = { stage = "generic", adapter = "nooa" }
    remote-agent   = { stage = "generic", adapter = "remote-agent" }
    openclaw       = { stage = "openclaw", adapter = "openclaw" }
    hermes         = { stage = "hermes", adapter = "hermes" }
    pi             = { stage = "pi", adapter = "" }
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
  matrix = { harness = keys(PLATFORM_LOCKS[AGENT_PLATFORM]) }
  target = HARNESSES[harness].stage
  args = merge({
    HARNESS = harness
    ADAPTER = HARNESSES[harness].adapter
    LOCKFILE = PLATFORM_LOCKS[AGENT_PLATFORM][harness]
  }, contains(["nooa", "nooa-bench", "hermes"], harness) ? {
    # The pinned Nooa and Hermes releases require Python <3.14.
    PYTHON_IMAGE = "python:3.13.15-slim-trixie@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285"
  } : {})
  tags = ["${IMAGE_PREFIX}:${harness}"]
}

target "ollama-proxy" {
  context = "."
  dockerfile = "image/ollama-proxy/Dockerfile"
  platforms = [AGENT_PLATFORM]
  target = "runtime"
  tags = ["${IMAGE_PREFIX}:ollama-proxy"]
}

# Checks use disposable build stages and never start deployed resources.
group "check" {
  targets = ["lint", "unit-tests", "pi-tests", "proxy-tests"]
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

target "pi-tests" {
  inherits = ["_fabric"]
  output = ["type=cacheonly"]
  target = "pi-build"
}

target "proxy-tests" {
  inherits = ["ollama-proxy"]
  output = ["type=cacheonly"]
  target = "test"
  tags = []
}
