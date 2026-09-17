// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abortOpenClawPostRestoreDoctor: vi.fn(),
  beginOpenClawBackupQuiesce: vi.fn(),
  captureRecordedSandboxBasePolicy: vi.fn(),
  finishOpenClawPostRestoreDoctor: vi.fn(),
  retireOpenClawPostRestoreDoctorForDelete: vi.fn(),
  recordRebuildRecoveryBackup: vi.fn(),
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
vi.mock("./rebuild-recreate-journal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-recreate-journal")>()),
  recordRebuildRecoveryBackup: mocks.recordRebuildRecoveryBackup,
}));
vi.mock("./runtime/openclaw-lifecycle", () => ({
  abortOpenClawPostRestoreDoctor: mocks.abortOpenClawPostRestoreDoctor,
  beginOpenClawBackupQuiesce: mocks.beginOpenClawBackupQuiesce,
  finishOpenClawPostRestoreDoctor: mocks.finishOpenClawPostRestoreDoctor,
  retireOpenClawPostRestoreDoctorForDelete: mocks.retireOpenClawPostRestoreDoctorForDelete,
}));

import {
  type RebuildBackupPhaseInput,
  retireRebuildSourceOpenClawWindowForDelete,
  runRebuildBackupPhase,
} from "./rebuild-backup-phase";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  mocks.abortOpenClawPostRestoreDoctor.mockReset().mockResolvedValue({ ok: true });
  mocks.beginOpenClawBackupQuiesce.mockReset().mockResolvedValue({
    ok: true,
    window: { sandboxName: "alpha", kind: "backup" },
  });
  mocks.captureRecordedSandboxBasePolicy
    .mockReset()
    .mockReturnValue("version: 1\nnetwork_policies: {}\n");
  mocks.recordRebuildRecoveryBackup.mockReset();
  mocks.finishOpenClawPostRestoreDoctor.mockReset().mockResolvedValue({ ok: true });
  mocks.retireOpenClawPostRestoreDoctorForDelete.mockReset().mockResolvedValue({ ok: true });
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
    gatewayPort: 8080,
    sandboxEntry: { name: "alpha" },
    staleRecovery: false,
    preparedRecoveryManifest: null,
    messagingPlan: null,
    webSearchConfig: null,
    log: vi.fn(),
    bail: (message): never => {
      throw new Error(message);
    },
    ...overrides,
  });

  it("retires the retained source window before the delete edge", async () => {
    const window = { sandboxName: "alpha" };

    await expect(retireRebuildSourceOpenClawWindowForDelete(window)).resolves.toEqual({
      ok: true,
    });

    expect(mocks.retireOpenClawPostRestoreDoctorForDelete).toHaveBeenCalledExactlyOnceWith(window);
    expect(mocks.abortOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    expect(mocks.finishOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
  });

  it("captures the current OpenShell base policy in a private transaction file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-policy-test-"));
    temporaryDirectories.push(directory);
    const policyPath = path.join(directory, "policy.yaml");
    mocks.secureTempFile.mockReturnValue(policyPath);
    mocks.captureRecordedSandboxBasePolicy.mockReturnValue(
      "version: 1\nnetwork_policies:\n  host_changed: {}\n",
    );
    const result = await runRebuildBackupPhase(
      input(),
      vi.fn(async () => null),
    );

    expect(result?.policySourcePath).toBe(policyPath);
    expect(fs.readFileSync(policyPath, "utf8")).toContain("host_changed");
    expect(fs.statSync(policyPath).mode & 0o777).toBe(0o600);
    expect(result).not.toHaveProperty("policyPresets");
    expect(mocks.captureRecordedSandboxBasePolicy).toHaveBeenCalledWith(
      "alpha",
      "capture the live policy before sandbox replacement",
      undefined,
    );
    expect(mocks.beginOpenClawBackupQuiesce).toHaveBeenCalledExactlyOnceWith("alpha", undefined);
    expect(result?.sourceOpenClawDoctorWindow).toEqual({
      sandboxName: "alpha",
      kind: "backup",
    });
    expect(mocks.finishOpenClawPostRestoreDoctor).not.toHaveBeenCalledWith({
      sandboxName: "alpha",
    });
  });

  it("rejects a literal credential before creating a rebuild policy handoff", async () => {
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
    const backup = vi.fn(async () => null);

    await expect(runRebuildBackupPhase(input(), backup)).rejects.toThrow(
      "Cannot prepare a rebuild policy handoff for sandbox 'alpha' because its live OpenShell policy contains a literal credential value. Replace literal credentials with supported OpenShell credential bindings or resolver placeholders, then retry the rebuild.",
    );
    expect(backup).not.toHaveBeenCalled();
    expect(mocks.secureTempFile).not.toHaveBeenCalled();
  });

  it("never reconstructs a missing live policy from NemoClaw state", async () => {
    await expect(
      runRebuildBackupPhase(
        input({ staleRecovery: true }),
        vi.fn(async () => null),
      ),
    ).rejects.toThrow(/will not reconstruct policy from NemoClaw state/);
  });

  it("binds an unsafe legacy handoff to a supported recovery transaction", async () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unsafe-recovery-"));
    temporaryDirectories.push(backupPath);
    const legacyCredentialPolicy = [
      "version: 1",
      "network_policies: {}",
      "process:",
      "  environment:",
      "    SERVICE_API_KEY: opaque-retained-credential",
      "",
    ].join("\n");
    const sha256 = createHash("sha256").update(legacyCredentialPolicy).digest("hex");
    const file = `rebuild-policy-handoff.${sha256}.yaml`;
    fs.writeFileSync(path.join(backupPath, file), legacyCredentialPolicy, { mode: 0o600 });
    const preparedRecoveryManifest = {
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
      rebuildPolicyHandoff: { file, sha256 },
    };

    let refusal: Error | null = null;
    try {
      await runRebuildBackupPhase(
        input({
          staleRecovery: true,
          preparedRecoveryManifest,
        }),
        vi.fn(async () => null),
      );
    } catch (error) {
      refusal = error as Error;
    }

    expect(refusal?.message).toContain(
      "Only then run `nemoclaw alpha destroy --yes` and confirm OpenShell reports the sandbox deleted",
    );
    expect(refusal?.message).toContain("Do not use `--force` for this recovery");
    expect(refusal?.message).not.toContain("destroy --force");
    expect(refusal?.message).toContain(
      "If deletion is unconfirmed, preserve the recovery state and restore gateway access",
    );
    expect(refusal?.message).toContain(
      "Create a fresh sandbox under a new name by replacing `<new-sandbox>` in `nemoclaw onboard --name <new-sandbox>`",
    );
    expect(refusal?.message).toContain("Do not retry rebuild with the unsafe handoff");
    expect(refusal?.message).toContain("`nemoclaw alpha rebuild --retire-recovery ");
    expect(refusal?.message).not.toContain("<transaction-id>");
    expect(refusal?.message).toContain(
      `This removes the credential-bearing policy handoff at '${path.join(
        backupPath,
        preparedRecoveryManifest.rebuildPolicyHandoff!.file,
      )}'`,
    );
    expect(
      fs.existsSync(path.join(backupPath, preparedRecoveryManifest.rebuildPolicyHandoff!.file)),
    ).toBe(true);
    expect(mocks.recordRebuildRecoveryBackup).toHaveBeenCalledWith({
      sandboxName: "alpha",
      agentName: "openclaw",
      transactionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      backupManifest: preparedRecoveryManifest,
    });
  });
});
