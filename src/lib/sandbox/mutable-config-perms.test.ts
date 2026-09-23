// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  capturePrivilegedSandboxCommand,
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
  resolveAgentConfig,
  withMcpLifecycleLockSync,
} = vi.hoisted(() => ({
  capturePrivilegedSandboxCommand: vi.fn(),
  executePrivilegedSandboxCommand: vi.fn(),
  resolvePrivilegedSandboxTarget: vi.fn(),
  resolveAgentConfig: vi.fn(),
  withMcpLifecycleLockSync: vi.fn((_name, action) => action()),
}));

vi.mock("./privileged-exec", () => ({
  capturePrivilegedSandboxCommand,
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
}));
vi.mock("./agent-config", () => ({ resolveAgentConfig }));
vi.mock("../state/mcp-lifecycle-lock-acquisition", () => ({ withMcpLifecycleLockSync }));

import type { AgentConfigTarget } from "./agent-config";
import {
  inspectMutableConfigPerms,
  repairMutableConfigPerms,
  verifyMutableHermesConfigForTarget,
} from "./mutable-config-perms";

const target: AgentConfigTarget = {
  agentName: "openclaw",
  configDir: "/sandbox/.openclaw",
  configFile: "openclaw.json",
  configPath: "/sandbox/.openclaw/openclaw.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};
const hermesTarget: AgentConfigTarget = {
  agentName: "hermes",
  configDir: "/sandbox/.hermes",
  configFile: "config.yaml",
  configPath: "/sandbox/.hermes/config.yaml",
  format: "yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
};
const intactGuard = JSON.stringify({
  type: "result",
  action: "preflight-restart",
  status: "ok",
  configDir: target.configDir,
  files: ["openclaw.json", ".config-hash"],
});
function guardFailure(code: string) {
  return [
    { type: "issue", code, path: target.configDir, detail: code },
    { type: "result", action: "preflight-restart", status: "failed" },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
}
function guardResult(stdout = intactGuard, status = 0) {
  return { status, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

describe("mutable OpenClaw config permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentConfig.mockReturnValue(target);
    resolvePrivilegedSandboxTarget.mockReturnValue({
      providerId: "podman",
      resourceHandle: "pinned-container",
    });
    executePrivilegedSandboxCommand.mockReset().mockReturnValue(guardResult());
    capturePrivilegedSandboxCommand.mockReset();
  });

  it("uses the guard verdict without a second fixed-mode contract", () => {
    expect(inspectMutableConfigPerms("alpha")).toEqual({
      applies: true,
      ok: true,
      issues: [],
    });
    expect(repairMutableConfigPerms("alpha")).toEqual({
      applied: true,
      verified: true,
      errors: [],
    });
    expect(capturePrivilegedSandboxCommand).not.toHaveBeenCalled();
    expect(executePrivilegedSandboxCommand).toHaveBeenCalledWith(
      "alpha",
      expect.arrayContaining(["preflight-restart", "--config-dir", target.configDir]),
      expect.objectContaining({
        sanitizeEnvironment: true,
        expectedResourceHandle: "pinned-container",
      }),
    );
  });

  it("does not apply to another agent", () => {
    resolveAgentConfig.mockReturnValue(hermesTarget);
    expect(inspectMutableConfigPerms("alpha")).toEqual({
      applies: false,
      skipReason: "agent",
      reason: "agent hermes does not use the mutable OpenClaw config contract",
    });
    expect(repairMutableConfigPerms("alpha")).toEqual({
      applied: false,
      skipReason: "agent",
      reason: "agent hermes does not use the mutable OpenClaw config contract",
    });
    expect(resolvePrivilegedSandboxTarget).not.toHaveBeenCalled();
  });

  it("reports an unavailable config tree without weakening the result", () => {
    executePrivilegedSandboxCommand.mockImplementationOnce(() => {
      throw new Error("container stopped");
    });

    expect(inspectMutableConfigPerms("alpha")).toEqual({
      applies: false,
      skipReason: "unavailable",
      reason: "could not verify config posture (container stopped)",
    });
  });

  it("does not normalize a posture the guard refuses to repair", () => {
    executePrivilegedSandboxCommand.mockReturnValue(
      guardResult(guardFailure("unsupported-config-posture"), 1),
    );
    expect(inspectMutableConfigPerms("alpha")).toMatchObject({
      applies: false,
      skipReason: "unavailable",
    });
    expect(repairMutableConfigPerms("alpha")).toMatchObject({ applied: true, verified: false });
    expect(capturePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("reports a normalizer failure without claiming verification", () => {
    executePrivilegedSandboxCommand.mockReturnValueOnce(
      guardResult(guardFailure("invalid-restart-posture"), 1),
    );
    capturePrivilegedSandboxCommand
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockImplementationOnce(() => {
        throw new Error("chmod failed");
      });
    expect(repairMutableConfigPerms("alpha")).toEqual({
      applied: true,
      verified: false,
      errors: ["chmod failed"],
    });
  });

  it("routes mutable config repair through provider-neutral privileged commands", () => {
    executePrivilegedSandboxCommand
      .mockReturnValueOnce(guardResult(guardFailure("invalid-restart-posture"), 1))
      .mockReturnValueOnce(guardResult());
    capturePrivilegedSandboxCommand
      .mockReset()
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockReturnValueOnce(Buffer.alloc(0));

    expect(repairMutableConfigPerms("alpha")).toEqual({
      applied: true,
      verified: true,
      errors: [],
    });
    expect(capturePrivilegedSandboxCommand).toHaveBeenNthCalledWith(
      1,
      "alpha",
      ["/usr/bin/id", "-u", "sandbox"],
      { sanitizeEnvironment: true, expectedResourceHandle: "pinned-container", timeout: 15_000 },
    );
    expect(capturePrivilegedSandboxCommand).toHaveBeenNthCalledWith(
      2,
      "alpha",
      ["/usr/bin/id", "-g", "sandbox"],
      { sanitizeEnvironment: true, expectedResourceHandle: "pinned-container", timeout: 15_000 },
    );
    expect(capturePrivilegedSandboxCommand).toHaveBeenNthCalledWith(
      3,
      "alpha",
      expect.arrayContaining([
        "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py",
        target.configDir,
        "1000",
        "1001",
      ]),
      { sanitizeEnvironment: true, expectedResourceHandle: "pinned-container", timeout: 25_000 },
    );
    expect(resolvePrivilegedSandboxTarget).toHaveBeenCalledOnce();
    expect(withMcpLifecycleLockSync).toHaveBeenCalledOnce();
    expect(executePrivilegedSandboxCommand).toHaveBeenCalledTimes(2);
  });

  it("does not verify repair when the final guard rejects it", () => {
    executePrivilegedSandboxCommand.mockReturnValue(
      guardResult(guardFailure("config-not-mutable"), 1),
    );
    capturePrivilegedSandboxCommand
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockReturnValueOnce(Buffer.alloc(0));
    expect(repairMutableConfigPerms("alpha")).toMatchObject({ applied: true, verified: false });
    expect(executePrivilegedSandboxCommand).toHaveBeenCalledTimes(2);
  });

  it("claims mutable Hermes posture only after the exact probe succeeds", () => {
    const execute = vi.fn();

    expect(verifyMutableHermesConfigForTarget(hermesTarget, execute)).toEqual({
      verified: true,
      errors: [],
    });
    expect(execute).toHaveBeenCalledOnce();

    expect(
      verifyMutableHermesConfigForTarget(hermesTarget, () => {
        throw new Error("config.yaml remains read-only");
      }),
    ).toEqual({ verified: false, errors: ["config.yaml remains read-only"] });
  });

  it("executes the Hermes probe and rejects read-only or linked config artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mutable-probe-"));
    const configDir = path.join(root, ".hermes");
    const configPath = path.join(configDir, "config.yaml");
    const hashPath = path.join(configDir, ".config-hash");
    const envPath = path.join(configDir, ".env");
    const commandShim = path.join(root, "run-privileged-command.sh");
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.chmodSync(configDir, 0o3770);
    fs.writeFileSync(configPath, "fixture\n", { mode: 0o640 });
    fs.writeFileSync(hashPath, "fixture\n", { mode: 0o640 });
    fs.writeFileSync(envPath, "fixture\n", { mode: 0o640 });
    fs.chmodSync(configPath, 0o640);
    fs.chmodSync(hashPath, 0o640);
    fs.chmodSync(envPath, 0o640);
    fs.writeFileSync(
      commandShim,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "shift",
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        '[ "${1:-}" = "--" ]',
        "shift",
        'exec "$@"',
      ].join("\n"),
      { mode: 0o700 },
    );

    const fixtureTarget: AgentConfigTarget = {
      ...hermesTarget,
      configDir,
      configPath,
      sensitiveFiles: [hashPath, envPath],
    };
    const runProbe = () =>
      verifyMutableHermesConfigForTarget(fixtureTarget, (command) => {
        const result = spawnSync(commandShim, [...command], {
          encoding: "utf8",
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      });

    try {
      const valid = runProbe();
      expect(valid).toEqual({ verified: true, errors: [] });
      expect(
        fs.readdirSync(configDir).some((entry) => entry.startsWith(".nemoclaw-mutable-posture-")),
      ).toBe(false);

      fs.chmodSync(configPath, 0o440);
      const readOnly = runProbe();
      expect(readOnly.verified).toBe(false);
      expect(readOnly.errors.join("\n")).toContain("PermissionError");
      expect(
        fs.readdirSync(configDir).some((entry) => entry.startsWith(".nemoclaw-mutable-posture-")),
      ).toBe(false);

      fs.chmodSync(configPath, 0o640);
      fs.rmSync(envPath);
      fs.symlinkSync(configPath, envPath);
      const linked = runProbe();
      expect(linked.verified).toBe(false);
      expect(linked.errors.join("\n")).toMatch(/(?:ELOOP|Too many levels of symbolic links)/u);
      expect(
        fs.readdirSync(configDir).some((entry) => entry.startsWith(".nemoclaw-mutable-posture-")),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not apply the Hermes proof to another agent", () => {
    const execute = vi.fn();

    expect(verifyMutableHermesConfigForTarget(target, execute)).toEqual({
      verified: false,
      errors: ["agent openclaw does not use the mutable Hermes config contract"],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
