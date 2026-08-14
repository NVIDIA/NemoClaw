// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { readRegistrySandboxEntry } from "../fixtures/phases/index.ts";
import { runLaunchReadinessLeaseTurns } from "./launch-agent-turn.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_ACCEPTANCE_SANDBOX?.trim() ?? "";

test.runIf(process.platform === "linux" && SANDBOX_NAME.length > 0)(
  "launch readiness locked-image acceptance",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "verify the existing locked-image sandbox",
        "produce launch-readiness evidence",
        "complete two exact-reply PTY launch turns",
      ],
    },
  },
  async ({ host, progress }) => {
    progress.phase("verify the existing locked-image sandbox");
    const entry = readRegistrySandboxEntry(SANDBOX_NAME);
    expect(entry.agent).toBe("openclaw");
    expect(entry.workload).toMatchObject({ kind: "managed-image" });
    expect(typeof entry.workload).toBe("object");
    expect(entry.workload).not.toBeNull();
    const workload = entry.workload as Record<string, unknown>;
    expect(workload.reference).toMatch(/@sha256:[0-9a-f]{64}$/u);
    expect(entry.imageTag).toBe(workload.reference);
    progress.phase("produce launch-readiness evidence");
    await runLaunchReadinessLeaseTurns({
      artifactName: "launch-readiness-locked-image",
      cliCommand: process.execPath,
      cliEntrypoint: CLI_ENTRYPOINT,
      env: process.env,
      exitCommand: "/exit",
      host,
      postReplyReadyText: "gateway connected | idle",
      readyText: "gateway connected | idle",
      redactionValues: [],
      sandboxName: SANDBOX_NAME,
      beforeLaunchTurns: () => {
        progress.phase("complete two exact-reply PTY launch turns");
      },
    });
  },
);
