// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  accessSync,
  constants,
  type Dirent,
  lstatSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { type OpenRegularFile, openRegularFileNoFollow } from "../../adapters/fs/regular-file";

const HERMES_RUNTIME_HOME = "/sandbox/.hermes";
const HERMES_SANDBOX_HOME = "/sandbox";
const MAX_JOBS_BYTES = 8 * 1024 * 1024;

export interface HermesCronRestorePlan {
  activeJobs: number;
  scriptJobs: number;
  requiresDispatchGate: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePathMetadata(target: string, description: string): Stats {
  let metadata: Stats;
  try {
    metadata = lstatSync(target);
  } catch (error) {
    throw new Error(`${description} is missing or unreadable: ${describeError(error)}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink`);
  }
  return metadata;
}

function readJobs(profileLabel: string, profileBackupHome: string): Record<string, unknown>[] {
  const jobsPath = path.join(profileBackupHome, "cron", "jobs.json");
  let jobsFile: OpenRegularFile;
  try {
    jobsFile = openRegularFileNoFollow(jobsPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new Error(`${profileLabel} cron store is unreadable: ${describeError(error)}`);
  }

  let contents: string;
  try {
    contents = jobsFile.readUtf8(MAX_JOBS_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`${profileLabel} cron store exceeds the validation limit`);
    }
    throw new Error(`${profileLabel} cron store is invalid: ${describeError(error)}`);
  } finally {
    jobsFile.close();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(contents.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${profileLabel} cron store is invalid: ${describeError(error)}`);
  }
  const jobs = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as { jobs?: unknown }).jobs
      : undefined;
  if (!Array.isArray(jobs) || jobs.some((job) => !job || typeof job !== "object")) {
    throw new Error(`${profileLabel} cron store has an invalid jobs collection`);
  }
  return jobs as Record<string, unknown>[];
}

function relativeRuntimeScript(rawScript: string, runtimeProfileHome: string): string {
  const runtimeRoot = path.resolve(runtimeProfileHome, "scripts");
  let candidate: string;
  if (rawScript === "~") {
    candidate = HERMES_SANDBOX_HOME;
  } else if (rawScript.startsWith("~/")) {
    candidate = path.join(HERMES_SANDBOX_HOME, rawScript.slice(2));
  } else if (rawScript.startsWith("~")) {
    throw new Error("script path uses an unsupported user-home expansion");
  } else {
    candidate = path.isAbsolute(rawScript) ? rawScript : path.join(runtimeRoot, rawScript);
  }
  const relativeScript = path.relative(runtimeRoot, path.resolve(candidate));
  if (
    relativeScript === "" ||
    relativeScript === ".." ||
    relativeScript.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeScript)
  ) {
    throw new Error("script path resolves outside its profile scripts directory");
  }
  return relativeScript;
}

function validateBackupScript(
  profileLabel: string,
  jobIndex: number,
  script: string,
  profileBackupHome: string,
  runtimeProfileHome: string,
): void {
  const relativeScript = relativeRuntimeScript(script, runtimeProfileHome);
  const scriptsRoot = path.join(profileBackupHome, "scripts");
  const rootMetadata = requirePathMetadata(scriptsRoot, `${profileLabel} scripts root`);
  if (!rootMetadata.isDirectory()) {
    throw new Error(`${profileLabel} scripts root is not a directory`);
  }
  const scriptPath = path.join(scriptsRoot, relativeScript);
  const scriptMetadata = requirePathMetadata(
    scriptPath,
    `${profileLabel} active job #${jobIndex} script`,
  );
  if (!scriptMetadata.isFile()) {
    throw new Error(`${profileLabel} active job #${jobIndex} script is not a regular file`);
  }
  const resolvedRoot = realpathSync(scriptsRoot);
  const resolvedScript = realpathSync(scriptPath);
  const resolvedRelative = path.relative(resolvedRoot, resolvedScript);
  if (
    resolvedRelative === "" ||
    resolvedRelative === ".." ||
    resolvedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolvedRelative)
  ) {
    throw new Error(`${profileLabel} active job #${jobIndex} script escapes its profile`);
  }
  if ((scriptMetadata.mode & 0o444) === 0) {
    throw new Error(`${profileLabel} active job #${jobIndex} script is not readable`);
  }
  try {
    accessSync(resolvedScript, constants.R_OK);
  } catch {
    throw new Error(`${profileLabel} active job #${jobIndex} script is not readable`);
  }
}

function profileHomes(
  backupPath: string,
): Array<{ label: string; backupHome: string; runtimeHome: string }> {
  const homes = [
    {
      label: "default profile",
      backupHome: backupPath,
      runtimeHome: HERMES_RUNTIME_HOME,
    },
  ];
  const profilesRoot = path.join(backupPath, "profiles");
  let entries: Dirent[];
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return homes;
    throw new Error(`named profile state is unreadable: ${describeError(error)}`);
  }
  const rootMetadata = requirePathMetadata(profilesRoot, "named profiles root");
  if (!rootMetadata.isDirectory()) {
    throw new Error("named profiles root is not a directory");
  }
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    if (entry.isSymbolicLink()) {
      throw new Error("named profile state contains a symlink");
    }
  }
  for (const [index, entry] of sortedEntries
    .filter((candidate) => candidate.isDirectory())
    .entries()) {
    const profileBackupHome = path.join(profilesRoot, entry.name);
    const metadata = requirePathMetadata(profileBackupHome, `named profile #${index + 1}`);
    if (!metadata.isDirectory()) {
      throw new Error(`named profile #${index + 1} is not a directory`);
    }
    homes.push({
      label: `named profile #${index + 1}`,
      backupHome: profileBackupHome,
      runtimeHome: path.join(HERMES_RUNTIME_HOME, "profiles", entry.name),
    });
  }
  return homes;
}

export function validateHermesCronRestoreBackup(backupPath: string): HermesCronRestorePlan {
  const backupMetadata = requirePathMetadata(backupPath, "Hermes rebuild backup");
  if (!backupMetadata.isDirectory()) {
    throw new Error("Hermes rebuild backup is not a directory");
  }
  let activeJobs = 0;
  let scriptJobs = 0;
  for (const profile of profileHomes(backupPath)) {
    for (const [index, job] of readJobs(profile.label, profile.backupHome).entries()) {
      if (job.enabled === false || job.state === "paused") continue;
      activeJobs += 1;
      if (job.script === undefined || job.script === null || job.script === "") continue;
      if (typeof job.script !== "string" || !job.script.trim()) {
        throw new Error(`${profile.label} active job #${index + 1} has an invalid script`);
      }
      scriptJobs += 1;
      validateBackupScript(
        profile.label,
        index + 1,
        job.script.trim(),
        profile.backupHome,
        profile.runtimeHome,
      );
    }
  }
  return {
    activeJobs,
    scriptJobs,
    requiresDispatchGate: scriptJobs > 0,
  };
}
