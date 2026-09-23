// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_NAME = /(auth|credential|key|password|secret|token)/iu;
const SECRET_VALUE =
  /((?:(?<quote>["'])(?:api[_-]?key|credential|password|secret|token)\k<quote>|\b(?:api[_-]?key|credential|password|secret|token)\b)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTH_VALUE =
  /((?:(?<quote>["'])authorization\k<quote>|\bauthorization\b)\s*[:=]\s*)(?:[^\s,;]+\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
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
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const root = path.join(workspace, "artifacts");
  const directory = path.join(root, artifact);
  // Recovery has finished before this host write. Reject links at each untrusted
  // path component; exclusive creation below also rejects an existing receipt.
  for (const component of [root, directory]) {
    try {
      fs.mkdirSync(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!fs.lstatSync(component).isDirectory() || fs.realpathSync(component) !== component) {
      throw new Error("Advisor failure artifact directory must be a real directory");
    }
  }
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
      dispatchCheckout: env.ADVISOR_DISPATCH_CHECKOUT_OUTCOME,
      defaultWorkdir: env.ADVISOR_DEFAULT_WORKDIR_OUTCOME,
      nodeSetup: env.ADVISOR_NODE_SETUP_OUTCOME,
      npmSetup: env.ADVISOR_NPM_SETUP_OUTCOME,
      runtimeImage: env.ADVISOR_RUNTIME_IMAGE_OUTCOME,
      preparation: env.ADVISOR_PREPARATION_OUTCOME,
      removeSymlinks: env.ADVISOR_REMOVE_SYMLINKS_OUTCOME,
      runtimeDownload: env.ADVISOR_RUNTIME_DOWNLOAD_OUTCOME,
      runtimeRestore: env.ADVISOR_RUNTIME_RESTORE_OUTCOME,
      contextDownload: env.ADVISOR_CONTEXT_DOWNLOAD_OUTCOME,
      sandboxInputs: env.ADVISOR_SANDBOX_INPUTS_OUTCOME,
      openShellInstall: env.ADVISOR_OPENSHELL_INSTALL_OUTCOME,
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
