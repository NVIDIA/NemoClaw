// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const OFFICIAL_REPOSITORY = "https://github.com/NVIDIA/NemoClaw.git";
const BASE_COMPARISON_REF = "refs/remotes/origin/main";

type HostCommandClient = Pick<HostCliClient, "command">;

type WorkflowDispatchEvent = {
  inputs?: {
    base_sha?: unknown;
  };
};

export function readApprovedPrBaseSha(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") return null;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("workflow_dispatch is missing GITHUB_EVENT_PATH");

  let event: WorkflowDispatchEvent;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as WorkflowDispatchEvent;
  } catch (error) {
    throw new Error("Could not read the workflow_dispatch event payload", { cause: error });
  }

  const value = event.inputs?.base_sha;
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new Error("workflow_dispatch base_sha must be a lowercase 40-character commit SHA");
  }
  return value;
}

async function runGit(
  host: HostCommandClient,
  args: string[],
  artifactName: string,
): Promise<string> {
  const result = await host.command("git", args, {
    artifactName,
    cwd: REPO_ROOT,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not prepare the approved PR base comparison: ${resultText(result)}`);
  }
  return result.stdout.trim();
}

/**
 * Fork checkouts can have a stale `origin/main`. Bind the ephemeral comparison
 * ref to the base commit already approved by the trusted PR E2E controller so
 * only real base-image input changes force the expensive local build.
 */
export async function bindApprovedPrBaseForBaseImageComparison(
  host: HostCommandClient,
  enabled = true,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!enabled) return;
  const baseSha = readApprovedPrBaseSha(env);
  if (!baseSha) return;

  await runGit(
    host,
    ["fetch", "--no-tags", "--depth=1", OFFICIAL_REPOSITORY, baseSha],
    "phase-0-fetch-approved-pr-base",
  );
  const fetchedSha = await runGit(
    host,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    "phase-0-verify-approved-pr-base",
  );
  if (fetchedSha !== baseSha) {
    throw new Error(`Fetched PR base ${fetchedSha || "<empty>"} did not match ${baseSha}`);
  }
  await runGit(host, ["update-ref", BASE_COMPARISON_REF, baseSha], "phase-0-bind-approved-pr-base");
}
