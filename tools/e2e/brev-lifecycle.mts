#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Trusted Brev branch-validation lifecycle operations (#6962).
 *
 * Subcommands:
 *   install-cli     Download the pinned Brev CLI, verify its checksum, log in,
 *                   suppress first-run onboarding, and confirm readiness.
 *   collect-debug   Best-effort capture of a debug bundle from the instance,
 *                   before it is deleted.
 *   delete-instance Idempotent, retrying teardown that validates brev ls --json
 *                   and fails visibly only after the final attempt.
 *   report-pr       Publish the completed check and PR comment. Rejects invalid
 *                   PR numbers and stale tested SHAs before any write.
 *
 * The delete-instance and report-pr subcommands are cleanup/publication and
 * must be run only from the trusted workflow revision, never the branch under
 * test. See brev-lifecycle-core.mts for the pure logic these runners drive.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "../advisors/io.mts";
import {
  assertInstanceName,
  assertPrNumber,
  assertRelativeDirPath,
  assertRepository,
  assertRunIdentifier,
  assertTestedShaCurrent,
  BREV_CLI_SHA256,
  BREV_CLI_VERSION,
  BREV_ONBOARDING_SUPPRESSION,
  brevCliDownloadUrl,
  brevInstancePresence,
  brevLegacyCredentials,
  classifyValidationResult,
  renderBrevPrComment,
  resolveValidationJobUrl,
  selectBrevLogin,
  type ValidationResult,
} from "./brev-lifecycle-core.mts";

// ── Shared runner surface ────────────────────────────────────────────────────

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
) => CommandResult;

export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  annotateWarning(message: string): void;
  annotateError(message: string): void;
}

// ── delete-instance ──────────────────────────────────────────────────────────

export interface DeleteRunners {
  hasBrevCli(): boolean;
  brevDelete(name: string): CommandResult;
  /** Parsed `brev ls --json`, or null when the command failed or was unparseable. */
  brevListJson(): unknown;
  brevRefresh(): void;
  sleep(seconds: number): Promise<void>;
  logger: Logger;
}

export type DeleteOutcome = "skipped-no-cli" | "deleted" | "already-absent" | "failed";

export interface DeleteResult {
  outcome: DeleteOutcome;
  exitCode: number;
}

/**
 * Delete a Brev instance, retrying with a refresh between attempts. Treats a
 * confirmed-absent instance as success and fails visibly only after the final
 * attempt. An unverifiable `brev ls` never counts as absent.
 */
export async function deleteBrevInstance(
  name: string,
  runners: DeleteRunners,
  attempts = 3,
): Promise<DeleteResult> {
  const { logger } = runners;
  if (!runners.hasBrevCli()) {
    logger.log(`Brev CLI is unavailable; the validation step could not have created ${name}.`);
    return { outcome: "skipped-no-cli", exitCode: 0 };
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const deletion = runners.brevDelete(name);
    if (deletion.status === 0) {
      if (deletion.stdout.trim()) logger.log(deletion.stdout.trim());
      logger.log(`Brev deletion requested for ${name}.`);
      return { outcome: "deleted", exitCode: 0 };
    }

    if (brevInstancePresence(runners.brevListJson(), name) === "absent") {
      logger.log(`Brev instance ${name} is already absent.`);
      return { outcome: "already-absent", exitCode: 0 };
    }

    if (attempt === attempts) {
      const detail = deletion.stderr.trim() || deletion.stdout.trim();
      if (detail) logger.error(detail);
      logger.annotateError(`Failed to delete Brev instance ${name} after ${attempt} attempts.`);
      return { outcome: "failed", exitCode: deletion.status || 1 };
    }

    logger.annotateWarning(`Brev delete attempt ${attempt} failed; refreshing before retry.`);
    runners.brevRefresh();
    await runners.sleep(attempt * 5);
  }

  // Unreachable: the final attempt always returns above.
  return { outcome: "failed", exitCode: 1 };
}

// ── report-pr ────────────────────────────────────────────────────────────────

export interface ReportPrRunners {
  getPrHead(prNumber: string): { branch: string; headSha: string };
  /** Jobs listing for this run/attempt, or null when it cannot be read (#6978). */
  listRunJobs(runId: string, runAttempt: string): unknown;
  createCheckRun(input: {
    name: string;
    headSha: string;
    conclusion: string;
    detailsUrl: string;
    title: string;
    summary: string;
  }): void;
  postComment(prNumber: string, body: string): void;
}

export interface ReportPrInputs {
  prNumber: string | undefined;
  testSuite: string;
  validationResult: ValidationResult;
  testedSha: string;
  keepAlive: boolean;
  instanceName: string;
  runUrl: string;
  runId: string;
  runAttempt: string;
}

/**
 * Publish the check-run and PR comment. Validates the PR number and refuses to
 * report evidence for a SHA that is no longer the PR head, before any write.
 */
export function reportPr(inputs: ReportPrInputs, runners: ReportPrRunners): void {
  const prNumber = assertPrNumber(inputs.prNumber);
  const { branch, headSha } = runners.getPrHead(prNumber);
  assertTestedShaCurrent(headSha, inputs.testedSha);

  const outcome = classifyValidationResult(inputs.validationResult);
  // Deep-link the validation job when it can be identified unambiguously (#6978).
  const link = resolveValidationJobUrl({
    jobsJson: runners.listRunJobs(inputs.runId, inputs.runAttempt),
    runId: inputs.runId,
    runAttempt: inputs.runAttempt,
    runUrl: inputs.runUrl,
    testSuite: inputs.testSuite,
    validationResult: inputs.validationResult,
  });
  runners.createCheckRun({
    name: `Brev E2E (${inputs.testSuite})`,
    headSha: inputs.testedSha,
    conclusion: outcome.conclusion,
    detailsUrl: link.url,
    title: `Brev E2E (${inputs.testSuite}): ${outcome.conclusion}`,
    summary: `[Open the ${link.linkText}](${link.url}) for details.`,
  });
  runners.postComment(
    prNumber,
    renderBrevPrComment({
      outcome,
      testSuite: inputs.testSuite,
      branch,
      link,
      keepAlive: inputs.keepAlive,
      instanceName: inputs.instanceName,
    }),
  );
}

// ── install-cli ──────────────────────────────────────────────────────────────

export interface InstallRunners {
  download(url: string): Promise<Buffer>;
  extractBrevBinary(tarball: Buffer): void;
  brevLogin(apiKey: string, orgId: string): void;
  writeLegacyCredentials(token: string): void;
  writeOnboardingSuppression(): void;
  brevReady(): void;
  logger: Logger;
}

/**
 * Install and authenticate the pinned Brev CLI, then confirm readiness. The
 * checksum is verified before the tarball is trusted.
 */
export async function installBrevCli(
  auth: { apiKey?: string; orgId?: string; apiToken?: string },
  runners: InstallRunners,
  expectedSha256: string = BREV_CLI_SHA256,
): Promise<void> {
  const login = selectBrevLogin(auth);

  const tarball = await runners.download(brevCliDownloadUrl());
  const actualSha256 = createHash("sha256").update(tarball).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Brev CLI checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  runners.extractBrevBinary(tarball);

  if (login.kind === "api-key") {
    runners.brevLogin(login.apiKey, login.orgId);
  } else {
    runners.writeLegacyCredentials(login.token);
  }
  runners.writeOnboardingSuppression();
  runners.brevReady();
  runners.logger.log(`Brev CLI ${BREV_CLI_VERSION} installed and authenticated.`);
}

// ── collect-debug ────────────────────────────────────────────────────────────

export interface CollectDebugRunners {
  brevRefresh(): void;
  /** Returns the command status so ordinary SSH/SCP failures stay observable. */
  sshCollect(instance: string): CommandResult;
  scpBundle(instance: string, destDir: string): CommandResult;
  logger: Logger;
}

/**
 * Best-effort debug capture from the instance. Every step tolerates failure so
 * teardown still runs; this only makes downstream onboard failures diagnosable.
 */
export function collectBrevDebugBundle(
  instance: string,
  destDir: string,
  runners: CollectDebugRunners,
): void {
  try {
    runners.brevRefresh();
  } catch {
    /* refresh is best-effort */
  }
  // Best-effort, but not silent: a non-zero ssh/scp status is an ordinary
  // collection failure and must still reach the warning path.
  try {
    const collected = runners.sshCollect(instance);
    if (collected.status !== 0) {
      runners.logger.warn(
        `Debug collection on ${instance} exited ${collected.status}; bundle may be incomplete.`,
      );
    }
    const copied = runners.scpBundle(instance, destDir);
    if (copied.status !== 0) {
      runners.logger.warn(
        `Copying the debug bundle from ${instance} exited ${copied.status}; no bundle was retrieved.`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    runners.logger.warn(`Debug bundle collection for ${instance} was incomplete: ${detail}`);
  }
}

// ── CLI wiring ───────────────────────────────────────────────────────────────

const REMOTE_COLLECT_SCRIPT = [
  "set +e",
  "mkdir -p /tmp/nc-debug",
  "cp /tmp/nemoclaw-onboard.log /tmp/nc-debug/ 2>/dev/null || true",
  "cp -R /tmp/nemoclaw-traces /tmp/nc-debug/traces 2>/dev/null || true",
  "timeout 15s openshell sandbox list  > /tmp/nc-debug/sandbox-list.txt 2>&1",
  "timeout 15s openshell gateway status > /tmp/nc-debug/gateway-status.txt 2>&1",
  "timeout 15s docker ps -a             > /tmp/nc-debug/docker-ps.txt 2>&1",
  "timeout 30s tar -C /tmp -czf /tmp/nc-debug.tar.gz nc-debug",
].join("\n");

const consoleLogger: Logger = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
  annotateWarning: (message) => console.log(`::warning::${message}`),
  annotateError: (message) => console.log(`::error::${message}`),
};

function realRunner(): CommandRunner {
  return (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      encoding: "utf-8",
      input: options.input,
      timeout: options.timeoutMs,
    });
    return {
      status: typeof result.status === "number" ? result.status : 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runInstallCli(): Promise<void> {
  const run = realRunner();
  const home = os.homedir();
  const brevDir = path.join(home, ".brev");
  await installBrevCli(
    {
      apiKey: process.env.BREV_API_KEY,
      orgId: process.env.BREV_ORG_ID,
      apiToken: process.env.BREV_API_TOKEN,
    },
    {
      download: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Brev CLI download failed: HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      },
      extractBrevBinary: (tarball) => {
        // mkdtemp gives the tarball a private, unpredictable directory; a fixed
        // name in the shared temp dir could be pre-created or symlinked by
        // another local user before tar extracts into /usr/local/bin.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brev-cli-"));
        try {
          const tmp = path.join(tmpDir, "brev.tar.gz");
          fs.writeFileSync(tmp, tarball);
          const extract = run("tar", ["-xzf", tmp, "-C", "/usr/local/bin", "brev"]);
          if (extract.status !== 0) throw new Error(`tar extraction failed: ${extract.stderr}`);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        fs.chmodSync("/usr/local/bin/brev", 0o755);
      },
      brevLogin: (apiKey, orgId) => {
        const result = run("brev", ["login", "--api-key", apiKey, "--org-id", orgId]);
        if (result.status !== 0) throw new Error(`brev login failed: ${result.stderr}`);
      },
      writeLegacyCredentials: (token) => {
        fs.mkdirSync(brevDir, { recursive: true, mode: 0o700 });
        const file = path.join(brevDir, "credentials.json");
        fs.writeFileSync(file, brevLegacyCredentials(token), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      },
      writeOnboardingSuppression: () => {
        fs.mkdirSync(brevDir, { recursive: true });
        fs.writeFileSync(path.join(brevDir, "onboarding_step.json"), BREV_ONBOARDING_SUPPRESSION);
      },
      brevReady: () => {
        const result = run("brev", ["ls"]);
        if (result.status !== 0) throw new Error(`brev ls failed: ${result.stderr}`);
      },
      logger: consoleLogger,
    },
  );
}

function runCollectDebug(): void {
  const run = realRunner();
  const instance = assertInstanceName(requireEnv("INSTANCE_NAME"));
  const destDir = assertRelativeDirPath(process.env.DEST_DIR ?? "brev-debug-bundle");
  fs.mkdirSync(destDir, { recursive: true });
  const quietSsh = ["-o", "StrictHostKeyChecking=no", "-o", "LogLevel=ERROR"];
  collectBrevDebugBundle(instance, destDir, {
    brevRefresh: () => {
      run("brev", ["refresh"]);
    },
    sshCollect: (target) =>
      run("ssh", [...quietSsh, "-o", "ConnectTimeout=10", target, REMOTE_COLLECT_SCRIPT]),
    scpBundle: (target, dir) =>
      run("scp", [...quietSsh, `${target}:/tmp/nc-debug.tar.gz`, `${dir}/`]),
    logger: consoleLogger,
  });
}

async function runDeleteInstance(): Promise<void> {
  const run = realRunner();
  const instance = assertInstanceName(requireEnv("INSTANCE_NAME"));
  const result = await deleteBrevInstance(instance, {
    hasBrevCli: () => run("bash", ["-c", "command -v brev >/dev/null 2>&1"]).status === 0,
    brevDelete: (name) => run("brev", ["delete", name], { timeoutMs: 30_000 }),
    brevListJson: () => {
      const listing = run("brev", ["ls", "--json"], { timeoutMs: 30_000 });
      if (listing.status !== 0) return null;
      try {
        return JSON.parse(listing.stdout);
      } catch {
        return null;
      }
    },
    brevRefresh: () => {
      run("brev", ["refresh"], { timeoutMs: 30_000 });
    },
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    logger: consoleLogger,
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

function runReportPr(): void {
  const run = realRunner();
  const repo = assertRepository(requireEnv("GITHUB_REPOSITORY"));
  const gh = (args: string[]): CommandResult => run("gh", args);
  reportPr(
    {
      prNumber: process.env.PR_NUMBER,
      testSuite: requireEnv("TEST_SUITE"),
      validationResult: requireEnv("VALIDATION_RESULT"),
      testedSha: process.env.TESTED_SHA ?? "",
      keepAlive: process.env.KEEP_ALIVE === "true",
      instanceName: assertInstanceName(requireEnv("INSTANCE_NAME")),
      runUrl: requireEnv("RUN_URL"),
      runId: assertRunIdentifier(process.env.RUN_ID ?? "", "RUN_ID"),
      runAttempt: assertRunIdentifier(process.env.RUN_ATTEMPT ?? "", "RUN_ATTEMPT"),
    },
    {
      getPrHead: (prNumber) => {
        const view = gh([
          "pr",
          "view",
          prNumber,
          "--repo",
          repo,
          "--json",
          "headRefName,headRefOid",
        ]);
        if (view.status !== 0) throw new Error(`gh pr view failed: ${view.stderr}`);
        const parsed = JSON.parse(view.stdout) as { headRefName: string; headRefOid: string };
        return { branch: parsed.headRefName, headSha: parsed.headRefOid };
      },
      listRunJobs: (runId, runAttempt) => {
        // Best-effort: an unreadable listing simply falls back to the run URL.
        const listing = gh([
          "api",
          `repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
        ]);
        if (listing.status !== 0) return null;
        try {
          return JSON.parse(listing.stdout);
        } catch {
          return null;
        }
      },
      createCheckRun: (input) => {
        const result = gh([
          "api",
          `repos/${repo}/check-runs`,
          "-f",
          `name=${input.name}`,
          "-f",
          `head_sha=${input.headSha}`,
          "-f",
          "status=completed",
          "-f",
          `conclusion=${input.conclusion}`,
          "-f",
          `details_url=${input.detailsUrl}`,
          "-f",
          `output[title]=${input.title}`,
          "-f",
          `output[summary]=${input.summary}`,
        ]);
        if (result.status !== 0) throw new Error(`check-run creation failed: ${result.stderr}`);
      },
      postComment: (prNumber, body) => {
        // The body travels over stdin; a predictable file in the shared temp
        // dir could be swapped by another local user between write and read.
        const result = run("gh", ["pr", "comment", prNumber, "--repo", repo, "--body-file", "-"], {
          input: body,
        });
        if (result.status !== 0) throw new Error(`PR comment failed: ${result.stderr}`);
      },
    },
  );
}

async function main(): Promise<void> {
  const [subcommand] = process.argv.slice(2);
  // parseArgs is available for future flag-driven subcommands; env drives today's.
  parseArgs(process.argv.slice(3));
  switch (subcommand) {
    case "install-cli":
      await runInstallCli();
      return;
    case "collect-debug":
      runCollectDebug();
      return;
    case "delete-instance":
      await runDeleteInstance();
      return;
    case "report-pr":
      runReportPr();
      return;
    default:
      console.error(
        "usage: brev-lifecycle.mts <install-cli|collect-debug|delete-instance|report-pr>",
      );
      process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
