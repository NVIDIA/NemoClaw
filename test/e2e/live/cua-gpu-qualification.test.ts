// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { parseCuaQualificationReceipt } from "../../../tools/e2e/cua-qualification-receipt.mts";
import { expect, test } from "../fixtures/e2e-test.ts";

const IDENTITY_FILE = "/var/lib/nemoclaw/cua-launchable-identity.json";
const RECEIPT_FILE = "/var/lib/nemoclaw/cua-qualification-receipt.json";

type LaunchableIdentity = {
  schemaVersion: "1.0.0";
  kind: "cua-launchable-identity";
  launchableVersion: string;
  launchableDigest: string;
  nemoclawCommit: string;
  gpu: {
    count: number;
    model: string;
    driverVersion: string;
    cudaVersion: string;
    containerToolkitVersion: string;
    probeImageDigest: string;
  };
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

test("CUA GPU qualification accepts only a receipt bound to this Launchable, candidate, and live GPU (#7753)", {
  timeout: 60_000,
  meta: {
    e2ePhases: [
      "require explicit CUA GPU qualification selection",
      "read the public Launchable and qualification identities",
      "verify the checked-out candidate identity",
      "verify the live GPU identity",
    ],
  },
}, async ({ host, progress, skip }) => {
  if (process.env.NEMOCLAW_RUN_CUA_GPU_QUALIFICATION !== "1") {
    skip("set NEMOCLAW_RUN_CUA_GPU_QUALIFICATION=1 on the qualification Launchable");
  }
  progress.phase("read the public Launchable and qualification identities");
  const identity = readJson(IDENTITY_FILE) as LaunchableIdentity;
  const receipt = parseCuaQualificationReceipt(readJson(RECEIPT_FILE));
  progress.phase("verify the checked-out candidate identity");
  const candidate = await host.command("git", ["rev-parse", "HEAD"], {
    artifactName: "cua-qualification-candidate",
    timeoutMs: 10_000,
  });
  expect(candidate.exitCode).toBe(0);
  const candidateCommit = candidate.stdout.trim();
  progress.phase("verify the live GPU identity");
  const liveGpus = await host.command("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    artifactName: "cua-qualification-gpus",
    timeoutMs: 10_000,
  });
  expect(liveGpus.exitCode).toBe(0);
  const liveGpuCount = Number(liveGpus.stdout.split(/\r?\n/).filter(Boolean).length);

  expect(identity).toEqual({
    schemaVersion: "1.0.0",
    kind: "cua-launchable-identity",
    launchableVersion: receipt.launchable.version,
    launchableDigest: receipt.launchable.digest,
    nemoclawCommit: receipt.nemoclawCommit,
    gpu: receipt.gpu,
  });
  expect(candidateCommit).toBe(receipt.nemoclawCommit);
  expect(liveGpuCount).toBeGreaterThan(0);
  expect(liveGpuCount).toBe(receipt.gpu.count);
});
