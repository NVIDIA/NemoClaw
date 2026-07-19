// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for hosted-runner resource evidence (#7146).
 *
 * Subcommands (all evidence stays secret-safe: numeric fields, fixed enums,
 * fixed ranks only — never process/container names, command payloads,
 * credentials, or environment values):
 *
 * - `snapshot`     — emit one bounded `E2E_RESOURCE_SNAPSHOT` line for the
 *                    phase named by `E2E_PHASE`. Every collector is
 *                    best-effort: unreadable sources become null fields, so
 *                    the line is still emitted on hosts without cgroup v2,
 *                    PSI, or Docker.
 * - `baseline`     — emit the numeric/boolean pre-phase OOM baseline consumed
 *                    by `classify` after the phase.
 * - `classify`     — emit one `E2E_TERMINAL_CLASSIFICATION` line from
 *                    `TEST_OUTCOME` (`assertion` | `timeout` | `none`) plus
 *                    phase-specific on-host OOM/disk evidence. Requires the
 *                    baseline file named by `E2E_RESOURCE_BASELINE_FILE`.
 * - `validate-classification` — fail closed unless the named classification
 *                    artifact contains exactly one canonical terminal line.
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
  countKernelOomKills,
  decideRetry,
  type FailureEvidence,
  parseBaselineLine,
  parseCgroupMemoryEvents,
  parseCgroupScalar,
  parseClassificationLine,
  parseDockerStats,
  parseDockerSystemDf,
  parseLoadAverages,
  parseMeminfo,
  parsePressure,
  parseTopProcesses,
  type ResourceBaseline,
  type ResourceSnapshot,
  renderBaselineLine,
  renderClassificationLine,
  renderSnapshotLine,
  selectFailureBaseline,
  TERMINAL_CLASSIFICATIONS,
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

function runOrNull(command: string, args: string[], timeout = 15_000): string | null {
  try {
    const result = spawnSync(command, args, { encoding: "utf-8", timeout });
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

export function collectResourceSnapshot(phase: string): ResourceSnapshot {
  const meminfoText = readTextOrNull("/proc/meminfo");
  const loadText = readTextOrNull("/proc/loadavg");
  const current = readTextOrNull(`${CGROUP_ROOT}/memory.current`);
  const peak = readTextOrNull(`${CGROUP_ROOT}/memory.peak`);
  const limit = readTextOrNull(`${CGROUP_ROOT}/memory.max`);
  const events = readTextOrNull(`${CGROUP_ROOT}/memory.events`);
  const memoryPressure = readTextOrNull(`${CGROUP_ROOT}/memory.pressure`);
  const ioPressure = readTextOrNull(`${CGROUP_ROOT}/io.pressure`);
  const psText = runOrNull("ps", ["-eo", "rss="]);
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
  console.log(renderSnapshotLine(collectResourceSnapshot(phase)));
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
  const output = runOrNull("docker", ["inspect", "--format", "{{.State.OOMKilled}}", name], 3_000);
  return output !== null && output.trim() === "true";
}

export function collectResourceBaseline(phase: string): ResourceBaseline {
  const events = readTextOrNull(`${CGROUP_ROOT}/memory.events`);
  const kernelLog = runOrNull("dmesg", ["--level=err,warn"], 3_000);
  return {
    phase: assertPhaseLabel(phase),
    at: new Date().toISOString(),
    cgroupOomKills: events === null ? 0 : parseCgroupMemoryEvents(events).oomKill,
    kernelOomKillCount: kernelLog === null ? 0 : countKernelOomKills(kernelLog),
    containerOomKilled: containerOomKilled(process.env.DOCKER_OOM_CONTAINER),
  };
}

function runBaseline(): void {
  console.log(renderBaselineLine(collectResourceBaseline(assertPhaseLabel(process.env.E2E_PHASE))));
}

function assertEvidencePath(path: string | undefined, variableName: string): string {
  if (!path || path.length > 4096 || path.includes("\0")) {
    throw new Error(`${variableName} must name a bounded evidence file`);
  }
  return path;
}

/** Append one phase baseline without replacing the immutable workflow baseline. */
export function appendResourcePhaseBaseline(path: string, phase: string): void {
  const validatedPath = assertEvidencePath(path, "E2E_RESOURCE_PHASE_BASELINES_FILE");
  fs.appendFileSync(validatedPath, `${renderBaselineLine(collectResourceBaseline(phase))}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function readRequiredBaseline(): ResourceBaseline {
  const path = assertEvidencePath(
    process.env.E2E_RESOURCE_BASELINE_FILE,
    "E2E_RESOURCE_BASELINE_FILE",
  );
  const text = readTextOrNull(path);
  if (text === null) {
    throw new Error("E2E_RESOURCE_BASELINE_FILE could not be read");
  }
  return parseBaselineLine(text);
}

function readPhaseBaselines(): ResourceBaseline[] {
  const configuredPath = process.env.E2E_RESOURCE_PHASE_BASELINES_FILE;
  if (!configuredPath) return [];
  const path = assertEvidencePath(configuredPath, "E2E_RESOURCE_PHASE_BASELINES_FILE");
  const text = readTextOrNull(path);
  if (text === null) {
    throw new Error("E2E_RESOURCE_PHASE_BASELINES_FILE could not be read");
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length > 128) {
    throw new Error("phase baseline artifact exceeds the 128-phase bound");
  }
  return lines.map((line) => parseBaselineLine(line));
}

function runValidateClassification(): void {
  const path = assertEvidencePath(
    process.env.E2E_TERMINAL_CLASSIFICATION_FILE,
    "E2E_TERMINAL_CLASSIFICATION_FILE",
  );
  const text = readTextOrNull(path);
  if (text === null) {
    throw new Error("E2E_TERMINAL_CLASSIFICATION_FILE could not be read");
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error("terminal classification artifact must contain exactly one line");
  }
  const classified = parseClassificationLine(lines[0]!);
  console.log(classified.classification);
}

function runClassify(): void {
  const initialBaseline = readRequiredBaseline();
  const current = collectResourceBaseline(initialBaseline.phase);
  const baseline = selectFailureBaseline(initialBaseline, readPhaseBaselines(), current);
  const meminfoText = readTextOrNull("/proc/meminfo");
  const meminfo = meminfoText === null ? null : parseMeminfo(meminfoText);
  const disk = collectDisk();
  const classified = classifyFailure({
    testOutcome: assertTestOutcome(process.env.TEST_OUTCOME),
    cgroupOomKillsBefore: baseline.cgroupOomKills,
    cgroupOomKillsAfter: current.cgroupOomKills,
    kernelOomKillCountBefore: baseline.kernelOomKillCount,
    kernelOomKillCountAfter: current.kernelOomKillCount,
    containerOomKilledBefore: baseline.containerOomKilled,
    containerOomKilledAfter: current.containerOomKilled,
    memFreeKb: meminfo?.memFreeKb ?? null,
    memAvailableKb: meminfo?.memAvailableKb ?? null,
    diskFreeBytes: disk?.freeBytes ?? null,
    inodesFree: disk?.inodesFree ?? null,
  });
  console.log(
    renderClassificationLine({
      ...classified,
      reason: `${classified.reason}; compared against phase '${baseline.phase}'`,
    }),
  );
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
    case "baseline":
      runBaseline();
      return 0;
    case "classify":
      runClassify();
      return 0;
    case "validate-classification":
      runValidateClassification();
      return 0;
    case "decide-retry":
      runDecideRetry();
      return 0;
    default:
      console.error(
        "usage: runner-pressure.mts <snapshot|baseline|classify|validate-classification|decide-retry>",
      );
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
