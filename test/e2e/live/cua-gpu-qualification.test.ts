// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import {
  assertCuaQualificationBinding,
  parseCuaQualificationEnvironment,
  parseCuaQualificationReceipt,
} from "../../../tools/e2e/cua-qualification-receipt.mts";
import { expect, test } from "../fixtures/e2e-test.ts";

const ENVIRONMENT_FILE = "/etc/nemoclaw/cua-qualification-environment.json";
const RECEIPT_FILE = "/var/lib/nemoclaw/cua-qualification-receipt.json";

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

const runCuaGpuQualification = test.skipIf(process.env.NEMOCLAW_RUN_CUA_GPU_QUALIFICATION !== "1");

runCuaGpuQualification(
  "CUA GPU qualification accepts only a receipt bound to the external environment, candidate, and live GPU count (#7753)",
  {
    timeout: 60_000,
    meta: {
      e2ePhases: [
        "require explicit CUA GPU qualification selection",
        "read the public environment and qualification identities",
        "verify the checked-out candidate identity",
        "verify the live GPU identity",
      ],
    },
  },
  async ({ host, progress }) => {
    progress.phase("read the public environment and qualification identities");
    const environment = parseCuaQualificationEnvironment(readJson(ENVIRONMENT_FILE));
    const receipt = parseCuaQualificationReceipt(readJson(RECEIPT_FILE));
    assertCuaQualificationBinding(environment, receipt);
    progress.phase("verify the checked-out candidate identity");
    const candidate = await host.command("git", ["rev-parse", "HEAD"], {
      artifactName: "cua-qualification-candidate",
      timeoutMs: 10_000,
    });
    expect(candidate.exitCode).toBe(0);
    const candidateCommit = candidate.stdout.trim();
    progress.phase("verify the live GPU identity");
    const liveGpus = await host.command(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      {
        artifactName: "cua-qualification-gpus",
        timeoutMs: 10_000,
      },
    );
    expect(liveGpus.exitCode).toBe(0);
    const liveGpuCount = Number(liveGpus.stdout.split(/\r?\n/).filter(Boolean).length);

    expect(candidateCommit).toBe(receipt.nemoclawCommit);
    expect(liveGpuCount).toBeGreaterThan(0);
    expect(liveGpuCount).toBe(receipt.gpu.count);
  },
);
