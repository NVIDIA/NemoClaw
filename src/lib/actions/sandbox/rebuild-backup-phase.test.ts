// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureRecordedSandboxBasePolicy: vi.fn(),
  secureTempFile: vi.fn(),
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  captureRecordedSandboxBasePolicy: mocks.captureRecordedSandboxBasePolicy,
}));
vi.mock("../../onboard/temp-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/temp-files")>()),
  secureTempFile: mocks.secureTempFile,
}));

import {
  type RebuildBackupPhaseInput,
  runRebuildBackupPhase,
  writeRebuildPolicyHandoff,
} from "./rebuild-backup-phase";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  mocks.captureRecordedSandboxBasePolicy
    .mockReset()
    .mockReturnValue("version: 1\nnetwork_policies: {}\n");
  mocks.secureTempFile.mockReset().mockImplementation(() => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-policy-default-"));
    temporaryDirectories.push(directory);
    return path.join(directory, "policy.yaml");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("rebuild policy handoff", () => {
  const input = (overrides: Partial<RebuildBackupPhaseInput> = {}): RebuildBackupPhaseInput => ({
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    sandboxEntry: { name: "alpha" },
    staleRecovery: false,
    preparedRecoveryManifest: null,
    messagingPlan: null,
    webSearchConfig: null,
    log: vi.fn(),
    bail: (message): never => {
      throw new Error(message);
    },
    relockShieldsIfNeeded: vi.fn(() => true),
    ...overrides,
  });

  it("captures the current OpenShell base policy in a private transaction file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-policy-test-"));
    temporaryDirectories.push(directory);
    const policyPath = path.join(directory, "policy.yaml");
    mocks.secureTempFile.mockReturnValue(policyPath);
    mocks.captureRecordedSandboxBasePolicy.mockReturnValue(
      "version: 1\nnetwork_policies:\n  host_changed: {}\n",
    );
    const result = runRebuildBackupPhase(input(), vi.fn(() => null));

    expect(result?.policySourcePath).toBe(policyPath);
    expect(fs.readFileSync(policyPath, "utf8")).toContain("host_changed");
    expect(fs.statSync(policyPath).mode & 0o777).toBe(0o600);
    expect(result).not.toHaveProperty("policyPresets");
    expect(mocks.captureRecordedSandboxBasePolicy).toHaveBeenCalledWith(
      "alpha",
      "capture the live policy before sandbox replacement",
    );
  });

  it("rejects a literal credential before creating a rebuild policy handoff", () => {
    const credential = "opaque-url-credential";
    mocks.captureRecordedSandboxBasePolicy.mockReturnValue(
      [
        "version: 1",
        "network_policies:",
        "  protected_api:",
        "    endpoints:",
        `      - host: https://operator:${credential}@api.example`,
        "",
      ].join("\n"),
    );
    const backup = vi.fn(() => null);

    expect(() =>
      runRebuildBackupPhase(input(), backup),
    ).toThrow(
      "Cannot prepare a rebuild policy handoff for sandbox 'alpha' because its live OpenShell policy contains a literal credential value. Replace literal credentials with supported OpenShell credential bindings or resolver placeholders, then retry the rebuild.",
    );
    expect(backup).not.toHaveBeenCalled();
    expect(mocks.secureTempFile).not.toHaveBeenCalled();
  });

  it("never reconstructs a missing live policy from NemoClaw state", () => {
    expect(() =>
      runRebuildBackupPhase(input({ staleRecovery: true }), vi.fn(() => null)),
    ).toThrow(/will not reconstruct policy from NemoClaw state/);
  });

  it("routes an unsafe stale handoff to supported destroy and fresh-onboard recovery", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unsafe-recovery-"));
    temporaryDirectories.push(backupPath);
    const preparedRecoveryManifest = writeRebuildPolicyHandoff(
      {
        version: 1,
        sandboxName: "alpha",
        timestamp: "2026-09-01T00-00-00-000Z",
        agentType: "openclaw",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: [],
        failedBackupDirs: [],
        stateFiles: [],
        dir: "/sandbox/.openclaw",
        backupPath,
        blueprintDigest: "digest",
      },
      [
        "version: 1",
        "network_policies: {}",
        "process:",
        "  environment:",
        "    SERVICE_API_KEY: opaque-retained-credential",
        "",
      ].join("\n"),
    );

    let refusal: Error | null = null;
    try {
      runRebuildBackupPhase(
        input({ staleRecovery: true, preparedRecoveryManifest }),
        vi.fn(),
      );
    } catch (error) {
      refusal = error as Error;
    }

    expect(refusal?.message).toContain(
      "Only then run `nemoclaw alpha destroy --force` and confirm OpenShell reports the sandbox deleted",
    );
    expect(refusal?.message).toContain(
      "If deletion is unconfirmed, preserve the recovery state and restore gateway access",
    );
    expect(refusal?.message).toContain(
      "Create a fresh sandbox under a new name by replacing `<new-sandbox>` in `nemoclaw onboard --name <new-sandbox>`",
    );
    expect(refusal?.message).toContain("Do not discard the handoff and retry rebuild");
    expect(
      fs.existsSync(path.join(backupPath, preparedRecoveryManifest.rebuildPolicyHandoff!.file)),
    ).toBe(true);
  });
});

describe("rebuild backup safety", () => {
  const completeMarkedManifest = {
    agentType: "openclaw",
    dir: "/sandbox/.openclaw",
    backupPath: "/tmp/custom-openclaw-backup",
    reconcileOpenClawImagePluginProvenance: true,
    openclawImagePluginInstalls: [],
  } as Record<string, unknown>;

  function customOpenClawInput(overrides: Record<string, unknown> = {}): RebuildBackupPhaseInput {
    return {
      sandboxName: "custom-openclaw",
      gatewayName: "nemoclaw",
      sandboxEntry: {
        name: "custom-openclaw",
        agent: "openclaw",
        fromDockerfile: "/tmp/Dockerfile.custom",
      },
      staleRecovery: false,
      preparedRecoveryManifest: null,
      messagingPlan: null,
      webSearchConfig: null,
      log: vi.fn(),
      bail: (message): never => {
        throw new Error(message);
      },
      relockShieldsIfNeeded: vi.fn(() => true),
      ...overrides,
    } as RebuildBackupPhaseInput;
  }

  it("blocks a live custom image with missing plugin provenance before backup", () => {
    const backup = vi.fn();
    const input = customOpenClawInput();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runRebuildBackupPhase(input, backup)).toThrow(
      "Custom-image OpenClaw plugin provenance is unavailable.",
    );
    expect(backup).not.toHaveBeenCalled();
    expect(input.relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("uses a marked prepared manifest while still capturing live OpenShell policy", () => {
    const backup = vi.fn();
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-recovery-"));
    temporaryDirectories.push(backupPath);
    const preparedManifest = { ...completeMarkedManifest, backupPath } as never;
    const result = runRebuildBackupPhase(
      customOpenClawInput({ preparedRecoveryManifest: preparedManifest }),
      backup,
    );

    expect(result?.backupManifest).toEqual(preparedManifest);
    expect(result?.policySourcePath).toMatch(/rebuild-policy-handoff\.[a-f0-9]{64}\.yaml$/u);
    expect(backup).not.toHaveBeenCalled();
  });

  it("blocks an unmarked legacy prepared manifest before replacement", () => {
    const backup = vi.fn();
    const input = customOpenClawInput({
      preparedRecoveryManifest: {
        agentType: "openclaw",
        dir: "/sandbox/.openclaw",
        backupPath: "/tmp/legacy-custom-openclaw-backup",
        openclawImagePluginInstalls: [],
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runRebuildBackupPhase(input, backup)).toThrow(
      "Custom-image OpenClaw plugin provenance is unavailable.",
    );
    expect(backup).not.toHaveBeenCalled();
  });

  it("revalidates a newly generated backup manifest before replacement", () => {
    const backup = vi.fn(() => ({
      agentType: "openclaw",
      dir: "/sandbox/.openclaw",
      backupPath: "/tmp/incomplete-custom-openclaw-backup",
      reconcileOpenClawImagePluginProvenance: true,
    }));
    const input = customOpenClawInput({
      sandboxEntry: {
        name: "custom-openclaw",
        agent: "openclaw",
        fromDockerfile: "/tmp/Dockerfile.custom",
        openclawImagePluginInstalls: [],
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runRebuildBackupPhase(input, backup as never)).toThrow(
      "Custom-image OpenClaw plugin provenance is unavailable.",
    );
    expect(backup).toHaveBeenCalledOnce();
  });
});
