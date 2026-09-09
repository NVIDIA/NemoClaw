// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_CONFIG } from "../../src/lib/sandbox/agent-config";
import {
  rotateSandboxToken,
  type RotateTokenDeps,
} from "../../src/lib/sandbox/config-rotate-token";

describe("config rotate-token", () => {
  it("rotates an OpenAI provider without a compatibility-profile mutation (#11229)", async () => {
    const appendAuditEntry = vi.fn();
    const captureOpenshellCommand = vi.fn();
    const runOpenshellCommand = vi.fn(
      (): ReturnType<RotateTokenDeps["runOpenshellCommand"]> =>
        ({ status: 0 }) as ReturnType<RotateTokenDeps["runOpenshellCommand"]>,
    );
    const saveCredential = vi.fn();
    const deps = {
      appendAuditEntry,
      captureOpenshellCommand,
      fail: (lines: string | readonly string[]): never => {
        throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
      },
      loadSession: () => ({
        sandboxName: "rotate-profile-test",
        credentialEnv: "OPENAI_API_KEY",
        provider: "inference",
        providerType: "openai",
      }),
      promptSecret: vi.fn().mockResolvedValue("rotation-secret"),
      resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
      runOpenshellCommand,
      saveCredential,
      validateName: vi.fn((name: string) => name),
    } satisfies RotateTokenDeps;

    await rotateSandboxToken("rotate-profile-test", {}, deps);

    expect(captureOpenshellCommand).not.toHaveBeenCalled();
    expect(saveCredential).toHaveBeenCalledWith("OPENAI_API_KEY", "rotation-secret");
    expect(runOpenshellCommand).toHaveBeenCalledOnce();
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rotate_token",
        sandbox: "rotate-profile-test",
        reason: "rotate-token openclaw:OPENAI_API_KEY",
      }),
    );
    expect(JSON.stringify(appendAuditEntry.mock.calls)).not.toContain("rotation-secret");
  });
});
