// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const shieldsModulePath = "../../../dist/lib/shields/index.js";

type ShieldsHarness = {
  logSpy: MockInstance;
  shieldsDown: typeof import("../../../dist/lib/shields/index.js").shieldsDown;
  shieldsStatus: typeof import("../../../dist/lib/shields/index.js").shieldsStatus;
  shieldsUp: typeof import("../../../dist/lib/shields/index.js").shieldsUp;
  isShieldsDown: typeof import("../../../dist/lib/shields/index.js").isShieldsDown;
};

let tmpDir: string;

type HarnessOptions = {
  dockerExecFileSync?: (argv: unknown) => string;
};

function createHarness(options: HarnessOptions = {}): ShieldsHarness {
  delete require.cache[requireDist.resolve(shieldsModulePath)];
  delete require.cache[requireDist.resolve("../../../dist/lib/sandbox/privileged-exec.js")];
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const runner = requireDist("../../../dist/lib/runner.js");
  const policy = requireDist("../../../dist/lib/policy/index.js");
  const sandboxConfig = requireDist("../../../dist/lib/sandbox/config.js");
  const registry = requireDist("../../../dist/lib/state/registry.js");
  const privilegedExec = requireDist("../../../dist/lib/sandbox/privileged-exec.js");
  const dockerExec = requireDist("../../../dist/lib/adapters/docker/exec.js");
  const audit = requireDist("../../../dist/lib/shields/audit.js");

  vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
  vi.spyOn(runner, "runCapture").mockReturnValue("version: 1\nnetwork_policies:\n  test: {}\n");
  vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
  vi.spyOn(policy, "buildPolicyGetCommand").mockReturnValue(["openshell", "policy", "get"]);
  vi.spyOn(policy, "buildPolicySetCommand").mockReturnValue(["openshell", "policy", "set"]);
  vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
  vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(
    path.join(tmpDir, "permissive.yaml"),
  );
  fs.writeFileSync(path.join(tmpDir, "permissive.yaml"), "version: 1\nnetwork_policies: {}\n");
  vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue({
    agentName: "openclaw",
    configDir: "/sandbox/.openclaw",
    configFile: "openclaw.json",
    configPath: "/sandbox/.openclaw/openclaw.json",
    format: "json",
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "openclaw", openshellDriver: "docker" });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [{ name: "openclaw" }] });
  vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
    (_sandboxName: unknown, cmd: unknown) => [
      "exec",
      "--user",
      "root",
      "openshell-openclaw",
      ...(Array.isArray(cmd) ? cmd.map(String) : []),
    ],
  );
  vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((argv: unknown) => {
    if (options.dockerExecFileSync) return options.dockerExecFileSync(argv);
    const args = Array.isArray(argv) ? argv.map(String) : [];
    if (args.includes("sha256sum")) return "a".repeat(64) + "  /sandbox/.openclaw/openclaw.json\n";
    if (args.includes("stat")) {
      return args.at(-1) === "/sandbox/.openclaw"
        ? "2770 sandbox:sandbox\n"
        : "660 sandbox:sandbox\n";
    }
    return "";
  });
  vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);

  const shields = requireDist(shieldsModulePath);
  logSpy.mockClear();
  return {
    logSpy,
    shieldsDown: shields.shieldsDown,
    shieldsStatus: shields.shieldsStatus,
    shieldsUp: shields.shieldsUp,
    isShieldsDown: shields.isShieldsDown,
  };
}

describe("shields command flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-flow-"));
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[requireDist.resolve(shieldsModulePath)];
  });

  it("shieldsDown captures policy, unlocks config, saves state, and skips timer on request", () => {
    const harness = createHarness();

    harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "coverage",
      skipTimer: true,
      throwOnError: true,
    });

    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(state).toMatchObject({
      shieldsDown: true,
      shieldsDownTimeout: 300,
      shieldsDownReason: "coverage",
      shieldsDownPolicy: "permissive",
    });
    expect(fs.existsSync(state.shieldsPolicySnapshotPath)).toBe(true);
    expect(harness.isShieldsDown("openclaw")).toBe(true);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Config unlocked for openclaw (no auto-lockdown timer",
    );
  });

  it("shieldsUp refuses to mark lockdown active when the saved restrictive policy snapshot is missing", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: path.join(stateDir, "missing-snapshot.yaml"),
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "Saved policy snapshot is missing",
    );
  });

  it("shieldsStatus restores an expired dead timer through the same lock path as shields up", () => {
    const configPath = "/sandbox/.openclaw/openclaw.json";
    const configDir = "/sandbox/.openclaw";
    const hashPath = `${configDir}/.config-hash`;
    const configHash = "a".repeat(64);
    const hashHash = "b".repeat(64);
    const execCalls: string[] = [];
    const harness = createHarness({
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        const cmd = args.join(" ");
        execCalls.push(cmd);
        if (cmd.includes(` stat -c %a %U:%G ${hashPath}`)) return "444 root:root\n";
        if (cmd.includes(` stat -c %a %U:%G ${configPath}`)) return "444 root:root\n";
        if (cmd.includes(` stat -c %a %U:%G ${configDir}`)) return "755 root:root\n";
        if (cmd.includes(` lsattr -d ${hashPath}`)) return `----i---------e----- ${hashPath}\n`;
        if (cmd.includes(` lsattr -d ${configPath}`)) return `----i---------e----- ${configPath}\n`;
        if (cmd.includes(` sha256sum ${hashPath}`)) return `${hashHash}  ${hashPath}\n`;
        if (cmd.includes(` sha256sum ${configPath}`)) return `${configHash}  ${configPath}\n`;
        return "";
      },
    });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPath = path.join(stateDir, "policy-snapshot-expired.yaml");
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
        shieldsDownTimeout: 60,
        shieldsDownReason: "coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "shields-timer-openclaw.json"),
      JSON.stringify({
        pid: 4242,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() - 30_000).toISOString(),
        processToken: "timer-token",
      }),
    );
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (pid === 4242 && signal === 0) {
        const error = new Error("timer is gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });

    harness.shieldsStatus("openclaw");

    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
    );
    expect(harness.logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
    expect(state.shieldsDown).toBe(false);
    expect(state.fileHashes).toMatchObject({
      [configPath]: configHash,
      [hashPath]: hashHash,
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(false);
    expect(execCalls.some((cmd) => cmd.includes(` chmod 444 ${hashPath}`))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes(` chown root:root ${hashPath}`))).toBe(true);
  });
});
