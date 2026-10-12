// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

it("accepts only a new mcporter lock identity while retaining base audit policy", () => {
  const workflow = readWorkflow("managed-images.yaml");
  const job = required(workflow.jobs?.["pr-build-and-entrypoint"], "missing PR image builder");
  const source = step(job, "Prepare same-run mcporter audit evidence").run ?? "";
  const script = required(source.match(/<<'NODE'\n([\s\S]*?)\nNODE/u)?.[1], "missing policy guard");
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-audit-policy-"));
  const trustedPath = path.join(directory, "trusted.json");
  const candidatePath = path.join(directory, "candidate.json");
  const outputPath = path.join(directory, "output.json");
  const graph = {
    id: "mcporter-runtime",
    packageSpec: "mcporter@0.7.3",
    lockSha256: "0".repeat(64),
  };
  const trusted = {
    severityThreshold: "high",
    exceptionFile: "trusted.json",
    lockedGraphs: [graph],
  };
  const candidateGraph = { ...graph, lockSha256: "1".repeat(64) };
  const candidate = {
    severityThreshold: "critical",
    exceptionFile: "untrusted.json",
    lockedGraphs: [candidateGraph],
  };
  try {
    writeFileSync(trustedPath, JSON.stringify(trusted));
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const args = ["--input-type=module", "-", trustedPath, candidatePath, outputPath];
    const accepted = spawnSync(process.execPath, args, { input: script, encoding: "utf8" });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
      ...trusted,
      lockedGraphs: [candidateGraph],
    });
    candidateGraph.packageSpec = "mcporter@99.0.0";
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const rejected = spawnSync(process.execPath, args, { input: script, encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      "Candidate mcporter package identity differs from the trusted base",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
