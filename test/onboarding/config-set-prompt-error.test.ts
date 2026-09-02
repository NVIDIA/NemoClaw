// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/** Verify prompt branching and write effects directly against CLI source. */
const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;

function installMock(modulePath: string, exports: unknown): void {
  requireCache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  } as any;
}

/** Put an own property back exactly as captured, leaving it absent when it had none. */
function restoreOwnProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  Reflect.deleteProperty(target, key);
  Object.defineProperties(target, descriptor ? { [key]: descriptor } : {});
}

async function runConfigSetWithPrompt(prompt: () => Promise<string>) {
  const configPath = require.resolve("../../src/lib/sandbox/config");
  const openshellPath = require.resolve("../../src/lib/adapters/openshell/client");
  const registryPath = require.resolve("../../src/lib/state/registry");
  const shieldsPath = require.resolve("../../src/lib/shields");
  const shieldsAuditPath = require.resolve("../../src/lib/shields/audit");
  const timerBoundLockPath = require.resolve("../../src/lib/shields/timer-bound-lock");
  const lifecycleLockPath = require.resolve("../../src/lib/state/mcp-lifecycle-lock");
  const configLockPath = require.resolve("../../src/lib/shields/openclaw-config-lock");
  const privilegedExecPath = require.resolve("../../src/lib/sandbox/privileged-exec");
  const credentialStorePath = require.resolve("../../src/lib/credentials/store");
  const modulePaths = [
    configPath,
    openshellPath,
    registryPath,
    shieldsPath,
    shieldsAuditPath,
    timerBoundLockPath,
    lifecycleLockPath,
    configLockPath,
    privilegedExecPath,
    credentialStorePath,
  ];
  const cachedModules = new Map(
    modulePaths.map((modulePath) => [
      modulePath,
      Object.getOwnPropertyDescriptor(requireCache, modulePath),
    ]),
  );
  const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const configWrite = vi.fn(
    (_privileged: unknown, _action: string, options: { input?: string }) => ({
      issues: [],
      chattrApplied: true,
      configSha256: createHash("sha256")
        .update(options.input ?? "")
        .digest("hex"),
    }),
  );
  const auditWrite = vi.fn();
  let error: unknown;

  try {
    delete require.cache[configPath];
    installMock(openshellPath, {
      captureOpenshellCommand: () => ({
        status: 0,
        signal: null,
        output: "{}",
        stdout: "{}\n",
        stderr: "",
      }),
      runOpenshellCommand: vi.fn(),
    });
    installMock(registryPath, { getSandbox: () => null });
    installMock(shieldsPath, { isShieldsDown: () => true });
    installMock(shieldsAuditPath, { appendAuditEntry: auditWrite });
    installMock(timerBoundLockPath, {
      withTimerBoundShieldsMutationLock: (
        _sandboxName: string,
        _command: string,
        callback: () => unknown,
      ) => callback(),
    });
    installMock(lifecycleLockPath, {
      withSandboxMutationLock: (_sandboxName: string, callback: () => unknown) => callback(),
    });
    installMock(configLockPath, {
      runOpenClawConfigGuard: configWrite,
      validateOpenClawConfigCandidate: () => [],
    });
    installMock(privilegedExecPath, {
      capturePrivilegedSandboxCommand: () => Buffer.alloc(0),
      executePrivilegedSandboxCommand: () => ({
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
      resolvePrivilegedSandboxTarget: () => ({ resourceHandle: "container-id" }),
      withPrivilegedSandboxExecutionLease: <T>(
        _sandboxName: string,
        _operation: string,
        callback: () => T,
      ): T => callback(),
    });
    installMock(credentialStorePath, { prompt });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    vi.stubEnv("NEMOCLAW_CONFIG_ACCEPT_NEW_PATH", undefined);
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", undefined);

    const { configSet } = require("../../src/lib/sandbox/config");
    try {
      await configSet("prompt-test", { key: "new.path", value: "1" });
    } catch (caught) {
      error = caught;
    }
    return { auditWrite, configWrite, error };
  } finally {
    restoreOwnProperty(process.stdin, "isTTY", stdinTtyDescriptor);
    vi.unstubAllEnvs();
    for (const [modulePath, descriptor] of cachedModules) {
      restoreOwnProperty(requireCache, modulePath, descriptor);
    }
  }
}

describe("config set prompt answers", () => {
  it("reports EOF guidance without writing config", async () => {
    const promptError = Object.assign(new Error("prompt closed"), { code: "EOF" });
    const prompt = vi.fn(async () => {
      throw promptError;
    });
    const result = await runConfigSetWithPrompt(prompt);

    expect(result.error).toMatchObject({
      message: expect.stringContaining("No input available on stdin"),
    });
    expect(result.error).toMatchObject({
      message: expect.stringContaining("--config-accept-new-path"),
    });
    expect(prompt).toHaveBeenCalledWith("  Write this new key? [y/N] ");
    expect(result.configWrite).not.toHaveBeenCalled();
    expect(result.auditWrite).not.toHaveBeenCalled();
  });

  it("rethrows non-EOF prompt errors without writing config", async () => {
    const promptError = Object.assign(new Error("prompt interrupted"), { code: "SIGINT" });
    const prompt = vi.fn(async () => {
      throw promptError;
    });
    const result = await runConfigSetWithPrompt(prompt);

    expect(result.error).toBe(promptError);
    expect(prompt).toHaveBeenCalledWith("  Write this new key? [y/N] ");
    expect(result.configWrite).not.toHaveBeenCalled();
    expect(result.auditWrite).not.toHaveBeenCalled();
  });

  it("writes a new key after an affirmative answer", async () => {
    const prompt = vi.fn(async () => "yes");
    const result = await runConfigSetWithPrompt(prompt);

    expect(result.error).toBeUndefined();
    expect(prompt).toHaveBeenCalledWith("  Write this new key? [y/N] ");
    expect(result.configWrite).toHaveBeenCalledOnce();
    expect(result.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "config_set", sandbox: "prompt-test" }),
    );
  });

  it("aborts without writing after a negative answer", async () => {
    const prompt = vi.fn(async () => "no");
    const result = await runConfigSetWithPrompt(prompt);

    expect(result.error).toMatchObject({ message: "  Aborted." });
    expect(prompt).toHaveBeenCalledWith("  Write this new key? [y/N] ");
    expect(result.configWrite).not.toHaveBeenCalled();
    expect(result.auditWrite).not.toHaveBeenCalled();
  });
});
