// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../../agent/runtime";
import { withMcpLifecycleLock } from "../../../state/mcp-lifecycle-lock";
import { connectSandbox } from "../connect";
import { recoverHermesCronRestore } from "../rebuild-hermes-post-restore";

const RECOVERY_LOCK_TIMEOUT_MS = 30_000;

/** Repair the gateway first, then validate and release any stranded Hermes cron restore gate. */
export async function recoverSandboxWithHermesCronRestore(sandboxName: string): Promise<void> {
  await withMcpLifecycleLock(
    sandboxName,
    async () => {
      await connectSandbox(sandboxName, { probeOnly: true });
      if (agentRuntime.getSessionAgent(sandboxName)?.name !== "hermes") return;

      const outcome = recoverHermesCronRestore(sandboxName);
      switch (outcome) {
        case "dispatch-reactivated":
          console.log(
            "  Hermes cron dispatch resumed after restored jobs and scripts were validated.",
          );
          return;
        case "operator-drain-preserved":
          console.log(
            "  Hermes cron restore gate cleared; the independent operator drain remains active.",
          );
          return;
        case "not-required":
        case "unsupported":
          return;
      }
    },
    { timeoutMs: RECOVERY_LOCK_TIMEOUT_MS },
  );
}
