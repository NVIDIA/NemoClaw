// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_NAME = /(auth|credential|key|password|secret|token)/iu;
const SECRET_VALUE =
  /\b((?:api[_-]?key|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTH_VALUE = /\b(authorization\s*[:=]\s*)(?:[^\s,;]+\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER = /\b(bearer)\s+[^\s,;]+/giu;
export function redactAdvisorDiagnostic(detail: string): string {
  for (const [name, value] of Object.entries(process.env))
    if (value && SECRET_NAME.test(name)) detail = detail.replaceAll(value, "[REDACTED]");
  return detail
    .replace(AUTH_VALUE, "$1[REDACTED]")
    .replace(SECRET_VALUE, "$1[REDACTED]")
    .replace(BEARER, "$1 [REDACTED]");
}

export function recordAdvisorJobFailure(env: NodeJS.ProcessEnv): void {
  const artifact = env.PR_REVIEW_ADVISOR_ARTIFACT_DIR;
  if (!artifact || !/^[a-z0-9][a-z0-9-]*$/u.test(artifact) || !env.GITHUB_WORKSPACE) {
    throw new Error(
      "Advisor failure artifact requires a workspace and simple artifact directory name",
    );
  }
  const directory = path.join(env.GITHUB_WORKSPACE, "artifacts", artifact);
  fs.mkdirSync(directory, { recursive: true });
  const record = {
    status: "failed",
    specialist: env.PR_REVIEW_ADVISOR_INTEREST,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    repository: env.GITHUB_REPOSITORY,
    expectedHeadSha: env.EXPECTED_HEAD_SHA,
    classification:
      env.ADVISOR_PREPARATION_CLASSIFICATION === "superseded" ? "superseded" : "failed",
    steps: {
      preparation: env.ADVISOR_PREPARATION_OUTCOME,
      runtime: env.ADVISOR_RUNTIME_OUTCOME,
      analysis: env.ADVISOR_ANALYSIS_OUTCOME,
    },
  };
  // Separate from model output so setup failures also retain a host-owned receipt.
  fs.writeFileSync(path.join(directory, "job-failure.json"), JSON.stringify(record, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recordAdvisorJobFailure(process.env);
}
