// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  createShieldsFlowHarness,
  externalPolicyAuthorityInspection,
  type ShieldsFlowHarness,
} from "../../../test/helpers/shields-flow-harness";

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

function countPolicySets(harness: ShieldsFlowHarness): number {
  return harness.runSpy.mock.calls.filter(
    ([command]) => Array.isArray(command) && command.includes("policy") && command.includes("set"),
  ).length;
}

function externalAuthority(effectivePolicy: Record<string, unknown>) {
  return {
    authority: "externally-managed" as const,
    authorityRecordedNow: false,
    gatewayName: "nemoclaw",
    inspection: {
      authority: "externally-managed" as const,
      effectivePolicy,
    },
  };
}

function readRestrictivePolicy(harness: ShieldsFlowHarness, sandboxName: string) {
  const state = harness.getShieldsPosture(sandboxName, false).state;
  return YAML.parse(fs.readFileSync(String(state.shieldsPolicySnapshotPath), "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("external Shields policy recovery", () => {
  let externalTmpDir: string;

  beforeEach(() => {
    externalTmpDir = fs.mkdtempSync(`${os.tmpdir()}/nemoclaw-external-shields-recovery-`);
    vi.stubEnv("HOME", externalTmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(externalTmpDir, { recursive: true, force: true });
  });

  it("locks configuration only after external authority restores the exact snapshot (#9833)", () => {
    const sandboxName = "openclaw";
    const harness = createShieldsFlowHarness(requireSource, externalTmpDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
    });
    harness.shieldsDown(sandboxName, { throwOnError: true });
    const policySetsAfterDown = countPolicySets(harness);
    const mismatchedExternalAuthority = {
      authority: "externally-managed",
      authorityRecordedNow: false,
      gatewayName: "nemoclaw",
      inspection: externalPolicyAuthorityInspection,
    } as const;
    harness.policyAuthoritySpy.mockReturnValue(mismatchedExternalAuthority);
    harness.policyRecoveryAuthoritySpy.mockReturnValue(mismatchedExternalAuthority);

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow("must apply");
    expect(countPolicySets(harness)).toBe(policySetsAfterDown);
    expect(harness.getOpenClawPosture()).toBe("mutable");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as typeof process.exit);
    expect(() => harness.shieldsStatus(sandboxName, false)).toThrow("process exit 2");
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("must apply");

    const restoredExternalAuthority = externalAuthority(
      readRestrictivePolicy(harness, sandboxName),
    );
    harness.policyAuthoritySpy.mockReturnValue(restoredExternalAuthority);
    harness.policyRecoveryAuthoritySpy.mockReturnValue(restoredExternalAuthority);

    harness.shieldsUp(sandboxName, { throwOnError: true });

    expect(harness.isShieldsDown(sandboxName)).toBe(false);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(countPolicySets(harness)).toBe(policySetsAfterDown);
  });

  it("withholds Shields success when external policy changes during config locking (#9833)", () => {
    const sandboxName = "openclaw";
    const harness = createShieldsFlowHarness(requireSource, externalTmpDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
    });
    harness.shieldsDown(sandboxName, { throwOnError: true });
    const policySetsAfterDown = countPolicySets(harness);
    const restoredExternalAuthority = externalAuthority(
      readRestrictivePolicy(harness, sandboxName),
    );
    const changedExternalAuthority = externalAuthority({ version: 1, network_policies: {} });
    harness.policyAuthoritySpy.mockReturnValue(restoredExternalAuthority);
    harness.policyRecoveryAuthoritySpy.mockImplementation(() =>
      harness.getOpenClawPosture() === "locked"
        ? changedExternalAuthority
        : restoredExternalAuthority,
    );

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "policy verification after config lock failed",
    );

    expect(harness.isShieldsDown(sandboxName)).toBe(true);
    expect(countPolicySets(harness)).toBe(policySetsAfterDown);
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_up" }),
    );
  });
});
