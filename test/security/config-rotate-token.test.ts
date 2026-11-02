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
      output: "openshell 0.1.5\n",
      status: 0,
      stderr: "",
      stdout: "openshell 0.1.5\n",
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
      "expected 0.1.5, actual 0.0.106",
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

  it("updates an endpoint-backed session without recreation metadata (#12940)", async () => {
    const promptSecret = vi.fn().mockResolvedValue("rotation-secret");
    const saveCredential = vi.fn();
    const runOpenshellCommand = vi.fn<RotateTokenDeps["runOpenshellCommand"]>(
      () => ({ status: 0 }) as ReturnType<RotateTokenDeps["runOpenshellCommand"]>,
    );
    const captureOpenshellCommand = vi.fn(() => ({
      output: "openshell 0.1.5\n",
      status: 0,
      stderr: "",
      stdout: "openshell 0.1.5\n",
    }));
    const deps = {
      appendAuditEntry: vi.fn(),
      captureOpenshellCommand,
      fail: (lines: string | readonly string[]): never => {
        throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
      },
      loadSandbox: () => null,
      loadSession: () => ({
        sandboxName: "rotate-profile-test",
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://compatible.example.test/v1",
        provider: "compatible-endpoint",
      }),
      promptSecret,
      resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
      runOpenshellCommand,
      saveCredential,
      validateName: vi.fn((name: string) => name),
    } satisfies RotateTokenDeps;

    await rotateSandboxToken("rotate-profile-test", {}, deps);

    expect(runOpenshellCommand).toHaveBeenCalledOnce();
    expect(runOpenshellCommand.mock.calls[0]?.[1]).toEqual([
      "provider",
      "update",
      "compatible-endpoint",
      "--credential",
      "COMPATIBLE_API_KEY",
    ]);
    expect(saveCredential).toHaveBeenCalledWith("COMPATIBLE_API_KEY", "rotation-secret");
  });

  it.each([
    {
      message: "is not bound to sandbox 'rotate-profile-test'",
      sessionSandboxName: null,
    },
    {
      message: "is for sandbox 'another-sandbox', not 'rotate-profile-test'",
      sessionSandboxName: "another-sandbox",
    },
  ])(
    "rejects an onboard session with sandbox binding $sessionSandboxName before credential side effects",
    async ({ message, sessionSandboxName }) => {
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
        loadSandbox: () => null,
        loadSession: () => ({
          sandboxName: sessionSandboxName,
          credentialEnv: "OPENAI_API_KEY",
          provider: "inference",
          providerType: "openai",
        }),
        promptSecret,
        resolveAgentConfig,
        runOpenshellCommand,
        saveCredential,
        validateName: vi.fn((name: string) => name),
      } satisfies RotateTokenDeps;

      await expect(rotateSandboxToken("rotate-profile-test", {}, deps)).rejects.toThrow(message);

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
    const runOpenshellCommand = vi.fn<RotateTokenDeps["runOpenshellCommand"]>(
      () => ({ status: 0 }) as ReturnType<RotateTokenDeps["runOpenshellCommand"]>,
    );
    const saveCredential = vi.fn();
    const deps = {
      appendAuditEntry: vi.fn(),
      captureOpenshellCommand: vi.fn(() => ({
        output: "openshell 0.1.5\n",
        status: 0,
        stderr: "",
        stdout: "openshell 0.1.5\n",
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
    expect(runOpenshellCommand).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "registered native provider",
      route: {
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        provider: "nvidia-nim",
      },
      session: null,
      providerName: "nvidia-nim",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      status: 1,
    },
    {
      label: "registered compatible endpoint",
      route: {
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://compatible.example.test/v1",
        provider: "compatible-endpoint",
      },
      session: null,
      providerName: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
      status: null,
    },
    {
      label: "legacy session provider",
      route: null,
      session: {
        sandboxName: "rotate-profile-test",
        credentialEnv: "OPENAI_API_KEY",
        provider: "inference",
      },
      providerName: "inference",
      credentialEnv: "OPENAI_API_KEY",
      status: 1,
    },
  ])(
    "stops after an unconfirmed $label update without creating a provider (#12940)",
    async ({ route, session, providerName, credentialEnv, status }) => {
      const appendAuditEntry = vi.fn();
      const saveCredential = vi.fn();
      const runOpenshellCommand = vi.fn<RotateTokenDeps["runOpenshellCommand"]>(
        () => ({ status }) as ReturnType<RotateTokenDeps["runOpenshellCommand"]>,
      );
      const deps = {
        appendAuditEntry,
        captureOpenshellCommand: vi.fn(() => ({
          output: "openshell 0.1.5\n",
          status: 0,
          stderr: "",
          stdout: "openshell 0.1.5\n",
        })),
        fail: (lines: string | readonly string[]): never => {
          throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
        },
        loadSandbox: () => route,
        loadSession: () => session,
        promptSecret: vi.fn().mockResolvedValue("rotation-secret"),
        resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
        runOpenshellCommand,
        saveCredential,
        validateName: vi.fn((name: string) => name),
      } satisfies RotateTokenDeps;

      const failure = await rotateSandboxToken("rotate-profile-test", {}, deps).then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      expect(failure).toContain(
        `Could not confirm the token update for provider '${providerName}'`,
      );
      expect(failure).toContain("Inspect the OpenShell provider before retrying");
      expect(failure).not.toContain("rotation-secret");
      expect(runOpenshellCommand).toHaveBeenCalledOnce();
      expect(runOpenshellCommand.mock.calls[0]?.[1]).toEqual([
        "provider",
        "update",
        providerName,
        "--credential",
        credentialEnv,
      ]);
      expect(runOpenshellCommand.mock.calls[0]?.[2]).toMatchObject({
        env: { [credentialEnv]: "rotation-secret" },
      });
      expect(saveCredential).not.toHaveBeenCalled();
      expect(appendAuditEntry).not.toHaveBeenCalled();
    },
  );
});
