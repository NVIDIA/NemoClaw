// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createPromptValidatedSandboxName } from "./sandbox-agent";

describe("sandbox name prompt", () => {
  it("waits for a validated-name checkpoint before returning it to onboarding (#8687)", async () => {
    let release: (() => void) | undefined;
    const checkpointStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let persisted = false;
    const checkpointSandboxName = vi.fn(async () => {
      await checkpointStarted;
      persisted = true;
    });
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault: vi.fn(async () => "tm"),
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName,
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    const result = promptValidatedSandboxName();
    await Promise.resolve();
    expect(persisted).toBe(false);
    release?.();
    await expect(result).resolves.toBe("tm");
    expect(persisted).toBe(true);
    expect(checkpointSandboxName).toHaveBeenCalledWith("tm", null);
  });

  it("propagates a checkpoint failure without treating the name as invalid (#6743)", async () => {
    const checkpointError = new Error("session write failed");
    const promptOrDefault = vi.fn(async () => "tm");
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault,
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName: async () => {
        throw checkpointError;
      },
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    await expect(promptValidatedSandboxName()).rejects.toBe(checkpointError);
    expect(promptOrDefault).toHaveBeenCalledTimes(1);
  });
});
