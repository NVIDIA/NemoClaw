// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { stripAnsi } from "./json-envelope.ts";

/** Verify that the pinned gateway accepts the generated rootless Podman configuration. */
export async function verifyPinnedPodmanGatewayStarts(
  gatewayBin: string,
  gatewayEnv: Record<string, string>,
  progress: TestProgress,
  whileRunning?: () => Promise<void>,
): Promise<void> {
  const child = spawnObservedChild(gatewayBin, [], {
    activityLabel: "command: pinned OpenShell Podman gateway",
    progress,
    spawn: {
      env: { ...process.env, ...gatewayEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    const deadline = Date.now() + 15_000;
    let driverSeenAt = 0;
    while (Date.now() < deadline) {
      const plainOutput = stripAnsi(output);
      if (/configuration error|invalid \[openshell\.drivers\.podman\] table/i.test(plainOutput)) {
        assert.fail(`Pinned OpenShell rejected the generated Podman configuration:\n${output}`);
      }
      if (child.exitCode !== null) {
        assert.fail(
          `Pinned OpenShell Podman gateway exited with ${String(child.exitCode)}:\n${output}`,
        );
      }
      if (/Using compute driver\s+driver=podman/.test(plainOutput)) {
        if (driverSeenAt === 0) driverSeenAt = Date.now();
        if (Date.now() - driverSeenAt >= 2_000) {
          await whileRunning?.();
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(
      `Pinned OpenShell did not report driver=podman and remain running for two seconds:\n${output}`,
    );
  } finally {
    child.kill("SIGTERM");
  }
}
