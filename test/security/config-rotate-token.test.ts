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
    const captureOpenshellCommand = vi.fn(() => ({
      output: "openshell 0.0.116\n",
      status: 0,
      stderr: "",
      stdout: "openshell 0.0.116\n",
    }));
    const runOpenshellCommand = vi.fn<RotateTokenDeps["runOpenshellCommand"]>(
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

    expect(captureOpenshellCommand).toHaveBeenCalledOnce();
    expect(captureOpenshellCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["--version"],
      expect.objectContaining({ ignoreError: true, includeStreams: true }),
    );
    expect(JSON.stringify(captureOpenshellCommand.mock.calls)).not.toContain("rotation-secret");
    expect(saveCredential).toHaveBeenCalledWith("OPENAI_API_KEY", "rotation-secret");
    expect(runOpenshellCommand).toHaveBeenCalledOnce();
    expect(runOpenshellCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["provider", "update", "inference", "--credential", "OPENAI_API_KEY"],
      expect.objectContaining({ env: { OPENAI_API_KEY: "rotation-secret" } }),
    );
    expect(runOpenshellCommand.mock.calls[0]?.[1]).not.toContain("rotation-secret");
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rotate_token",
        sandbox: "rotate-profile-test",
        reason: "rotate-token openclaw:OPENAI_API_KEY",
      }),
    );
    expect(JSON.stringify(appendAuditEntry.mock.calls)).not.toContain("rotation-secret");
  });

  it("fails closed before saving or forwarding a token to an unqualified runtime (#11229)", async () => {
    const captureOpenshellCommand = vi.fn(() => ({
      output: "openshell 0.0.106\n",
      status: 0,
      stderr: "",
      stdout: "openshell 0.0.106\n",
    }));
    const runOpenshellCommand = vi.fn<RotateTokenDeps["runOpenshellCommand"]>();
    const saveCredential = vi.fn();
    const deps = {
      appendAuditEntry: vi.fn(),
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

    await expect(rotateSandboxToken("rotate-profile-test", {}, deps)).rejects.toThrow(
      "expected 0.0.116, actual 0.0.106",
    );

    expect(captureOpenshellCommand).toHaveBeenCalledOnce();
    expect(JSON.stringify(captureOpenshellCommand.mock.calls)).not.toContain("rotation-secret");
    expect(saveCredential).not.toHaveBeenCalled();
    expect(runOpenshellCommand).not.toHaveBeenCalled();
  });
});
