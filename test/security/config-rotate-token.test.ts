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
      loadSandbox: () => null,
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
      loadSandbox: () => null,
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

  it.each([
    {
      missingField: "provider",
      route: {
        credentialEnv: "ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
        provider: null,
      },
      message: "registry entry has no inference provider",
    },
    {
      missingField: "credential environment variable",
      route: {
        credentialEnv: null,
        preferredInferenceApi: "anthropic-messages",
        provider: "anthropic-prod",
      },
      message: "has no credential environment variable",
    },
  ])(
    "rejects a registered route without its $missingField before credential side effects",
    async ({ message, route }) => {
      const loadSession = vi.fn();
      const promptSecret = vi.fn();
      const saveCredential = vi.fn();
      const runOpenshellCommand = vi.fn<RotateTokenDeps["runOpenshellCommand"]>();
      const captureOpenshellCommand = vi.fn<RotateTokenDeps["captureOpenshellCommand"]>();
      const resolveAgentConfig = vi.fn(() => DEFAULT_AGENT_CONFIG);
      const deps = {
        appendAuditEntry: vi.fn(),
        captureOpenshellCommand,
        fail: (lines: string | readonly string[]): never => {
          throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
        },
        loadSandbox: () => route,
        loadSession,
        promptSecret,
        resolveAgentConfig,
        runOpenshellCommand,
        saveCredential,
        validateName: vi.fn((name: string) => name),
      } satisfies RotateTokenDeps;

      await expect(rotateSandboxToken("rotate-profile-test", {}, deps)).rejects.toThrow(message);

      expect(loadSession).not.toHaveBeenCalled();
      expect(resolveAgentConfig).not.toHaveBeenCalled();
      expect(promptSecret).not.toHaveBeenCalled();
      expect(captureOpenshellCommand).not.toHaveBeenCalled();
      expect(saveCredential).not.toHaveBeenCalled();
      expect(runOpenshellCommand).not.toHaveBeenCalled();
    },
  );

  it("rotates the provider currently registered to the named sandbox instead of a stale session", async () => {
    const loadSession = vi.fn(() => ({
      sandboxName: "rotate-profile-test",
      credentialEnv: "OPENAI_API_KEY",
      provider: "openai-api",
      providerType: "openai",
    }));
    const runOpenshellCommand = vi
      .fn<RotateTokenDeps["runOpenshellCommand"]>()
      .mockReturnValueOnce({ status: 1 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>);
    const saveCredential = vi.fn();
    const deps = {
      appendAuditEntry: vi.fn(),
      captureOpenshellCommand: vi.fn(() => ({
        output: "openshell 0.0.116\n",
        status: 0,
        stderr: "",
        stdout: "openshell 0.0.116\n",
      })),
      fail: (lines: string | readonly string[]): never => {
        throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
      },
      loadSandbox: () => ({
        credentialEnv: "ANTHROPIC_API_KEY",
        endpointUrl: "https://anthropic-compatible.example.test",
        preferredInferenceApi: "anthropic-messages",
        provider: "compatible-anthropic-endpoint",
      }),
      loadSession,
      promptSecret: vi.fn().mockResolvedValue("current-route-secret"),
      resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
      runOpenshellCommand,
      saveCredential,
      validateName: vi.fn((name: string) => name),
    } satisfies RotateTokenDeps;

    await rotateSandboxToken("rotate-profile-test", {}, deps);

    expect(loadSession).not.toHaveBeenCalled();
    expect(saveCredential).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "current-route-secret");
    expect(runOpenshellCommand).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ["provider", "update", "compatible-anthropic-endpoint", "--credential", "ANTHROPIC_API_KEY"],
      expect.objectContaining({ env: { ANTHROPIC_API_KEY: "current-route-secret" } }),
    );
    expect(runOpenshellCommand).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [
        "provider",
        "create",
        "--name",
        "compatible-anthropic-endpoint",
        "--type",
        "anthropic",
        "--credential",
        "ANTHROPIC_API_KEY",
        "--config",
        "ANTHROPIC_BASE_URL=https://anthropic-compatible.example.test",
      ],
      expect.objectContaining({ env: { ANTHROPIC_API_KEY: "current-route-secret" } }),
    );
  });

  it("recreates a registered local NIM route with the onboarding-owned NVIDIA provider type", async () => {
    const runOpenshellCommand = vi
      .fn<RotateTokenDeps["runOpenshellCommand"]>()
      .mockReturnValueOnce({ status: 1 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>);
    const deps = {
      appendAuditEntry: vi.fn(),
      captureOpenshellCommand: vi.fn(() => ({
        output: "openshell 0.0.116\n",
        status: 0,
        stderr: "",
        stdout: "openshell 0.0.116\n",
      })),
      fail: (lines: string | readonly string[]): never => {
        throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
      },
      loadSandbox: () => ({
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        preferredInferenceApi: "openai-completions",
        provider: "nvidia-nim",
      }),
      loadSession: vi.fn(() => null),
      promptSecret: vi.fn().mockResolvedValue("current-route-secret"),
      resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
      runOpenshellCommand,
      saveCredential: vi.fn(),
      validateName: vi.fn((name: string) => name),
    } satisfies RotateTokenDeps;

    await rotateSandboxToken("rotate-profile-test", {}, deps);

    expect(runOpenshellCommand).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [
        "provider",
        "create",
        "--name",
        "nvidia-nim",
        "--type",
        "nvidia",
        "--credential",
        "NVIDIA_INFERENCE_API_KEY",
      ],
      expect.objectContaining({ env: { NVIDIA_INFERENCE_API_KEY: "current-route-secret" } }),
    );
  });

  it("recreates a registered compatible route with its gateway-reachable endpoint", async () => {
    const runOpenshellCommand = vi
      .fn<RotateTokenDeps["runOpenshellCommand"]>()
      .mockReturnValueOnce({ status: 1 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>);
    const deps = {
      appendAuditEntry: vi.fn(),
      captureOpenshellCommand: vi.fn(() => ({
        output: "openshell 0.0.116\n",
        status: 0,
        stderr: "",
        stdout: "openshell 0.0.116\n",
      })),
      fail: (lines: string | readonly string[]): never => {
        throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
      },
      loadSandbox: () => ({
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "http://127.0.0.1:11434/v1",
        preferredInferenceApi: "openai-completions",
        provider: "compatible-endpoint",
      }),
      loadSession: vi.fn(() => null),
      promptSecret: vi.fn().mockResolvedValue("current-route-secret"),
      resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
      runOpenshellCommand,
      saveCredential: vi.fn(),
      validateName: vi.fn((name: string) => name),
    } satisfies RotateTokenDeps;

    await rotateSandboxToken("rotate-profile-test", {}, deps);

    expect(runOpenshellCommand).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [
        "provider",
        "create",
        "--name",
        "compatible-endpoint",
        "--type",
        "openai",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        "OPENAI_BASE_URL=http://host.openshell.internal:11434/v1",
      ],
      expect.objectContaining({ env: { COMPATIBLE_API_KEY: "current-route-secret" } }),
    );
  });

  it("refuses to recreate an endpoint-backed registered provider without its endpoint", async () => {
    const appendAuditEntry = vi.fn();
    const runOpenshellCommand = vi
      .fn<RotateTokenDeps["runOpenshellCommand"]>()
      .mockReturnValue({ status: 1 } as ReturnType<RotateTokenDeps["runOpenshellCommand"]>);
    const deps = {
      appendAuditEntry,
      captureOpenshellCommand: vi.fn(() => ({
        output: "openshell 0.0.116\n",
        status: 0,
        stderr: "",
        stdout: "openshell 0.0.116\n",
      })),
      fail: (lines: string | readonly string[]): never => {
        throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
      },
      loadSandbox: () => ({
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        provider: "compatible-endpoint",
      }),
      loadSession: vi.fn(() => null),
      promptSecret: vi.fn().mockResolvedValue("current-route-secret"),
      resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
      runOpenshellCommand,
      saveCredential: vi.fn(),
      validateName: vi.fn((name: string) => name),
    } satisfies RotateTokenDeps;

    await expect(rotateSandboxToken("rotate-profile-test", {}, deps)).rejects.toThrow(
      "without its endpoint",
    );

    expect(runOpenshellCommand).toHaveBeenCalledOnce();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});
