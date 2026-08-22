// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../../agent/runtime";
import { inspectPortableAgentReceiptDisposition } from "../../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../../state/mcp-lifecycle-lock";
import { connectSandbox } from "../connect";
import {
  prepareHermesCronRestoreRecovery,
  recoverHermesCronRestore,
} from "../rebuild-hermes-post-restore";

const RECOVERY_LOCK_TIMEOUT_MS = 30_000;

/** Re-establish a Hermes gate before gateway repair, then validate and release it. */
export async function recoverSandboxWithHermesCronRestore(sandboxName: string): Promise<void> {
  await withMcpLifecycleLock(
    sandboxName,
    async () => {
      const portable = inspectPortableAgentReceiptDisposition(sandboxName);
      if (portable.kind === "hermes") {
        await connectSandbox(sandboxName, {
          probeOnly: true,
          requireLaunchReadinessPublication: false,
        });
        return;
      }
      const agent = agentRuntime.getSessionAgent(sandboxName);
      if (agent?.name === "hermes") {
        prepareHermesCronRestoreRecovery(sandboxName);
      }
      await connectSandbox(sandboxName, {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      });
      if (agent?.name !== "hermes") return;

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
