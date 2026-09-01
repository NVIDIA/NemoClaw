// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeActivePolicyTransition,
  writeBoundPolicySnapshot,
} from "../../../test/helpers/shields-flow-harness";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-policy-read-recovery-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Shields policy-read recovery", () => {
  it.each([
    {
      label: "authentication failure",
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox policy read.",
      } as const,
      recovery: "Restore authentication for the sandbox's OpenShell gateway",
    },
    {
      label: "unreachable gateway",
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      } as const,
      recovery: "Verify the gateway with `openshell status`",
    },
    {
      label: "gateway identity mismatch",
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      } as const,
      recovery: "Verify the sandbox's recorded gateway identity with `openshell status`",
    },
    {
      label: "schema mismatch",
      error: {
        kind: "schema",
        message: "The OpenShell CLI and gateway policy schemas do not match.",
      } as const,
      recovery: "Update the OpenShell CLI and gateway to compatible versions",
    },
  ])("keeps recovery retryable after a typed $label", async ({ error, recovery }) => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const sandboxName = "openclaw";
    const gatewayName = "nemoclaw-8091";
    const processToken = "6".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-read-failure.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsPolicySnapshot: snapshotPolicy,
      }),
    );
    writeActivePolicyTransition(stateDir, sandboxName, processToken, snapshotPath, snapshotPolicy);
    const transitionPath = path.join(
      stateDir,
      `shields-transition-${sandboxName}-${processToken}.json`,
    );
    const statePath = path.join(stateDir, `shields-${sandboxName}.json`);
    const sourceModulePath = path.join(process.cwd(), "src", "lib", "shields", "index.ts");
    const { applyShieldsPolicySnapshot } = await import(sourceModulePath);
    const runPolicySet = vi.fn(() => ({ status: 0 }));

    let failure: unknown;
    try {
      applyShieldsPolicySnapshot(sandboxName, snapshotPath, {
        transitionProcessToken: processToken,
        inspectPolicyContext: () => ({
          gatewayName,
          basePolicyDocument: "version: 1\nnetwork_policies: {}\n",
          inspection: {
            policySource: "sandbox",
            effectivePolicy: { version: 1, network_policies: {} },
            policyIdentity: { hash: "policy-hash", activeVersion: 1 },
          },
        }),
        readBasePolicy: () => ({ ok: false, error }),
        runPolicySet,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = String((failure as Error).message);
    expect(message).toContain(`sandbox '${sandboxName}'`);
    expect(message).toContain(`recorded gateway '${gatewayName}'`);
    expect(message).toContain(error.message);
    expect(message).toContain(recovery);
    expect(message).toContain("`nemoclaw openclaw shields up`");
    expect(message).not.toContain("opaque-live-policy-credential");
    expect(runPolicySet).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(transitionPath)).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
});
