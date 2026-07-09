// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { expect, test } from "vitest";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import { fingerprintRebuildReplacement } from "../../src/lib/rebuild-correlation";
import { RebuildTransactionStore } from "../../src/lib/state/rebuild-transaction";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  makeRebuildFlowSandboxEntry,
} from "../helpers/rebuild-flow-test-harness";

const role = process.env.NEMOCLAW_REBUILD_PROCESS_ROLE;
const phase = process.env.NEMOCLAW_REBUILD_PROCESS_PHASE;
const stateDir = process.env.NEMOCLAW_REBUILD_PROCESS_STATE_DIR;
const eventsFile = process.env.NEMOCLAW_REBUILD_PROCESS_EVENTS;
const replacementFile = process.env.NEMOCLAW_REBUILD_PROCESS_REPLACEMENT;

installRebuildFlowTestHooks();

test.skipIf(!role)(
  "runs one rebuild transaction process",
  async () => {
    expect(
      stateDir &&
        eventsFile &&
        replacementFile &&
        [
          "prepared",
          "delete_unjournaled",
          "replacement_unjournaled",
          "replacement_created",
          "state_restored",
          "required_verified",
        ].includes(phase ?? ""),
    ).toBe(true);
    const manifest = makePreparedRecoveryManifest();
    const transactionStore = new RebuildTransactionStore({ stateDir: stateDir! });
    const recovered = role === "resume" ? transactionStore.load("alpha") : null;
    const replacementObserved =
      role === "resume" &&
      (phase === "replacement_unjournaled" ||
        phase === "replacement_created" ||
        phase === "state_restored" ||
        phase === "required_verified");
    const replacementEntry = makeRebuildFlowSandboxEntry(
      phase === "replacement_unjournaled"
        ? {
            credentialEnv: null,
            observabilityEnabled: false,
            policyPresetsFinalized: true,
            toolDisclosure: "progressive",
          }
        : { policyPresetsFinalized: true },
    );
    const harness = createRebuildFlowHarness({
      staleRecovery: role === "resume" && phase === "delete_unjournaled",
      sandboxEntry: replacementObserved ? replacementEntry : undefined,
      sessionRebuildTransactionId: replacementObserved ? recovered?.transactionId : undefined,
      sessionRebuildImageFingerprint: replacementObserved
        ? recovered?.intent.target.imageFingerprint
        : undefined,
      sessionRebuildConfigurationFingerprint: replacementObserved
        ? recovered?.intent.target.configurationFingerprint
        : undefined,
      sessionRebuildReplacementFingerprint: replacementObserved
        ? fingerprintRebuildReplacement(replacementEntry)
        : undefined,
      preDeleteLatestManifest: manifest,
      onboard: (session) => {
        fs.appendFileSync(eventsFile!, `onboard:${role}\n`);
        fs.writeFileSync(
          replacementFile!,
          JSON.stringify({
            transactionId: (
              (session.metadata as Record<string, unknown>).rebuild as Record<string, unknown>
            ).transactionId,
          }),
        );
      },
      restoreSandboxState: () => {
        fs.appendFileSync(eventsFile!, "restore\n");
        return {
          success: true,
          restoredDirs: ["workspace"],
          restoredFiles: ["user.md"],
          failedDirs: [],
          failedFiles: [],
        };
      },
      runOpenshell: (args) =>
        args[0] === "sandbox" && args[1] === "delete"
          ? (fs.appendFileSync(eventsFile!, "delete\n"), { status: 0, output: "" })
          : { status: 0, output: "" },
    });

    await harness.rebuildSandbox("alpha", ["--yes"], {
      throwOnError: true,
      transactionStore,
      recoveryManifest: role === "interrupt" ? manifest : undefined,
    });

    expect(transactionStore.load("alpha")).toMatchObject({
      status: "completed",
      phase: "completed",
    });
  },
  45_000,
);
