// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShieldsFlowHarness } from "../../../test/helpers/shields-flow-harness";

const NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const NORMALIZER_WATCHDOG = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "15s"];
const requireSource = createRequire(import.meta.url);

type DockerExecModule = typeof import("../adapters/docker/exec");
type MutableConfigRepairModule = typeof import("./mutable-config-repair");
type PrivilegedExecModule = typeof import("../sandbox/privileged-exec");

let dockerExec: DockerExecModule;
let normalizeMutableOpenClawConfig: MutableConfigRepairModule["normalizeMutableOpenClawConfig"];
let privilegedExec: PrivilegedExecModule;

function mockPrivilegedArgv() {
  return vi
    .spyOn(privilegedExec, "privilegedSandboxExecArgv")
    .mockImplementation((_sandboxName, cmd) => ["privileged", ...cmd]);
}

describe("mutable OpenClaw config repair", () => {
  beforeEach(() => {
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
    dockerExec = requireSource("../adapters/docker/exec.js");
    privilegedExec = requireSource("../sandbox/privileged-exec.js");
    ({ normalizeMutableOpenClawConfig } = requireSource("./mutable-config-repair.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
  });

  it("sanitizes identity probes and watchdogs the privileged normalizer", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n")
      .mockReturnValue("");

    normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw");

    expect(privilegedArgv.mock.calls).toEqual([
      ["alpha", ["/usr/bin/id", "-u", "sandbox"], false, true],
      ["alpha", ["/usr/bin/id", "-g", "sandbox"], false, true],
      [
        "alpha",
        [
          ...NORMALIZER_WATCHDOG,
          "/usr/bin/python3",
          "-I",
          NORMALIZER,
          "/sandbox/.openclaw",
          "1000",
          "1001",
        ],
        false,
        true,
      ],
    ]);
    expect(dockerExecFileSync).toHaveBeenCalledTimes(3);
    expect(dockerExecFileSync.mock.calls.map(([argv]) => argv)).toEqual([
      ["privileged", "/usr/bin/id", "-u", "sandbox"],
      ["privileged", "/usr/bin/id", "-g", "sandbox"],
      [
        "privileged",
        ...NORMALIZER_WATCHDOG,
        "/usr/bin/python3",
        "-I",
        NORMALIZER,
        "/sandbox/.openclaw",
        "1000",
        "1001",
      ],
    ]);
    expect(dockerExecFileSync.mock.calls.map(([, options]) => options)).toEqual([
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      { stdio: ["ignore", "pipe", "pipe"], timeout: 25000 },
    ]);
  });

  it("rejects an invalid sandbox UID before the GID or normalizer runs", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const dockerExecFileSync = vi.spyOn(dockerExec, "dockerExecFileSync").mockReturnValue("0\n");

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(
      "sandbox identity lookup returned an invalid UID",
    );
    expect(privilegedArgv).toHaveBeenCalledOnce();
    expect(privilegedArgv).toHaveBeenCalledWith(
      "alpha",
      ["/usr/bin/id", "-u", "sandbox"],
      false,
      true,
    );
    expect(dockerExecFileSync).toHaveBeenCalledOnce();
  });

  it("rejects an invalid sandbox GID before the normalizer runs", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("not-a-gid\n");

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(
      "sandbox identity lookup returned an invalid GID",
    );
    expect(privilegedArgv).toHaveBeenCalledTimes(2);
    expect(privilegedArgv).not.toHaveBeenCalledWith(
      "alpha",
      expect.arrayContaining([NORMALIZER]),
      false,
      true,
    );
    expect(dockerExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("propagates a trusted normalizer execution failure", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const failure = new Error("docker exec failed");
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n")
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(failure);
    expect(privilegedArgv).toHaveBeenLastCalledWith(
      "alpha",
      [
        ...NORMALIZER_WATCHDOG,
        "/usr/bin/python3",
        "-I",
        NORMALIZER,
        "/sandbox/.openclaw",
        "1000",
        "1001",
      ],
      false,
      true,
    );
    expect(dockerExecFileSync).toHaveBeenCalledTimes(3);
  });
});

describe("locked Shields policy recovery status", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-locked-policy-recovery-"));
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("verifies Hermes locked recovery status without mutating provider state (#9833)", () => {
    const sandboxName = "hermes";
    const target = {
      agentName: "hermes",
      configDir: "/sandbox/.hermes",
      configFile: "config.yaml",
      configPath: "/sandbox/.hermes/config.yaml",
      format: "yaml",
      sensitiveFiles: ["/sandbox/.hermes/.env"],
      stateLockPlanInImage: true,
    };
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      agentConfigTarget: target,
      sandboxName,
    });
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: true,
        policyRecoveryConfigLocked: true,
        chattrApplied: true,
        fileHashes: { [target.configPath]: "a".repeat(64) },
      }),
    );
    const mutationCount = harness.dockerSpawnCalls.length;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as typeof process.exit);

    expect(() =>
      harness.shieldsStatus(sandboxName, false, {
        inspectPolicyRecovery: () => ({ status: "external", handoff: "policy handoff" }),
        resolveConfig: () => target,
        verifyLockState: () => ({ ok: true, issues: [] }),
        verifyStateLockPlan: () => [],
      }),
    ).toThrow("process exit 2");

    expect(harness.dockerSpawnCalls).toHaveLength(mutationCount);
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "DOWN (CONFIG LOCKED — POLICY RECOVERY REQUIRED)",
    );
  });
});
