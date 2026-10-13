// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLlamaCppDgxSparkQualificationReceipt,
  verifyLlamaCppDgxSparkExecutionPlanSha256,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [receiptFile, planFile, digest, ...extra] = process.argv.slice(2);
  if (!receiptFile || !planFile || !digest || extra.length) {
    throw new Error("usage: validate-llama-cpp-dgx-spark-receipt.mts RECEIPT PLAN PLAN_SHA256");
  }
  validateLlamaCppDgxSparkReceipt(readArtifact(receiptFile), readArtifact(planFile), digest, {
    baseSha: process.env.BASE_SHA,
    headSha: process.env.CHECKOUT_SHA,
    workflowSha: process.env.WORKFLOW_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  process.stdout.write("Verified DGX Spark qualification receipt and plan identity.\n");
}
