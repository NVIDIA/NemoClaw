// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  createShieldsFlowHarness,
  externalPolicyAuthorityInspection,
  managedMcpPolicy,
  managedMcpSandbox,
  type ShieldsFlowHarness,
} from "./helpers/shields-flow-harness";

const requireSource = createRequire(
  path.join(import.meta.dirname, "..", "src", "lib", "shields", "index.js"),
);
let tmpDir: string;
const TEST_PROCESS_START_IDENTITY = "test-process-start-identity";

function externalPolicyMutationAuthority(effectivePolicy: Record<string, unknown>) {
  return {
    authority: "externally-managed" as const,
    authorityRecordedNow: false,
    gatewayName: "nemoclaw",
    inspection: { authority: "externally-managed" as const, effectivePolicy },
  };
}

function prepareExternalMcpRecoveryFixture() {
  const alpha = managedMcpPolicy("alpha");
  const beta = managedMcpPolicy("beta");
  const harness = createShieldsFlowHarness(requireSource, tmpDir, {
    livePolicyYaml: YAML.stringify({
      version: 1,
      network_policies: { restrictive_baseline: {}, [alpha.key]: alpha.networkPolicy },
    }),
    processStartIdentity: TEST_PROCESS_START_IDENTITY,
    sandboxEntry: managedMcpSandbox([alpha]),
  });
  harness.shieldsDown("openclaw", { throwOnError: true });
  const snapshotPath = String(
    harness.getShieldsPosture("openclaw", false).state.shieldsPolicySnapshotPath,
  );
  const savedPolicy = YAML.parse(fs.readFileSync(snapshotPath, "utf-8"));
  const registry = requireSource(
    "../state/registry.js",
  ) as typeof import("../src/lib/state/registry.js");
  vi.mocked(registry.getSandbox).mockReturnValue({
    ...managedMcpSandbox([beta]),
    policyAuthority: "externally-managed",
  });
  return { alpha, beta, harness, savedPolicy, snapshotPath };
}

function bindExternalPolicyRecovery(
  harness: ShieldsFlowHarness,
  effectivePolicy: Record<string, unknown>,
): void {
  const authority = externalPolicyMutationAuthority(effectivePolicy);
  harness.policyAuthoritySpy.mockReturnValue(authority);
  harness.policyRecoveryAuthoritySpy.mockReturnValue(authority);
  harness.runCaptureSpy.mockReturnValue(YAML.stringify(effectivePolicy));
}

function countPolicySets(harness: ShieldsFlowHarness): number {
  return harness.runSpy.mock.calls.filter(
    ([command]) => Array.isArray(command) && command.includes("policy") && command.includes("set"),
  ).length;
}

function readRestrictivePolicy(harness: ShieldsFlowHarness, sandboxName: string) {
  const state = harness.getShieldsPosture(sandboxName, false).state;
  return YAML.parse(fs.readFileSync(String(state.shieldsPolicySnapshotPath), "utf-8")) as Record<
    string,
    unknown
  >;
}

function readExternalRecoveryArtifact(artifactPath: string): {
  content: string;
  mode: number;
} {
  const fileDescriptor = fs.openSync(artifactPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return {
      content: fs.readFileSync(fileDescriptor, "utf-8"),
      mode: fs.fstatSync(fileDescriptor).mode & 0o777,
    };
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function mismatchedExternalAuthority() {
  return {
    authority: "externally-managed",
    authorityRecordedNow: false,
    gatewayName: "nemoclaw",
    inspection: externalPolicyAuthorityInspection,
  } as const;
}

function throwInjectedFailure(message: string): never {
  throw new Error(message);
}

function prepareExternalRecoveryRetirementFixture() {
  const sandboxName = "openclaw";
  const harness = createShieldsFlowHarness(requireSource, tmpDir, {
    confirmOpenClawInodeFlags: true,
    initialOpenClawPosture: "locked",
    processStartIdentity: TEST_PROCESS_START_IDENTITY,
  });
  harness.shieldsDown(sandboxName, { throwOnError: true });
  harness.policyAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
  harness.policyRecoveryAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
  expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
    "must make the effective policy",
  );
  const recoveryState = harness.getShieldsPosture(sandboxName, false).state;
  const recoveryArtifact = recoveryState.externalPolicyRecoveryArtifact;
  const recoveryArtifactPath = String(recoveryArtifact?.path);
  const recoveryArtifactContent = readExternalRecoveryArtifact(recoveryArtifactPath).content;
  const restoredExternalAuthority = externalPolicyMutationAuthority(
    readRestrictivePolicy(harness, sandboxName),
  );
  harness.policyAuthoritySpy.mockReturnValue(restoredExternalAuthority);
  harness.policyRecoveryAuthoritySpy.mockReturnValue(restoredExternalAuthority);
  return {
    harness,
    recoveryArtifact,
    recoveryArtifactContent,
    recoveryArtifactPath,
    sandboxName,
  };
}

function injectStateCommitFailure(statePath: string, recoveryArtifactPath: string): void {
  const originalRenameSync = fs.renameSync.bind(fs);
  let injectedFailure = false;
  vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
    const shouldInject =
      !injectedFailure && String(newPath) === statePath && !fs.existsSync(recoveryArtifactPath);
    injectedFailure = injectedFailure || shouldInject;
    return shouldInject
      ? throwInjectedFailure("state commit denied")
      : originalRenameSync(oldPath, newPath);
  });
}

describe("external Shields policy recovery (#9833)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(`${os.tmpdir()}/nemoclaw-external-shields-recovery-`);
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[requireSource.resolve("./index.js")];
    delete require.cache[requireSource.resolve("./timer-bound-lock.js")];
    delete require.cache[requireSource.resolve("./transition-lock.js")];
    delete require.cache[requireSource.resolve("./permissive-runtime.js")];
    delete require.cache[requireSource.resolve("../actions/sandbox/mcp-bridge-policy.js")];
    delete require.cache[requireSource.resolve("../cli/branding.js")];
  });

  it("publishes the complete current MCP policy handoff (#9833)", () => {
    const { alpha, beta, harness, savedPolicy, snapshotPath } = prepareExternalMcpRecoveryFixture();
    bindExternalPolicyRecovery(harness, savedPolicy);

    expect(() =>
      harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
        persistExternalRecoveryArtifact: true,
      }),
    ).toThrow(/must make the effective policy/iu);

    const requiredPolicy = structuredClone(savedPolicy);
    delete requiredPolicy.network_policies[alpha.key];
    requiredPolicy.network_policies[beta.key] = beta.networkPolicy;
    const recoveryPolicy = YAML.parse(
      fs.readFileSync(
        path.join(tmpDir, ".nemoclaw", "state", "shields-external-policy-openclaw.yaml"),
        "utf-8",
      ),
    );
    expect(recoveryPolicy.network_policies).not.toHaveProperty(alpha.key);
    expect(recoveryPolicy.network_policies[beta.key]).toEqual(beta.networkPolicy);
    bindExternalPolicyRecovery(harness, requiredPolicy);
    expect(harness.applyShieldsPolicySnapshot("openclaw", snapshotPath).status).toBe(0);
  });

  it("bounds and escapes control characters in policy-key diagnostics (#9833)", () => {
    const unsafeKey = "safe\n\u001b[31m\u0085";
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      initialOpenClawPosture: "locked",
      livePolicyYaml: YAML.stringify({ version: 1, network_policies: { [unsafeKey]: {} } }),
      processStartIdentity: TEST_PROCESS_START_IDENTITY,
    });
    harness.shieldsDown("openclaw", { throwOnError: true });
    harness.policyAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
    harness.policyRecoveryAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      String.raw`network policy keys: "safe\u000a\u001b[31m\u0085"`,
    );
  });

  it("locks configuration only after external authority restores the exact snapshot (#9833)", () => {
    const sandboxName = "openclaw";
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
      processStartIdentity: TEST_PROCESS_START_IDENTITY,
    });
    harness.shieldsDown(sandboxName, { throwOnError: true });
    const policySetsAfterDown = countPolicySets(harness);
    harness.policyAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
    harness.policyRecoveryAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "must make the effective policy",
    );
    expect(countPolicySets(harness)).toBe(policySetsAfterDown);
    expect(harness.getOpenClawPosture()).toBe("mutable");
    const recoveryState = harness.getShieldsPosture(sandboxName, false).state;
    const recoveryArtifactPath = String(recoveryState.externalPolicyRecoveryArtifact?.path);
    const recoveryArtifactBeforeStatus = readExternalRecoveryArtifact(recoveryArtifactPath);
    expect(recoveryArtifactBeforeStatus.mode).toBe(0o600);
    expect(YAML.parse(recoveryArtifactBeforeStatus.content)).toEqual(
      readRestrictivePolicy(harness, sandboxName),
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(recoveryArtifactPath);

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as typeof process.exit);
    expect(() => harness.shieldsStatus(sandboxName, false)).toThrow("process exit 2");
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "must make the effective policy",
    );
    expect(readExternalRecoveryArtifact(recoveryArtifactPath).content).toBe(
      recoveryArtifactBeforeStatus.content,
    );

    const restoredExternalAuthority = externalPolicyMutationAuthority(
      readRestrictivePolicy(harness, sandboxName),
    );
    harness.policyAuthoritySpy.mockReturnValue(restoredExternalAuthority);
    harness.policyRecoveryAuthoritySpy.mockReturnValue(restoredExternalAuthority);

    expect(() => harness.shieldsStatus(sandboxName, false)).toThrow("process exit 2");
    const verifiedUnlockedStatus = harness.errorSpy.mock.calls.flat().join("\n");
    expect(verifiedUnlockedStatus).toContain("to lock configuration and commit Shields UP");
    expect(verifiedUnlockedStatus).not.toContain("Configuration is already locked");

    harness.shieldsUp(sandboxName, { throwOnError: true });

    expect(harness.isShieldsDown(sandboxName)).toBe(false);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(countPolicySets(harness)).toBe(policySetsAfterDown);
    expect(fs.existsSync(recoveryArtifactPath)).toBe(false);
    expect(harness.getShieldsPosture(sandboxName, false).state).not.toHaveProperty(
      "externalPolicyRecoveryArtifact",
    );
  });

  it("removes the external recovery artifact when Shields state is cleared (#9833)", () => {
    const sandboxName = "openclaw";
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
      processStartIdentity: TEST_PROCESS_START_IDENTITY,
    });
    harness.shieldsDown(sandboxName, { throwOnError: true });
    harness.policyAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
    harness.policyRecoveryAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "must make the effective policy",
    );
    const recoveryState = harness.getShieldsPosture(sandboxName, false).state;
    const recoveryArtifactPath = String(recoveryState.externalPolicyRecoveryArtifact?.path);
    expect(fs.existsSync(recoveryArtifactPath)).toBe(true);

    harness.clearShieldsState(sandboxName);

    expect(fs.existsSync(recoveryArtifactPath)).toBe(false);
    expect(harness.getShieldsPosture(sandboxName, false).mode).toBe("mutable_default");
  });

  it("keeps the external recovery artifact bound when state cleanup cannot remove it (#9833)", () => {
    const sandboxName = "openclaw";
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
      processStartIdentity: TEST_PROCESS_START_IDENTITY,
    });
    harness.shieldsDown(sandboxName, { throwOnError: true });
    harness.policyAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
    harness.policyRecoveryAuthoritySpy.mockReturnValue(mismatchedExternalAuthority());
    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "must make the effective policy",
    );
    const recoveryState = harness.getShieldsPosture(sandboxName, false).state;
    const recoveryArtifactPath = String(recoveryState.externalPolicyRecoveryArtifact?.path);
    const removalError = new Error("permission denied") as NodeJS.ErrnoException;
    removalError.code = "EACCES";
    vi.spyOn(fs, "rmSync").mockImplementationOnce((artifactPath) => {
      expect(String(artifactPath)).toBe(recoveryArtifactPath);
      throw removalError;
    });

    expect(() => harness.clearShieldsState(sandboxName)).toThrow(
      `Could not remove external Shields policy recovery artifact '${recoveryArtifactPath}': permission denied`,
    );

    expect(fs.existsSync(recoveryArtifactPath)).toBe(true);
    expect(
      harness.getShieldsPosture(sandboxName, false).state.externalPolicyRecoveryArtifact?.path,
    ).toBe(recoveryArtifactPath);
  });

  it("restores the bound recovery artifact when its removal cannot be made durable (#9833)", () => {
    const {
      harness,
      recoveryArtifact,
      recoveryArtifactContent,
      recoveryArtifactPath,
      sandboxName,
    } = prepareExternalRecoveryRetirementFixture();
    const originalRmSync = fs.rmSync.bind(fs);
    const originalFsyncSync = fs.fsyncSync.bind(fs);
    let failNextDirectoryFsync = false;
    let injectedFailure = false;
    vi.spyOn(fs, "rmSync").mockImplementation((filePath, options) => {
      const shouldInject = String(filePath) === recoveryArtifactPath && !injectedFailure;
      originalRmSync(filePath, options);
      failNextDirectoryFsync = failNextDirectoryFsync || shouldInject;
      injectedFailure = injectedFailure || shouldInject;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fileDescriptor) => {
      const shouldInject = failNextDirectoryFsync;
      failNextDirectoryFsync = false;
      return shouldInject
        ? throwInjectedFailure("directory sync denied")
        : originalFsyncSync(fileDescriptor);
    });

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "Could not make removal of external Shields policy recovery artifact",
    );

    expect(readExternalRecoveryArtifact(recoveryArtifactPath).content).toBe(
      recoveryArtifactContent,
    );
    expect(
      harness.getShieldsPosture(sandboxName, false).state.externalPolicyRecoveryArtifact,
    ).toEqual(recoveryArtifact);
    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).not.toThrow();
    expect(fs.existsSync(recoveryArtifactPath)).toBe(false);
  });

  it("restores the bound recovery artifact when the Shields state commit fails (#9833)", () => {
    const {
      harness,
      recoveryArtifact,
      recoveryArtifactContent,
      recoveryArtifactPath,
      sandboxName,
    } = prepareExternalRecoveryRetirementFixture();
    const statePath = path.join(tmpDir, ".nemoclaw", "state", `shields-${sandboxName}.json`);
    injectStateCommitFailure(statePath, recoveryArtifactPath);

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "Could not commit Shields state after removing external policy recovery artifact",
    );

    expect(readExternalRecoveryArtifact(recoveryArtifactPath).content).toBe(
      recoveryArtifactContent,
    );
    expect(
      harness.getShieldsPosture(sandboxName, false).state.externalPolicyRecoveryArtifact,
    ).toEqual(recoveryArtifact);
    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).not.toThrow();
    expect(fs.existsSync(recoveryArtifactPath)).toBe(false);
  });

  it("does not claim to restore an unbound recovery artifact after a state failure (#9833)", () => {
    const { harness, recoveryArtifactPath, sandboxName } =
      prepareExternalRecoveryRetirementFixture();
    const statePath = path.join(tmpDir, ".nemoclaw", "state", `shields-${sandboxName}.json`);
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    delete state.externalPolicyRecoveryArtifact;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    injectStateCommitFailure(statePath, recoveryArtifactPath);

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "restored Shields state; no bound artifact was available to restore",
    );

    expect(fs.existsSync(recoveryArtifactPath)).toBe(false);
    expect(harness.getShieldsPosture(sandboxName, false).state).not.toHaveProperty(
      "externalPolicyRecoveryArtifact",
    );
    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).not.toThrow();
  });

  it("withholds Shields success when external policy changes during config locking (#9833)", () => {
    const sandboxName = "openclaw";
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
      processStartIdentity: TEST_PROCESS_START_IDENTITY,
    });
    harness.shieldsDown(sandboxName, { throwOnError: true });
    const policySetsAfterDown = countPolicySets(harness);
    const restoredExternalAuthority = externalPolicyMutationAuthority(
      readRestrictivePolicy(harness, sandboxName),
    );
    const changedExternalAuthority = externalPolicyMutationAuthority({
      version: 1,
      network_policies: {},
    });
    harness.policyAuthoritySpy.mockReturnValue(restoredExternalAuthority);
    harness.policyRecoveryAuthoritySpy
      .mockReturnValueOnce(restoredExternalAuthority)
      .mockReturnValueOnce(restoredExternalAuthority)
      .mockReturnValue(changedExternalAuthority);

    expect(() => harness.shieldsUp(sandboxName, { throwOnError: true })).toThrow(
      "policy verification after config lock failed",
    );

    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(countPolicySets(harness)).toBe(policySetsAfterDown);
    const errors = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errors).toContain(
      "Config remains locked; Shields remain DOWN until policy verification succeeds.",
    );
    expect(errors).not.toContain("Config remains unlocked");
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_up" }),
    );
    const lockedRecovery = harness.getShieldsPosture(sandboxName, false);
    const lockedRecoveryArtifactPath = String(
      lockedRecovery.state.externalPolicyRecoveryArtifact?.path,
    );
    expect(lockedRecovery.mode).toBe("locked_recovery");
    expect(fs.existsSync(lockedRecoveryArtifactPath)).toBe(true);
    expect(harness.isShieldsDown(sandboxName)).toBe(false);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as typeof process.exit);
    expect(() => harness.shieldsStatus(sandboxName, false)).toThrow("process exit 2");
    expect(harness.getOpenClawPosture()).toBe("locked");
    harness.policyRecoveryAuthoritySpy.mockReturnValue(restoredExternalAuthority);
    expect(() => harness.shieldsStatus(sandboxName, false)).toThrow("process exit 2");
    const verifiedLockedStatus = harness.errorSpy.mock.calls.flat().join("\n");
    expect(verifiedLockedStatus).toContain("Configuration is already locked");
    expect(verifiedLockedStatus).toContain(lockedRecoveryArtifactPath);
    expect(verifiedLockedStatus).not.toContain("to lock configuration and commit Shields UP");
    harness.shieldsUp(sandboxName, { throwOnError: true });
    expect(harness.isShieldsDown(sandboxName)).toBe(false);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(fs.existsSync(lockedRecoveryArtifactPath)).toBe(false);
  });
});
