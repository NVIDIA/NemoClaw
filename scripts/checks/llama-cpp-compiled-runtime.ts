// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Load the exact built lifecycle modules used by the shipped CLI. */
export function compiledLlamaCppRuntime() {
  return {
    cleanup:
      require("../../dist/lib/inference/local-model-profile/cleanup.js") as typeof import("../../src/lib/inference/local-model-profile/cleanup.ts"),
    installer:
      require("../../dist/lib/inference/llama-cpp/managed-installer.js") as typeof import("../../src/lib/inference/llama-cpp/managed-installer.ts"),
    state:
      require("../../dist/lib/inference/llama-cpp/managed-state.js") as typeof import("../../src/lib/inference/llama-cpp/managed-state.ts"),
    docker:
      require("../../dist/lib/onboard/runtime-provider/docker.js") as typeof import("../../src/lib/onboard/runtime-provider/docker.ts"),
    privateBridge:
      require("../../dist/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge.js") as typeof import("../../src/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge.ts"),
  } as const;
}
