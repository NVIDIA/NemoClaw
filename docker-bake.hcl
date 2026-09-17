# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "IMAGE_PREFIX" {
  default = "nc-fabric"
}

# These locks contain native CPython ARM64 wheels. Other platforms need
# their own locks and qualification before they can be added here.
variable "HARNESSES" {
  default = {
    deepagents     = { stage = "generic", adapter = "deepagents", lock = "dependencies.lock" }
    claude         = { stage = "generic", adapter = "claude", lock = "claude-dependencies.lock" }
    codex          = { stage = "generic", adapter = "codex", lock = "codex-dependencies.lock" }
    mini-swe-agent = { stage = "mini-swe-agent", adapter = "mini-swe-agent", lock = "mini-swe-agent-dependencies.lock" }
    nooa           = { stage = "generic", adapter = "nooa", lock = "nooa-dependencies.lock" }
    nooa-bench     = { stage = "generic", adapter = "nooa", lock = "nooa-dependencies.lock" }
    remote-agent   = { stage = "generic", adapter = "remote-agent", lock = "remote-agent-dependencies.lock" }
    openclaw       = { stage = "openclaw", adapter = "", lock = "sdk-dependencies.lock" }
    hermes         = { stage = "hermes", adapter = "hermes", lock = "hermes-dependencies.lock" }
    pi             = { stage = "pi", adapter = "", lock = "sdk-dependencies.lock" }
  }
}

group "default" {
  targets = ["openclaw"]
}

target "_fabric" {
  context = "."
  dockerfile = "image/fabric/Dockerfile"
  platforms = ["linux/arm64"]
}

target "agents" {
  inherits = ["_fabric"]
  name = harness
  matrix = { harness = keys(HARNESSES) }
  target = HARNESSES[harness].stage
  args = merge({
    HARNESS = harness
    ADAPTER = HARNESSES[harness].adapter
    LOCKFILE = HARNESSES[harness].lock
  }, contains(["nooa", "nooa-bench", "hermes"], harness) ? {
    # The pinned Nooa and Hermes releases require Python <3.14.
    PYTHON_IMAGE = "python:3.13.15-slim-trixie@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285"
  } : {})
  tags = ["${IMAGE_PREFIX}:${harness}"]
}

# OpenClaw's native AMD64 dependency lock is separate from the ARM64 agent matrix.
target "openclaw-amd64" {
  inherits = ["_fabric"]
  target = "openclaw"
  platforms = ["linux/amd64"]
  args = {
    HARNESS = "openclaw"
    ADAPTER = ""
    LOCKFILE = "sdk-dependencies-linux-amd64.lock"
  }
  tags = ["${IMAGE_PREFIX}:openclaw-amd64"]
}

target "ollama-proxy" {
  context = "."
  dockerfile = "image/ollama-proxy/Dockerfile"
  platforms = ["linux/arm64"]
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
