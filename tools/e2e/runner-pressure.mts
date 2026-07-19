// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for hosted-runner resource evidence (#7146).
 *
 * Subcommands (all evidence stays secret-safe: numeric fields, fixed enums,
 * process comm names, and bounded container names only — never command
 * payloads, credentials, or environment values):
 *
 * - `snapshot`     — emit one bounded `E2E_RESOURCE_SNAPSHOT` line for the
 *                    phase named by `E2E_PHASE`. Every collector is
 *                    best-effort: unreadable sources become null fields, so
 *                    the line is still emitted on hosts without cgroup v2,
 *                    PSI, or Docker.
 * - `classify`     — emit one `E2E_TERMINAL_CLASSIFICATION` line from
 *                    `TEST_OUTCOME` (`assertion` | `timeout` | `none`) plus
 *                    on-host OOM/disk evidence, and optionally the Docker
 *                    OOMKilled state of `DOCKER_OOM_CONTAINER`.
 * - `decide-retry` — print a JSON retry decision from `E2E_RUNNER_LOSS`,
 *                    `E2E_CLASSIFICATION`, and `E2E_ATTEMPT`. Exits 0 with
 *                    `{"retry":false,...}` for everything except a confirmed
 *                    runner loss on the first attempt.
 *
 * An unsupported or missing subcommand fails closed with a usage message and
 * a non-zero exit so a workflow typo can never look like a passing step.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  assertPhaseLabel,
  classifyFailure,
  decideRetry,
  parseCgroupMemoryEvents,
  parseCgroupScalar,
  parseDockerStats,
  parseDockerSystemDf,
  parseLoadAverages,
  parseMeminfo,
  parsePressure,
  parseTopProcesses,
  renderClassificationLine,
  renderSnapshotLine,
  TERMINAL_CLASSIFICATIONS,
  type FailureEvidence,
  type ResourceSnapshot,
  type TerminalClassification,
} from "./runner-pressure-core.mts";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function readTextOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function runOrNull(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, { encoding: "utf-8", timeout: 15_000 });
    return result.status === 0 ? (result.stdout ?? null) : null;
  } catch {
    return null;
  }
}

function collectDisk(): ResourceSnapshot["disk"] {
  try {
    const stat = fs.statfsSync(process.cwd());
    return {
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
      inodesFree: Number(stat.ffree),
      inodesTotal: Number(stat.files),
    };
  } catch {
    return null;
  }
}

function collectSnapshot(phase: string): ResourceSnapshot {
  const meminfoText = readTextOrNull("/proc/meminfo");
  const loadText = readTextOrNull("/proc/loadavg");
  const current = readTextOrNull(`${CGROUP_ROOT}/memory.current`);
  const peak = readTextOrNull(`${CGROUP_ROOT}/memory.peak`);
  const limit = readTextOrNull(`${CGROUP_ROOT}/memory.max`);
  const events = readTextOrNull(`${CGROUP_ROOT}/memory.events`);
  const memoryPressure = readTextOrNull(`${CGROUP_ROOT}/memory.pressure`);
  const ioPressure = readTextOrNull(`${CGROUP_ROOT}/io.pressure`);
  const psText = runOrNull("ps", ["-eo", "comm=,rss="]);
  const statsText = runOrNull("docker", ["stats", "--no-stream", "--format", "{{json .}}"]);
  const dfText = runOrNull("docker", ["system", "df", "--format", "{{json .}}"]);
  return {
    phase,
    at: new Date().toISOString(),
    meminfo: meminfoText === null ? null : parseMeminfo(meminfoText),
    load: loadText === null ? null : parseLoadAverages(loadText),
    cgroup:
      current === null && peak === null && limit === null && events === null
        ? null
        : {
            currentBytes: current === null ? null : parseCgroupScalar(current),
            peakBytes: peak === null ? null : parseCgroupScalar(peak),
            limitBytes: limit === null ? null : parseCgroupScalar(limit),
            events: events === null ? null : parseCgroupMemoryEvents(events),
          },
    memoryPressure: memoryPressure === null ? null : parsePressure(memoryPressure),
    ioPressure: ioPressure === null ? null : parsePressure(ioPressure),
    topProcesses: psText === null ? [] : parseTopProcesses(psText),
    containers: statsText === null ? [] : parseDockerStats(statsText),
    dockerDisk: dfText === null ? null : parseDockerSystemDf(dfText),
    disk: collectDisk(),
  };
}

function runSnapshot(): void {
  const phase = assertPhaseLabel(process.env.E2E_PHASE);
  console.log(renderSnapshotLine(collectSnapshot(phase)));
}

function assertTestOutcome(value: string | undefined): FailureEvidence["testOutcome"] {
  if (value === "assertion" || value === "timeout" || value === "none") return value;
  throw new Error("TEST_OUTCOME must be one of: assertion, timeout, none");
}

function containerOomKilled(name: string | undefined): boolean {
  if (!name) return false;
  if (!CONTAINER_NAME_PATTERN.test(name)) {
    throw new Error("DOCKER_OOM_CONTAINER must start alphanumeric and stay in [A-Za-z0-9._-]");
  }
  const output = runOrNull("docker", ["inspect", "--format", "{{.State.OOMKilled}}", name]);
  return output !== null && output.trim() === "true";
}

function runClassify(): void {
  const events = readTextOrNull(`${CGROUP_ROOT}/memory.events`);
  const meminfoText = readTextOrNull("/proc/meminfo");
  const meminfo = meminfoText === null ? null : parseMeminfo(meminfoText);
  const disk = collectDisk();
  const kernelLog = runOrNull("dmesg", ["--level=err,warn"]);
  const classified = classifyFailure({
    testOutcome: assertTestOutcome(process.env.TEST_OUTCOME),
    cgroupOomKills: events === null ? 0 : parseCgroupMemoryEvents(events).oomKill,
    kernelOomKilled: kernelLog !== null && /Out of memory: Killed process/u.test(kernelLog),
    containerOomKilled: containerOomKilled(process.env.DOCKER_OOM_CONTAINER),
    memFreeKb: meminfo?.memFreeKb ?? null,
    memAvailableKb: meminfo?.memAvailableKb ?? null,
    diskFreeBytes: disk?.freeBytes ?? null,
    inodesFree: disk?.inodesFree ?? null,
  });
  console.log(renderClassificationLine(classified));
}

function assertClassification(value: string | undefined): TerminalClassification | null {
  if (value === undefined || value === "") return null;
  if ((TERMINAL_CLASSIFICATIONS as readonly string[]).includes(value)) {
    return value as TerminalClassification;
  }
  throw new Error(
    `E2E_CLASSIFICATION must be empty or one of: ${TERMINAL_CLASSIFICATIONS.join(", ")}`,
  );
}

function runDecideRetry(): void {
  const attemptRaw = process.env.E2E_ATTEMPT ?? "";
  if (!/^[1-9][0-9]*$/u.test(attemptRaw)) {
    throw new Error("E2E_ATTEMPT must be a positive integer");
  }
  const decision = decideRetry({
    runnerLoss: process.env.E2E_RUNNER_LOSS === "true",
    classification: assertClassification(process.env.E2E_CLASSIFICATION),
    attempt: Number(attemptRaw),
  });
  console.log(JSON.stringify({ v: 1, ...decision }));
}

function main(): number {
  const [subcommand] = process.argv.slice(2);
  switch (subcommand) {
    case "snapshot":
      runSnapshot();
      return 0;
    case "classify":
      runClassify();
      return 0;
    case "decide-retry":
      runDecideRetry();
      return 0;
    default:
      console.error("usage: runner-pressure.mts <snapshot|classify|decide-retry>");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
