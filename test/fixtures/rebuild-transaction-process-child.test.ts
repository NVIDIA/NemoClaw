// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { expect, test } from "vitest";

import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import { RebuildTransactionStore } from "../../src/lib/state/rebuild-transaction";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../helpers/rebuild-flow-test-harness";

const role = process.env.NEMOCLAW_REBUILD_PROCESS_ROLE;
const phase = process.env.NEMOCLAW_REBUILD_PROCESS_PHASE;
const stateDir = process.env.NEMOCLAW_REBUILD_PROCESS_STATE_DIR;
const eventsFile = process.env.NEMOCLAW_REBUILD_PROCESS_EVENTS;

installRebuildFlowTestHooks();

test.skipIf(!role)(
  "runs one rebuild transaction process",
  async () => {
    expect(stateDir && eventsFile && (phase === "prepared" || phase === "delete_unjournaled")).toBe(
      true,
    );
    const manifest = makePreparedRecoveryManifest();
    const harness = createRebuildFlowHarness({
      staleRecovery: role === "resume" && phase === "delete_unjournaled",
      preDeleteLatestManifest: manifest,
      runOpenshell: (args) =>
        args[0] === "sandbox" && args[1] === "delete"
          ? (fs.appendFileSync(eventsFile!, "delete\n"), { status: 0, output: "" })
          : { status: 0, output: "" },
    });
    const transactionStore = new RebuildTransactionStore({ stateDir: stateDir! });

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
