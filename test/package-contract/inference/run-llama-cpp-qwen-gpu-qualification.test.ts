// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { compiledLlamaCppRuntime } from "../../../scripts/checks/llama-cpp-compiled-runtime.ts";

describe("Qwen llama.cpp RTX compiled lifecycle", () => {
  it("loads the built production llama.cpp lifecycle used by the runner", () => {
    const compiled = compiledLlamaCppRuntime();
    expect(compiled.installer.MANAGED_LLAMA_CPP_CONTAINER_NAME).toBe("nemoclaw-llama-cpp");
    expect(compiled.installer.installManagedLlamaCpp).toEqual(expect.any(Function));
    expect(compiled.privateBridge.createDockerLlamaCppPrivateBridgeController).toEqual(
      expect.any(Function),
    );
  });
});
