// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, type MockInstance } from "vitest";
import type { SandboxEntry } from "../../src/lib/state/registry";

export const pendingPolicyTransitionCases = [
  {
    label: "custom policy",
    transition: {
      customPolicyTransition: {
        version: 1 as const,
        id: "123e4567-e89b-42d3-a456-426614174000",
        operation: "apply" as const,
        name: "private-api",
        previous: null,
        desired: {
          name: "private-api",
          content: "network_policies:\n  private_api: {}\n",
          appliedAt: "2026-08-06T12:00:00.000Z",
        },
        startedAt: "2026-08-06T12:00:00.000Z",
      },
    },
  },
  {
    label: "baseline policy",
    transition: {
      baselineExclusionTransition: {
        id: "123e4567-e89b-42d3-a456-426614174001",
        operation: "exclude" as const,
        exclusion: {
          version: 1 as const,
          agent: "openclaw",
          key: "baseline_api",
          digest: "a".repeat(64),
          acknowledgedAt: "2026-08-06T12:00:00.000Z",
        },
        targetLiveDigest: null,
        startedAt: "2026-08-06T12:00:00.000Z",
      },
    },
  },
];

export function expectStagedDriverNeutralRecovery(
  errorSpy: MockInstance,
  sandboxName: string,
  cliName = "nemoclaw",
): string {
  const output = errorSpy.mock.calls.flat().map(String).join("\n");
  expect(output).toContain(
    `Recovery: confirm the sandbox is running and ready, then retry \`${cliName} ${sandboxName} shields up\`.`,
  );
  expect(output).toContain(
    `If the retry still fails, rebuild a known-good baseline with \`${cliName} ${sandboxName} rebuild --yes\`.`,
  );
  expect(output).not.toMatch(/kubectl/i);
  return output;
}

export function writeExpiredShieldsFixture(
  tmpDir: string,
  currentProcessStartIdentity: string | null,
  processToken: string,
  reason: string,
  ownerState: "dead" | "live",
) {
  const liveOwner = ownerState === "live";
  const sandboxName = "openclaw";
  const stateDir = path.join(tmpDir, ".nemoclaw", "state");
  const snapshotPath = path.join(stateDir, `snapshot-${processToken.slice(0, 8)}.yaml`);
  const timerMarkerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
  const transitionLockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({
      shieldsDown: true,
      shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
      shieldsDownTimeout: 60,
      shieldsDownReason: reason,
      shieldsDownPolicy: "permissive",
      shieldsPolicySnapshotPath: snapshotPath,
    }),
  );
  fs.writeFileSync(
    timerMarkerPath,
    JSON.stringify({
      pid: liveOwner ? 2_147_483_647 : 4242,
      sandboxName,
      snapshotPath,
      restoreAt: new Date(Date.now() - 60_000).toISOString(),
      processToken,
    }),
  );
  fs.writeFileSync(
    transitionLockPath,
    JSON.stringify({
      version: 1,
      sandboxName,
      pid: liveOwner ? process.pid : 4242,
      processStartIdentity: liveOwner ? currentProcessStartIdentity : "dead-timer",
      command: liveOwner ? "shields down" : "shields auto-restore",
      acquiredAtMs: Date.now() - 60_000,
      takeoverToken: processToken,
    }),
  );
  return { stateDir, timerMarkerPath, transitionLockPath };
}

export function createObservedPendingPolicySandbox(onRead: () => void): SandboxEntry {
  const sandboxEntry = {
    name: "openclaw",
    openshellDriver: "docker",
  } as SandboxEntry;
  Object.defineProperty(sandboxEntry, "customPolicyTransition", {
    configurable: true,
    enumerable: true,
    get: () => {
      onRead();
      return {
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174002",
        operation: "remove",
        name: "private-api",
        previous: {
          name: "private-api",
          content: "network_policies:\n  private_api: {}\n",
        },
        desired: null,
        startedAt: "2026-08-06T12:00:00.000Z",
      };
    },
  });
  return sandboxEntry;
}

export function writePendingPolicyJournalShieldsFixture(
  tmpDir: string,
  transition: Record<string, unknown>,
) {
  const stateDir = path.join(tmpDir, ".nemoclaw", "state");
  const snapshotPath = path.join(stateDir, "policy-snapshot-pending-journal.yaml");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  restrictive: {}\n");
  fs.writeFileSync(
    path.join(stateDir, "shields-openclaw.json"),
    JSON.stringify({ shieldsDown: true, shieldsPolicySnapshotPath: snapshotPath }),
  );
  const sandboxEntry = {
    name: "openclaw",
    openshellDriver: "docker",
    ...transition,
  } as unknown as SandboxEntry;
  return { sandboxEntry, stateDir };
}
