// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { resolveDirectSandboxContainer } from "../../../src/lib/sandbox/privileged-exec";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import { type HostCliClient, resultText } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { buildHermesRuntimeExecArgs } from "./rebuild-hermes-runtime-exec.ts";

const HERMES_HOME = "/sandbox/.hermes";
const CRON_JOBS_FILE = `${HERMES_HOME}/cron/jobs.json`;
const CRON_SCRIPTS_ROOT = `${HERMES_HOME}/scripts`;
const CRON_CONTROL = "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py";
const NEMOCLAW_STATE_ROOT = "/sandbox/.nemoclaw";
const CRON_CONTROL_MARKER_NAME = "hermes-cron-restore-drain.json";
const CRON_CONTROL_MARKER = `${NEMOCLAW_STATE_ROOT}/${CRON_CONTROL_MARKER_NAME}`;
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const GATEWAY_POLL_ATTEMPTS = 30;
const EXECUTION_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 5_000;
const SUBSTITUTION_PROBE_ATTEMPTS = 13;
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";

type JsonObject = Record<string, unknown>;

interface RebuildHermesCronRestoreOptions {
  host: HostCliClient;
  sandboxName: string;
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
  timeoutMs?: number;
}

interface SeededCronJob {
  evidence: JsonObject;
  executionMarker: string;
  executionToken: string;
  id: string;
  name: string;
  scriptContent: string;
  scriptName: string;
}

interface GatewayEvidence {
  active_agents: number;
  gateway_state: string;
  pid: number;
  running_pid: number;
  start_time: number;
}

interface CronControlReceipt {
  action: "begin";
  active_agents: number;
  disposition: string;
  drain_acquired: boolean;
  drain_token: string;
  operator_drain_active: boolean;
  pid: number;
  start_time: number;
  version: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} is not an object`);
  }
  return value as JsonObject;
}

function parseJsonObject(text: string, label: string): JsonObject {
  try {
    return requireObject(JSON.parse(text), label);
  } catch (error) {
    if (error instanceof SyntaxError) return fail(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

function normalizeTimestampMs(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fail(`${label} is not a supported timestamp`);
}

function cronJobs(payload: unknown, label: string): JsonObject[] {
  const collection = Array.isArray(payload) ? payload : requireObject(payload, label).jobs;
  if (
    !Array.isArray(collection) ||
    !collection.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
  ) {
    return fail(`${label} does not contain a jobs collection`);
  }
  return collection as JsonObject[];
}

function parseCronJob(text: string, jobId: string, label: string): JsonObject {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return fail(`${label} is not valid JSON: ${String(error)}`);
  }
  return (
    cronJobs(payload, label).find((job) => job.id === jobId) ??
    fail(`${label} does not contain cron job ${jobId}`)
  );
}

function cronJobState(job: JsonObject, label: string): JsonObject {
  return requireObject(job.state, `${label} state`);
}

function completedRuns(job: JsonObject, label: string): number {
  const repeat = requireObject(cronJobState(job, label).repeat, `${label} repeat state`);
  return typeof repeat.completed === "number"
    ? repeat.completed
    : fail(`${label} completed run count is unavailable`);
}

function assertFutureCronJob(job: JsonObject, seed: SeededCronJob): void {
  expect(job).toMatchObject({
    enabled: true,
    id: seed.id,
    name: seed.name,
    no_agent: true,
    schedule: { kind: "interval" },
    script: seed.scriptName,
  });
  const state = cronJobState(job, `cron job ${seed.id}`);
  expect(state.last_run_at ?? null).toBeNull();
  expect(state.last_status ?? null).toBeNull();
  expect(completedRuns(job, `cron job ${seed.id}`)).toBe(0);
  expect(
    normalizeTimestampMs(state.next_run_at, `cron job ${seed.id} next run`),
    "seeded recurring cron job must remain well in the future during rebuild",
  ).toBeGreaterThan(Date.now() + 60 * 60_000);
}

export function hermesRuntimeExecArgs(sandboxName: string, command: string[]): string[] {
  // `openshell sandbox exec` intentionally runs inside Landlock, which cannot
  // read the immutable `/opt/hermes` runtime. These checks need the managed
  // Docker container while retaining Hermes' ordinary sandbox identity.
  const containerId = resolveDirectSandboxContainer(sandboxName, "docker");
  return buildHermesRuntimeExecArgs(containerId, command);
}

function hermesRootExecArgs(sandboxName: string, command: string[]): string[] {
  const containerId = resolveDirectSandboxContainer(sandboxName, "docker");
  return ["exec", "--user", "root", "--env", `HERMES_HOME=${HERMES_HOME}`, containerId, ...command];
}

function scriptContent(executionMarker: string, executionToken: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `printf '%s\\n' ${shellQuote(executionToken)} >> ${shellQuote(executionMarker)}`,
    `printf '%s\\n' ${shellQuote(executionToken)}`,
    "",
  ].join("\n");
}

function uniqueSeed(label: string): Omit<SeededCronJob, "evidence" | "id"> {
  const nonce = `${Date.now()}-${process.pid}`;
  const scriptName = `nemoclaw-${label}-${nonce}.sh`;
  const executionMarker = `${HERMES_HOME}/memories/${label}-cron-executions-${nonce}.txt`;
  const executionToken = `NEMOCLAW_${label.toUpperCase()}_CRON_${nonce}`;
  return {
    executionMarker,
    executionToken,
    name: `NEMOCLAW_${label.toUpperCase()}_CRON_${nonce}`,
    scriptContent: scriptContent(executionMarker, executionToken),
    scriptName,
  };
}

export function createRebuildHermesCronRestoreFixture({
  host,
  sandboxName,
  env,
  redactionValues,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RebuildHermesCronRestoreOptions) {
  let rebuildSeed: SeededCronJob | null = null;

  async function dockerSandbox(
    command: string[],
    artifactName: string,
  ): Promise<Awaited<ReturnType<HostCliClient["command"]>>> {
    return host.command("docker", hermesRuntimeExecArgs(sandboxName, command), {
      artifactName,
      env,
      redactionValues,
      timeoutMs,
    });
  }

  async function dockerRoot(
    command: string[],
    artifactName: string,
  ): Promise<Awaited<ReturnType<HostCliClient["command"]>>> {
    return host.command("docker", hermesRootExecArgs(sandboxName, command), {
      artifactName,
      env,
      redactionValues,
      timeoutMs,
    });
  }

  async function readCronJob(jobId: string, artifactName: string): Promise<JsonObject> {
    const result = await dockerSandbox(["cat", CRON_JOBS_FILE], artifactName);
    expectExitZero(result, `read Hermes cron job ${jobId}`);
    return parseCronJob(result.stdout, jobId, artifactName);
  }

  async function seedCronJob(label: string): Promise<SeededCronJob> {
    const pending = uniqueSeed(label);
    const scriptPath = `${CRON_SCRIPTS_ROOT}/${pending.scriptName}`;
    const writeScript = await dockerRoot(
      [
        "sh",
        "-c",
        [
          `mkdir -p ${shellQuote(CRON_SCRIPTS_ROOT)}`,
          `chown sandbox:sandbox ${shellQuote(CRON_SCRIPTS_ROOT)}`,
          `chmod 0700 ${shellQuote(CRON_SCRIPTS_ROOT)}`,
          `printf '%s' ${shellQuote(pending.scriptContent)} > ${shellQuote(scriptPath)}`,
          `chown sandbox:sandbox ${shellQuote(scriptPath)}`,
          `chmod 0700 ${shellQuote(scriptPath)}`,
        ].join(" && "),
      ],
      `phase-${label}-write-hermes-cron-script`,
    );
    expectExitZero(writeScript, `write ${label} Hermes cron script`);

    const create = await dockerSandbox(
      [
        "hermes",
        "cron",
        "create",
        "every 1d",
        "--no-agent",
        "--script",
        pending.scriptName,
        "--name",
        pending.name,
      ],
      `phase-${label}-create-hermes-cron-job`,
    );
    expectExitZero(create, `create ${label} Hermes cron job`);
    const id = resultText(create).match(/Created job:\s+(\S+)/u)?.[1];
    if (!id) fail(`Hermes cron create did not report the ${label} job id: ${resultText(create)}`);
    const seed = {
      ...pending,
      evidence: await readCronJob(id, `phase-${label}-read-seeded-hermes-cron-job`),
      id,
    };
    assertFutureCronJob(seed.evidence, seed);
    await assertExecutionMarkerAbsent(seed, `phase-${label}-verify-cron-not-yet-executed`);
    return seed;
  }

  async function assertExecutionMarkerAbsent(
    seed: SeededCronJob,
    artifactName: string,
  ): Promise<void> {
    const result = await dockerSandbox(["test", "!", "-e", seed.executionMarker], artifactName);
    expectExitZero(result, `verify ${seed.name} has not executed`);
  }

  async function executionCount(seed: SeededCronJob, artifactName: string): Promise<number> {
    const read = await dockerSandbox(
      [
        "sh",
        "-c",
        `if [ -f ${shellQuote(seed.executionMarker)} ]; then cat ${shellQuote(seed.executionMarker)}; fi`,
      ],
      artifactName,
    );
    expectExitZero(read, `read execution marker for ${seed.name}`);
    return read.stdout.split(/\r?\n/u).filter((line) => line === seed.executionToken).length;
  }

  async function enqueueManualRun(seed: SeededCronJob, artifactName: string): Promise<void> {
    const run = await dockerSandbox(["hermes", "cron", "run", seed.id], artifactName);
    expectExitZero(run, `enqueue manual Hermes cron run ${seed.id}`);
  }

  async function waitForOneExecution(seed: SeededCronJob, artifactPrefix: string): Promise<void> {
    let lastEvidence = "no scheduler evidence";
    for (let attempt = 1; attempt <= EXECUTION_POLL_ATTEMPTS; attempt += 1) {
      const job = await readCronJob(seed.id, `${artifactPrefix}-job-attempt-${attempt}`);
      const count = await executionCount(seed, `${artifactPrefix}-marker-attempt-${attempt}`);
      const state = cronJobState(job, `cron job ${seed.id}`);
      const completed = completedRuns(job, `cron job ${seed.id}`);
      lastEvidence = JSON.stringify({ completed, count, last_status: state.last_status });
      if (completed > 1 || count > 1) {
        fail(`Hermes cron job ${seed.id} executed more than once: ${lastEvidence}`);
      }
      if (completed === 1 && count === 1 && state.last_status === "ok") return;
      await sleep(POLL_INTERVAL_MS);
    }
    fail(`Hermes cron job ${seed.id} did not complete exactly once: ${lastEvidence}`);
  }

  async function assertControlMarker(present: boolean, artifactName: string): Promise<void> {
    const command = present
      ? ["stat", "-c", "%u:%g %a %s", CRON_CONTROL_MARKER]
      : ["test", "!", "-e", CRON_CONTROL_MARKER];
    const result = await dockerRoot(command, artifactName);
    expectExitZero(result, `verify cron restore marker is ${present ? "present" : "absent"}`);
    if (present) expect(result.stdout.trim()).toMatch(/^0:0 400 [1-9]\d*$/u);
  }

  function parseGatewayEvidence(text: string): GatewayEvidence {
    const payload = parseJsonObject(text, "Hermes gateway status");
    for (const field of ["active_agents", "pid", "running_pid", "start_time"] as const) {
      if (!Number.isSafeInteger(payload[field])) fail(`Hermes gateway ${field} is invalid`);
    }
    if (typeof payload.gateway_state !== "string") fail("Hermes gateway state is invalid");
    return payload as unknown as GatewayEvidence;
  }

  async function gatewayEvidence(artifactName: string): Promise<GatewayEvidence | null> {
    const script = [
      "import json",
      "from pathlib import Path",
      "from gateway import status",
      `home = Path(${JSON.stringify(HERMES_HOME)})`,
      "payload = status.read_runtime_status()",
      "pid = payload.get('pid') if isinstance(payload, dict) else None",
      "result = {",
      "    'active_agents': status.parse_active_agents(payload.get('active_agents')),",
      "    'gateway_state': payload.get('gateway_state'),",
      "    'pid': pid,",
      "    'running_pid': status.get_runtime_status_running_pid(runtime=payload, expected_home=home),",
      "    'start_time': payload.get('start_time'),",
      "}",
      "print(json.dumps(result, sort_keys=True))",
    ].join("\n");
    const result = await dockerRoot([HERMES_PYTHON, "-I", "-c", script], artifactName);
    if (result.exitCode !== 0) return null;
    return parseGatewayEvidence(result.stdout.trim());
  }

  async function waitForGatewayState(
    state: "draining" | "running",
    artifactPrefix: string,
    priorIdentity?: Pick<GatewayEvidence, "pid" | "start_time">,
  ): Promise<GatewayEvidence> {
    let lastEvidence = "gateway status unavailable";
    for (let attempt = 1; attempt <= GATEWAY_POLL_ATTEMPTS; attempt += 1) {
      const evidence = await gatewayEvidence(`${artifactPrefix}-attempt-${attempt}`);
      if (evidence) {
        lastEvidence = JSON.stringify(evidence);
        const live = evidence.running_pid === evidence.pid;
        const identityChanged =
          !priorIdentity ||
          evidence.pid !== priorIdentity.pid ||
          evidence.start_time !== priorIdentity.start_time;
        if (
          live &&
          identityChanged &&
          evidence.gateway_state === state &&
          evidence.active_agents === 0
        ) {
          return evidence;
        }
        if (live && state === "draining" && evidence.gateway_state === "running") {
          fail(`Hermes gateway resumed before cron recovery: ${lastEvidence}`);
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    fail(`Hermes gateway did not reach ${state}: ${lastEvidence}`);
  }

  function parseBeginReceipt(text: string): CronControlReceipt {
    const lines = text.split(/\r?\n/u).filter((line) => line.startsWith(RECEIPT_PREFIX));
    if (lines.length !== 1) fail(`Hermes cron begin returned ${lines.length} receipts`);
    const payload = parseJsonObject(lines[0].slice(RECEIPT_PREFIX.length), "cron begin receipt");
    expect(payload).toMatchObject({
      action: "begin",
      active_agents: 0,
      disposition: "drain-acquired",
      drain_acquired: true,
      operator_drain_active: false,
      version: 1,
    });
    if (
      !Number.isSafeInteger(payload.pid) ||
      !Number.isSafeInteger(payload.start_time) ||
      typeof payload.drain_token !== "string" ||
      payload.drain_token.length !== 32
    ) {
      fail("Hermes cron begin receipt identity is invalid");
    }
    return payload as unknown as CronControlReceipt;
  }

  async function exerciseStateRootSubstitutionAttack(
    seed: SeededCronJob,
    expectedGateway: Pick<GatewayEvidence, "pid" | "start_time">,
  ): Promise<void> {
    const heldStateRoot = `/sandbox/.nemoclaw-nemoclaw-parent-swap-${Date.now()}-${process.pid}`;
    const heldMarker = `${heldStateRoot}/${CRON_CONTROL_MARKER_NAME}`;
    const substitute = await dockerSandbox(
      [
        "sh",
        "-c",
        [
          `test ! -e ${shellQuote(heldStateRoot)}`,
          `mv ${shellQuote(NEMOCLAW_STATE_ROOT)} ${shellQuote(heldStateRoot)}`,
          `mkdir -m 0700 ${shellQuote(NEMOCLAW_STATE_ROOT)}`,
          `test "$(stat -c '%u:%g' ${shellQuote(heldStateRoot)})" = '0:0'`,
          `test "$(stat -c '%u:%g' ${shellQuote(NEMOCLAW_STATE_ROOT)})" = "$(id -u):$(id -g)"`,
          `test ! -e ${shellQuote(CRON_CONTROL_MARKER)}`,
          `stat -c 'held=%u:%g:%a' ${shellQuote(heldStateRoot)}`,
          `stat -c 'replacement=%u:%g:%a' ${shellQuote(NEMOCLAW_STATE_ROOT)}`,
        ].join(" && "),
      ],
      "phase-8-substitute-nemoclaw-state-root-as-sandbox-user",
    );
    expectExitZero(substitute, "substitute root-owned NemoClaw state root as sandbox user");

    try {
      const preservedMarker = await dockerRoot(
        ["stat", "-c", "%u:%g %a %s", heldMarker],
        "phase-8-verify-held-cron-restore-marker",
      );
      expectExitZero(preservedMarker, "verify held cron restore marker");
      expect(preservedMarker.stdout.trim()).toMatch(/^0:0 400 [1-9]\d*$/u);
      await assertControlMarker(false, "phase-8-verify-attacker-root-hides-control-marker");

      // Hermes polls due cron work once per minute. Keep the attacker-owned
      // substitution installed across a full dispatch opportunity while
      // repeatedly proving both the gateway state and the script side effect.
      for (let attempt = 1; attempt <= SUBSTITUTION_PROBE_ATTEMPTS; attempt += 1) {
        await sleep(POLL_INTERVAL_MS);
        const gateway = await waitForGatewayState(
          "draining",
          `phase-8-verify-substituted-root-remains-drained-${attempt}`,
        );
        expect(gateway).toMatchObject(expectedGateway);
        await assertExecutionMarkerAbsent(
          seed,
          `phase-8-verify-substituted-root-blocks-dispatch-${attempt}`,
        );
      }
    } finally {
      const restore = await dockerSandbox(
        [
          "sh",
          "-c",
          [
            `rmdir ${shellQuote(NEMOCLAW_STATE_ROOT)}`,
            `mv ${shellQuote(heldStateRoot)} ${shellQuote(NEMOCLAW_STATE_ROOT)}`,
          ].join(" && "),
        ],
        "phase-8-restore-original-nemoclaw-state-root",
      );
      expectExitZero(restore, "restore original root-owned NemoClaw state root");
    }

    await assertControlMarker(true, "phase-8-verify-cron-restore-marker-after-parent-swap");
    const restoredGateway = await waitForGatewayState(
      "draining",
      "phase-8-verify-gateway-drained-after-parent-swap",
    );
    expect(restoredGateway).toMatchObject(expectedGateway);
  }
  return {
    async seed(): Promise<void> {
      if (rebuildSeed) fail("Hermes rebuild cron fixture was seeded twice");
      rebuildSeed = await seedCronJob("rebuild");
    },

    async verify(rebuildOutput: string, rebuildBackupPath: string): Promise<void> {
      const seed = rebuildSeed ?? fail("Hermes rebuild cron fixture was not seeded");
      const acquired = rebuildOutput.match(
        /Hermes cron restore gate acquired: pid=(\d+), startTime=(\d+)/u,
      );
      const released = rebuildOutput.match(
        /Hermes cron restore gate released: pid=(\d+), startTime=(\d+)/u,
      );
      expect(acquired, "rebuild output must report cron restore gate acquisition").not.toBeNull();
      expect(released, "rebuild output must report cron restore gate release").not.toBeNull();
      expect(released?.slice(1)).toEqual(acquired?.slice(1));
      expect(rebuildOutput.indexOf(released?.[0] ?? "released")).toBeGreaterThan(
        rebuildOutput.indexOf(acquired?.[0] ?? "acquired"),
      );

      const backupJobsPath = path.join(rebuildBackupPath, "cron", "jobs.json");
      const backedUpJob = parseCronJob(
        fs.readFileSync(backupJobsPath, "utf8"),
        seed.id,
        "backed-up Hermes cron store",
      );
      expect(backedUpJob).toEqual(seed.evidence);
      expect(
        fs.readFileSync(path.join(rebuildBackupPath, "scripts", seed.scriptName), "utf8"),
      ).toBe(seed.scriptContent);

      const restoredJob = await readCronJob(seed.id, "phase-7-read-restored-hermes-cron-job");
      expect(restoredJob).toEqual(seed.evidence);
      const restoredScript = await dockerSandbox(
        ["cat", `${CRON_SCRIPTS_ROOT}/${seed.scriptName}`],
        "phase-7-read-restored-hermes-cron-script",
      );
      expectExitZero(restoredScript, "read restored Hermes cron script");
      expect(restoredScript.stdout).toBe(seed.scriptContent);
      await assertControlMarker(false, "phase-7-verify-cron-restore-marker-released");
      await waitForGatewayState("running", "phase-7-verify-gateway-running-after-cron-restore");
      await assertExecutionMarkerAbsent(seed, "phase-7-verify-restored-cron-not-auto-executed");

      await enqueueManualRun(seed, "phase-7-run-restored-hermes-cron-job");
      await waitForOneExecution(seed, "phase-7-wait-restored-hermes-cron-execution");
    },

    async verifyStrandedGateRecovery(): Promise<void> {
      const begin = await dockerRoot(
        [HERMES_PYTHON, "-I", CRON_CONTROL, "begin"],
        "phase-8-acquire-stranded-hermes-cron-restore-gate",
      );
      expectExitZero(begin, "acquire stranded Hermes cron restore gate");
      const receipt = parseBeginReceipt(begin.stdout);
      await assertControlMarker(true, "phase-8-verify-cron-restore-marker-before-restart");

      const recoverySeed = await seedCronJob("recovery");
      await enqueueManualRun(recoverySeed, "phase-8-queue-due-hermes-cron-during-drain");
      await sleep(POLL_INTERVAL_MS);
      await assertExecutionMarkerAbsent(
        recoverySeed,
        "phase-8-verify-due-cron-blocked-before-restart",
      );
      const beforeRestart = await waitForGatewayState(
        "draining",
        "phase-8-verify-gateway-drained-before-restart",
      );
      expect(beforeRestart).toMatchObject({ pid: receipt.pid, start_time: receipt.start_time });

      const containerId = resolveDirectSandboxContainer(sandboxName, "docker");
      const restart = await host.command("docker", ["restart", containerId], {
        artifactName: "phase-8-restart-container-with-stranded-hermes-cron-gate",
        env,
        redactionValues,
        timeoutMs,
      });
      expectExitZero(restart, "restart Hermes container with stranded cron restore gate");
      const afterRestart = await waitForGatewayState(
        "draining",
        "phase-8-verify-gateway-redrained-after-restart",
        beforeRestart,
      );
      await assertControlMarker(true, "phase-8-verify-cron-restore-marker-after-restart");
      await assertExecutionMarkerAbsent(
        recoverySeed,
        "phase-8-verify-due-cron-blocked-after-restart",
      );
      await exerciseStateRootSubstitutionAttack(recoverySeed, afterRestart);

      const recover = await host.nemoclaw([sandboxName, "recover"], {
        artifactName: "phase-8-nemoclaw-recover-stranded-hermes-cron-gate",
        env,
        redactionValues,
        timeoutMs: 3 * 60_000,
      });
      expectExitZero(recover, "recover stranded Hermes cron restore gate");
      expect(resultText(recover)).toContain(
        "Hermes cron dispatch resumed after restored jobs and scripts were validated.",
      );
      await assertControlMarker(false, "phase-8-verify-recovered-cron-restore-marker-released");
      await waitForGatewayState("running", "phase-8-verify-gateway-running-after-recovery");
      await waitForOneExecution(recoverySeed, "phase-8-wait-recovered-hermes-cron-execution");
    },
  };
}
