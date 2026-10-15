// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLlamaCppDgxSparkQualificationReceipt,
  verifyLlamaCppDgxSparkExecutionPlanSha256,
  createLlamaCppDgxSparkFailureDiagnostic,
  parseLlamaCppDgxSparkFailureDiagnostic,
} from "./llama-cpp-dgx-spark-qualification-contract.mts";

export function validateLlamaCppDgxSparkReceipt(
  receiptSource: string,
  planSource: string,
  planSha256: string,
  identity: unknown,
) {
  const plan = verifyLlamaCppDgxSparkExecutionPlanSha256(JSON.parse(planSource), planSha256);
  return parseLlamaCppDgxSparkQualificationReceipt(JSON.parse(receiptSource), identity, plan);
}

function readArtifact(file: string): string {
  const resolved = path.resolve(file);
  if (fs.realpathSync(resolved) !== resolved)
    throw new Error("qualification artifact is a symlink");
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) {
      throw new Error("qualification artifact must be a bounded regular file");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function publishLlamaCppDgxSparkArtifacts(
  directory: string,
  planSha256: string,
  identity: unknown,
  executionOutcome: string,
  cleanupOutcome: string,
) {
  if (
    !["success", "failure", "cancelled"].includes(executionOutcome) ||
    !["success", "failure", "cancelled", "skipped"].includes(cleanupOutcome)
  )
    throw new Error("invalid Spark execution outcome");
  const root = path.resolve(directory);
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory())
    throw new Error("Spark artifact directory must be a real directory");
  const published = path.join(root, "published");
  const outputs: Record<string, string> = {};
  if (executionOutcome === "success" && cleanupOutcome === "success") {
    const planSource = readArtifact(path.join(root, "plan.json"));
    const receipt = validateLlamaCppDgxSparkReceipt(
      readArtifact(path.join(root, "receipt.json")),
      planSource,
      planSha256,
      identity,
    );
    outputs["receipt.json"] = JSON.stringify(receipt);
    outputs["plan.json"] = planSource;
    outputs["plan-sha256"] = planSha256;
  } else {
    const failureFile = path.join(root, "failure.json");
    const diagnostic =
      executionOutcome === "success"
        ? createLlamaCppDgxSparkFailureDiagnostic(
            identity,
            planSha256,
            "cleanup",
            false,
            "cleanup-incomplete",
          )
        : fs.existsSync(failureFile)
          ? parseLlamaCppDgxSparkFailureDiagnostic(
              JSON.parse(readArtifact(failureFile)),
              identity,
              planSha256,
            )
          : createLlamaCppDgxSparkFailureDiagnostic(identity, planSha256, "interrupted", false);
    outputs["failure.json"] = JSON.stringify({
      ...diagnostic,
      cleanupComplete: diagnostic.cleanupComplete && cleanupOutcome === "success",
    });
  }
  // A fresh staging directory publishes only validated canonical records, not input logs.
  fs.mkdirSync(published, { mode: 0o700 });
  for (const [name, source] of Object.entries(outputs))
    fs.writeFileSync(path.join(published, name), source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  return published;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const identity = {
    baseSha: process.env.BASE_SHA,
    headSha: process.env.CHECKOUT_SHA,
    workflowSha: process.env.WORKFLOW_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  if (process.argv[2] === "--publish") {
    const [directory, execution, cleanup, digest, ...extra] = process.argv.slice(3);
    if (!directory || !execution || !cleanup || !digest || extra.length)
      throw new Error(
        "usage: validate-llama-cpp-dgx-spark-receipt.mts --publish DIRECTORY EXECUTION CLEANUP PLAN_SHA256",
      );
    publishLlamaCppDgxSparkArtifacts(directory, digest, identity, execution, cleanup);
    process.stdout.write("Validated bounded Spark qualification artifacts.\n");
  } else {
    const [receiptFile, planFile, digest, ...extra] = process.argv.slice(2);
    if (!receiptFile || !planFile || !digest || extra.length) {
      throw new Error("usage: validate-llama-cpp-dgx-spark-receipt.mts RECEIPT PLAN PLAN_SHA256");
    }
    validateLlamaCppDgxSparkReceipt(
      readArtifact(receiptFile),
      readArtifact(planFile),
      digest,
      identity,
    );
    process.stdout.write("Verified DGX Spark qualification receipt and plan identity.\n");
  }
}
