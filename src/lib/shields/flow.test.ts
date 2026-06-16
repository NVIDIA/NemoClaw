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
  shieldsUp: typeof import("../../../dist/lib/shields/index.js").shieldsUp;
  isShieldsDown: typeof import("../../../dist/lib/shields/index.js").isShieldsDown;
};

let tmpDir: string;

function createHarness(): ShieldsHarness {
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
});
