// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandboxPolicy: vi.fn(),
  secureTempFile: vi.fn(),
}));

vi.mock("./policy-get", () => ({ getSandboxPolicy: mocks.getSandboxPolicy }));
vi.mock("../../onboard/temp-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/temp-files")>()),
  secureTempFile: mocks.secureTempFile,
}));

import { type RebuildBackupPhaseInput, runRebuildBackupPhase } from "./rebuild-backup-phase";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  mocks.getSandboxPolicy.mockReset().mockReturnValue({
    yaml: "version: 1\nnetwork_policies: {}\n",
  });
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
  it("captures the current OpenShell base policy in a private transaction file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-policy-test-"));
    temporaryDirectories.push(directory);
    const policyPath = path.join(directory, "policy.yaml");
    mocks.secureTempFile.mockReturnValue(policyPath);
    mocks.getSandboxPolicy.mockReturnValue({
      yaml: "version: 1\nnetwork_policies:\n  host_changed: {}\n",
    });
    const result = runRebuildBackupPhase(
      {
        sandboxName: "alpha",
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
      },
      vi.fn(() => null),
    );

    expect(result?.policySourcePath).toBe(policyPath);
    expect(fs.readFileSync(policyPath, "utf8")).toContain("host_changed");
    expect(fs.statSync(policyPath).mode & 0o777).toBe(0o600);
    expect(result).not.toHaveProperty("policyPresets");
    expect(mocks.getSandboxPolicy).toHaveBeenCalledWith("alpha", {
      recordedGatewayOperation: "capture the live policy before sandbox replacement",
    });
  });

  it("never reconstructs a missing live policy from NemoClaw state", () => {
    expect(() =>
      runRebuildBackupPhase(
        {
          sandboxName: "alpha",
          sandboxEntry: { name: "alpha" },
          staleRecovery: true,
          preparedRecoveryManifest: null,
          messagingPlan: null,
          webSearchConfig: null,
          log: vi.fn(),
          bail: (message): never => {
            throw new Error(message);
          },
          relockShieldsIfNeeded: vi.fn(() => true),
        },
        vi.fn(() => null),
      ),
    ).toThrow(/will not reconstruct policy from NemoClaw state/);
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

  it("records when --force skips a total filesystem backup failure", () => {
    const backup = vi.fn(() => null);
    const result = runRebuildBackupPhase(
      {
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        preparedRecoveryManifest: null,
        messagingPlan: null,
        webSearchConfig: null,
        force: true,
        log: vi.fn(),
        bail: (message): never => {
          throw new Error(message);
        },
        relockShieldsIfNeeded: vi.fn(() => true),
      },
      backup as never,
    );

    expect(result?.backupManifest).toBeNull();
    expect(result?.backupWasForceSkipped).toBe(true);
    expect(result?.policySourcePath).toMatch(/policy\.yaml$/u);
  });
});
