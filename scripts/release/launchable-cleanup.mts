// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

type CheckRun = {
  conclusion?: unknown;
  created_at?: unknown;
  details_url?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
  id?: unknown;
  name?: unknown;
  status?: unknown;
};

type CheckPage = { check_runs?: unknown };

const CONFIRMED_CLEANUP =
  /^confirmed absent: receipt=[A-Za-z0-9._/-]+; verified_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z; run_id=[0-9]+; job_id=[0-9]+$/u;
const REMEDIATED_CLEANUP =
  /^remediated: workspace_removed=true; credentials_rotated_or_revoked=BREV_API_KEY,NEMOCLAW_IMAGE_DISPATCH_TOKEN,NVIDIA_INFERENCE_API_KEY; workspace_name=[A-Za-z0-9._-]+; workspace_id=[A-Za-z0-9._-]+; run_id=[0-9]+; job_id=[0-9]+$/u;
const NO_CHECK_CLEANUP = "not applicable: no Launchable check ran";
const OWNER_URL = /\/actions\/runs\/(?<runId>[0-9]+)\/job\/(?<jobId>[0-9]+)(?:[?].*)?$/u;

function checkRunsFromPages(input: unknown): CheckRun[] {
  if (!Array.isArray(input)) throw new Error("check-run response must be paginated JSON");
  return input.flatMap((page: CheckPage) => {
    if (!page || !Array.isArray(page.check_runs)) {
      throw new Error("check-run response page is invalid");
    }
    return page.check_runs as CheckRun[];
  });
}

function cleanupKind(cleanup: string): "confirmed" | "not-applicable" | "remediated" {
  if (cleanup.startsWith("confirmed absent:")) {
    if (!CONFIRMED_CLEANUP.test(cleanup)) {
      throw new Error(
        "Confirmed Launchable cleanup must record a receipt and UTC verification time with run and job IDs",
      );
    }
    return "confirmed";
  }
  if (cleanup === NO_CHECK_CLEANUP) return "not-applicable";
  if (cleanup.startsWith("remediated:")) {
    if (!REMEDIATED_CLEANUP.test(cleanup)) {
      throw new Error(
        "Launchable remediation must use the affirmative workspace and credential record",
      );
    }
    return "remediated";
  }
  throw new Error("Release brief has unresolved Launchable workspace cleanup");
}

export function validateLaunchableCleanup(input: unknown, target: string, cleanup: string): void {
  const kind = cleanupKind(cleanup);
  const checks = checkRunsFromPages(input).filter(
    (check) => check.name === "Exact staging Brev Launchable",
  );
  if (checks.length === 0) {
    if (kind !== "not-applicable") {
      throw new Error("Missing Launchable status requires the no-check cleanup record");
    }
    return;
  }
  for (const check of checks) {
    if (check.head_sha !== target || typeof check.created_at !== "string") {
      throw new Error("Launchable check is not bound to the planned candidate");
    }
    if (typeof check.id !== "number" || !Number.isSafeInteger(check.id) || check.id < 1) {
      throw new Error("Launchable check ID is invalid");
    }
  }
  checks.sort((left, right) => {
    const created = String(left.created_at).localeCompare(String(right.created_at));
    return created || Number(left.id) - Number(right.id);
  });
  const check = checks.at(-1)!;
  const owner = String(check.details_url || check.html_url || "").match(OWNER_URL);
  if (!owner?.groups || typeof check.status !== "string") {
    throw new Error("Launchable check owner or status is invalid");
  }
  const identity = `; run_id=${owner.groups.runId}; job_id=${owner.groups.jobId}`;
  if (!cleanup.endsWith(identity)) {
    throw new Error("Launchable cleanup record does not match the candidate run and job");
  }
  const conclusion = check.conclusion == null ? "pending" : check.conclusion;
  if (typeof conclusion !== "string") throw new Error("Launchable conclusion is invalid");
  if (check.status === "completed" && conclusion === "success") {
    if (kind !== "confirmed") {
      throw new Error("Successful Launchable status requires a confirmed cleanup receipt");
    }
  } else if (kind !== "remediated") {
    throw new Error("Non-successful Launchable status requires completed cleanup remediation");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [checkRunsPath, target, cleanup] = process.argv.slice(2);
    if (!checkRunsPath || !target || !cleanup)
      throw new Error("Launchable cleanup arguments are required");
    validateLaunchableCleanup(JSON.parse(fs.readFileSync(checkRunsPath, "utf8")), target, cleanup);
  } catch (error) {
    console.error(`release-cut-tag: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
