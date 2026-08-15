// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  LLAMA_CPP_DGX_SPARK_SHA_PATTERN,
  type LlamaCppDgxSparkQualificationEvidenceIdentity,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

export interface LlamaCppDgxSparkQualificationEnvironment {
  activationRoot: string;
  artifactDirectory: string;
  evidenceFile: string;
  identity: LlamaCppDgxSparkQualificationEvidenceIdentity;
  planFile: string;
  planSha256: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

export function llamaCppDgxSparkQualificationEnvironment(): LlamaCppDgxSparkQualificationEnvironment {
  const identity = {
    baseSha: requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_BASE_SHA"),
    headSha: requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA"),
    runAttempt: positiveIntegerEnvironment("GITHUB_RUN_ATTEMPT"),
    runId: positiveIntegerEnvironment("GITHUB_RUN_ID"),
    workflowSha: requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_WORKFLOW_SHA"),
  };
  if (
    !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(identity.baseSha) ||
    !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(identity.headSha) ||
    !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(identity.workflowSha)
  ) {
    throw new Error("llama.cpp DGX Spark dispatch identity is invalid");
  }
  return {
    activationRoot: fs.realpathSync(
      requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_CANDIDATE_ROOT"),
    ),
    artifactDirectory: fs.realpathSync(requiredEnvironment("E2E_ARTIFACT_DIR")),
    evidenceFile: requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_EVIDENCE"),
    identity,
    planFile: requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN"),
    planSha256: requiredEnvironment("NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN_SHA256"),
  };
}

export function readLlamaCppQualificationArtifact(file: string, root: string): Buffer {
  const realRoot = fs.realpathSync(root);
  const parent = fs.realpathSync(path.dirname(file));
  const candidate = path.join(parent, path.basename(file));
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file} must be a child of the protected qualification root`);
  }
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > 1024 * 1024) {
      throw new Error(`${file} must be a bounded regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
