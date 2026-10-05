// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturePrivilegedSandboxCommand, resolveAgentConfig, withMcpLifecycleLockSync } =
  vi.hoisted(() => ({
    capturePrivilegedSandboxCommand: vi.fn(),
    resolveAgentConfig: vi.fn(),
    withMcpLifecycleLockSync: vi.fn((_name, action) => action()),
  }));

vi.mock("./privileged-exec", () => ({
  capturePrivilegedSandboxCommand,
}));
vi.mock("./agent-config", () => ({ resolveAgentConfig }));
vi.mock("../state/mcp-lifecycle-lock-acquisition", () => ({ withMcpLifecycleLockSync }));

import type { AgentConfigTarget } from "./agent-config";
import { verifyMutableHermesConfigForTarget } from "./mutable-config-perms";

const hermesTarget: AgentConfigTarget = {
  agentName: "hermes",
  configDir: "/sandbox/.hermes",
  configFile: "config.yaml",
  configPath: "/sandbox/.hermes/config.yaml",
  format: "yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
};
describe("mutable Hermes config permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentConfig.mockReturnValue(hermesTarget);
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

    expect(
      verifyMutableHermesConfigForTarget({ ...hermesTarget, agentName: "openclaw" }, execute),
    ).toEqual({
      verified: false,
      errors: ["agent openclaw does not use the mutable Hermes config contract"],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
