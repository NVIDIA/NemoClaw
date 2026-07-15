// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createPromptValidatedSandboxName } from "./sandbox-agent";

describe("sandbox name prompt", () => {
  it("checkpoints a validated name before returning it to onboarding (#6743)", async () => {
    const checkpointSandboxName = vi.fn();
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault: vi.fn(async () => "tm"),
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName,
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    await expect(promptValidatedSandboxName()).resolves.toBe("tm");
    expect(checkpointSandboxName).toHaveBeenCalledWith("tm");
  });
});
