// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepMs } from "../../core/wait";
import type { UninstallPaths } from "../../domain/uninstall/paths";
import {
  type BedrockRuntimeAdapterProcessRuntime,
  type BedrockRuntimeAdapterState,
  type BedrockRuntimeAdapterUninstallJournal,
  type BedrockRuntimeAdapterUninstallPhase,
  type ObservedBedrockRuntimeAdapterProcess,
  bedrockRuntimeAdapterProcessPresence,
  canonicalPath,
  canonicalPid,
  isBedrockRuntimeAdapterState,
  legacyBedrockRuntimeGeneration,
  observeBedrockRuntimeAdapterProcess,
  readBedrockRuntimeAdapterUninstallJournal,
  readPrivateBedrockRuntimeFile,
  removeDurableBedrockRuntimeFile,
  resolveBedrockRuntimeAdapterLifecyclePaths,
  withBedrockRuntimeAdapterLifecycleLock,
  writeDurablePrivateBedrockRuntimeJson,
} from "../../inference/bedrock-runtime/lifecycle";
import { BEDROCK_RUNTIME_ADAPTER_PROCESS_MATCHER } from "../../inference/bedrock-runtime";

interface RuntimeAdapterCleanupRuntime extends BedrockRuntimeAdapterProcessRuntime {
  commandExists: (command: string) => boolean;
  existsSync: (target: string) => boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export type BedrockRuntimeAdapterStopResult =
  | { ok: true; status: "absent" | "stopped"; pid?: number }
  | { ok: false; fatal: true; message: string; pid?: number };

type RuntimeAdapterDescriptor = {
  cmdlineMatcher: string | RegExp;
  defaultPort: number;
  envPort: string;
  label: string;
  pidFile: string;
};

const BEDROCK_RUNTIME_ADAPTER: RuntimeAdapterDescriptor = {
  cmdlineMatcher: BEDROCK_RUNTIME_ADAPTER_PROCESS_MATCHER,
  defaultPort: 11436,
  envPort: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
  label: "Bedrock Runtime adapter",
  pidFile: "bedrock-runtime-adapter.pid",
};

const BEDROCK_STATE_FILE = "bedrock-runtime-adapter.json";
const BEDROCK_TOKEN_FILE = "bedrock-runtime-adapter-token";
const PROCESS_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_EXIT_POLL_MS = 50;

const OPENROUTER_RUNTIME_ADAPTER: RuntimeAdapterDescriptor = {
  cmdlineMatcher: "openrouter-runtime-adapter",
  defaultPort: 11437,
  envPort: "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
  label: "OpenRouter Runtime adapter",
  pidFile: "openrouter-runtime-adapter.pid",
};

const HTTPS_PIN_RUNTIME_ADAPTER: RuntimeAdapterDescriptor = {
  cmdlineMatcher: "https-pin-runtime-adapter",
  defaultPort: 11438,
  envPort: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
  label: "HTTPS Pin Runtime adapter",
  pidFile: "https-pin-runtime-adapter.pid",
};

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveRuntimeAdapterPort(
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
): number {
  const raw = runtime.env[descriptor.envPort];
  if (raw === undefined || raw === "") return descriptor.defaultPort;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return descriptor.defaultPort;
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) return descriptor.defaultPort;
  return parsed;
}

function isRuntimeAdapterPid(
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  if (result.status !== 0) return false;
  return typeof descriptor.cmdlineMatcher === "string"
    ? result.stdout.includes(descriptor.cmdlineMatcher)
    : descriptor.cmdlineMatcher.test(result.stdout);
}

function pidExists(pid: number, runtime: RuntimeAdapterCleanupRuntime): boolean {
  return runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env }).status === 0;
}

function waitForPidExit(
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, runtime)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, runtime);
}

function pidOwnedByCurrentUser(pid: number, runtime: RuntimeAdapterCleanupRuntime): boolean {
  const expected = runtime.env.SUDO_USER || runtime.env.LOGNAME || os.userInfo().username;
  if (!expected) return true;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "user="], { env: runtime.env });
  return result.status === 0 && result.stdout.trim() === expected;
}

function tryStopRuntimeAdapterPid(
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
): boolean {
  runtime.kill(pid);
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped ${descriptor.label} ${pid}`);
    return true;
  }
  runtime.kill(pid, "SIGKILL");
  if (waitForPidExit(pid, runtime, 1000)) {
    runtime.log(`Stopped ${descriptor.label} ${pid}`);
    return true;
  }
  runtime.warn(`Failed to stop ${descriptor.label} ${pid}`);
  return false;
}

function stopRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  descriptor: RuntimeAdapterDescriptor,
  options: { scanOrphans?: boolean } = {},
): void {
  const stopped = new Set<number>();

  const pidFile = path.join(paths.nemoclawStateDir, descriptor.pidFile);
  if (runtime.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && isRuntimeAdapterPid(pid, runtime, descriptor)) {
        if (tryStopRuntimeAdapterPid(pid, runtime, descriptor)) stopped.add(pid);
      }
    } catch {
      /* ignore - the State step deletes the file shortly anyway */
    }
  }

  if (options.scanOrphans === false) {
    if (stopped.size === 0) runtime.log(`No selected-gateway ${descriptor.label} found`);
    return;
  }

  if (!runtime.commandExists("lsof")) {
    if (stopped.size === 0) {
      runtime.warn(`lsof not found; skipping orphan ${descriptor.label} scan.`);
    }
    return;
  }

  const adapterPort = resolveRuntimeAdapterPort(runtime, descriptor);
  const lsof = runtime.run("lsof", ["-ti", `:${adapterPort}`], { env: runtime.env });
  const pids = splitNonEmptyLines(lsof.stdout).map(Number).filter(Number.isFinite);
  for (const pid of pids) {
    if (stopped.has(pid)) continue;
    if (!pidOwnedByCurrentUser(pid, runtime)) continue;
    if (!isRuntimeAdapterPid(pid, runtime, descriptor)) continue;
    if (tryStopRuntimeAdapterPid(pid, runtime, descriptor)) stopped.add(pid);
  }

  if (stopped.size === 0) runtime.log(`No ${descriptor.label} processes found`);
}

interface BedrockEvidencePaths {
  pidPath: string;
  statePath: string;
  tokenPath: string;
}

interface BedrockEvidence {
  generation: string;
  pid: number;
  pidFilePresent: boolean;
  state: BedrockRuntimeAdapterState | null;
  stateText: string;
  tokenHash: string;
}

function bedrockEvidencePaths(stateDir: string): BedrockEvidencePaths {
  return {
    pidPath: path.join(stateDir, BEDROCK_RUNTIME_ADAPTER.pidFile),
    statePath: path.join(stateDir, BEDROCK_STATE_FILE),
    tokenPath: path.join(stateDir, BEDROCK_TOKEN_FILE),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isLegacyBedrockRuntimeAdapterState(value: Record<string, unknown>): boolean {
  return (
    value.version === undefined &&
    canonicalPid(`${String(value.pid)}\n`) !== null &&
    typeof value.endpointUrl === "string" &&
    value.endpointUrl.length > 0 &&
    typeof value.region === "string" &&
    value.region.length > 0 &&
    typeof value.credentialHash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.credentialHash) &&
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.updatedAt))
  );
}

function readBedrockEvidence(
  evidencePaths: BedrockEvidencePaths,
  runtime: RuntimeAdapterCleanupRuntime,
):
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "pid-only"; pid: number }
  | { kind: "present"; evidence: BedrockEvidence } {
  const present = {
    pid: runtime.existsSync(evidencePaths.pidPath),
    state: runtime.existsSync(evidencePaths.statePath),
    token: runtime.existsSync(evidencePaths.tokenPath),
  };
  if (!present.pid && !present.state && !present.token) return { kind: "absent" };
  if (present.pid && !present.state && !present.token) {
    const pidText = readPrivateBedrockRuntimeFile(evidencePaths.pidPath);
    const pid = pidText === null ? null : canonicalPid(pidText);
    return pid === null
      ? {
          kind: "invalid",
          message:
            "Bedrock Runtime adapter PID-only evidence is unsafe or malformed; no files were removed.",
        }
      : { kind: "pid-only", pid };
  }
  if (!present.state || !present.token) {
    return {
      kind: "invalid",
      message: "Bedrock Runtime adapter lifecycle evidence is incomplete; no files were removed.",
    };
  }

  const stateText = readPrivateBedrockRuntimeFile(evidencePaths.statePath);
  const tokenText = readPrivateBedrockRuntimeFile(evidencePaths.tokenPath);
  const pidText = present.pid ? readPrivateBedrockRuntimeFile(evidencePaths.pidPath) : null;
  if (
    stateText === null ||
    tokenText === null ||
    (present.pid && pidText === null) ||
    !/^[^\s\u0000]{1,512}\n?$/u.test(tokenText)
  ) {
    return {
      kind: "invalid",
      message:
        "Bedrock Runtime adapter lifecycle evidence is unsafe or malformed; no files were removed.",
    };
  }

  const stateValue = parseJsonObject(stateText);
  const statePid = stateValue && canonicalPid(`${String(stateValue.pid)}\n`);
  const persistedPid = pidText === null ? statePid : canonicalPid(pidText);
  if (
    stateValue === null ||
    statePid === null ||
    persistedPid === null ||
    statePid !== persistedPid
  ) {
    return {
      kind: "invalid",
      message:
        "Bedrock Runtime adapter PID and lifecycle state do not match; no process was signaled.",
    };
  }

  const tokenHash = crypto.createHash("sha256").update(tokenText.trim()).digest("hex");
  const state = isBedrockRuntimeAdapterState(stateValue) ? stateValue : null;
  if (!state && !isLegacyBedrockRuntimeAdapterState(stateValue)) {
    return {
      kind: "invalid",
      message: "Bedrock Runtime adapter lifecycle state is malformed; no process was signaled.",
    };
  }
  if (state && state.tokenHash !== tokenHash) {
    return {
      kind: "invalid",
      message:
        "Bedrock Runtime adapter token and lifecycle state do not match; no process was signaled.",
    };
  }
  return {
    kind: "present",
    evidence: {
      generation: state
        ? state.generation
        : legacyBedrockRuntimeGeneration(stateText, persistedPid, tokenHash),
      pid: persistedPid,
      pidFilePresent: present.pid,
      state,
      stateText,
      tokenHash,
    },
  };
}

function currentProcessOwner(): { uid: number; user: string } | null {
  const uid = process.getuid?.();
  const user = os.userInfo().username;
  return Number.isSafeInteger(uid) && uid! >= 0 && user ? { uid: uid!, user } : null;
}

function journalFromEvidence(
  evidence: BedrockEvidence,
  observed: ObservedBedrockRuntimeAdapterProcess | null,
  gatewayPort: number,
  adapterPort: number,
): BedrockRuntimeAdapterUninstallJournal | null {
  const owner = currentProcessOwner();
  if (!owner) return null;
  if (evidence.state) {
    const state = evidence.state;
    if (
      state.uid !== owner.uid ||
      state.user !== owner.user ||
      state.adapterPort !== adapterPort ||
      (observed !== null &&
        (observed.adapterPort !== state.adapterPort ||
          observed.executablePath !== canonicalPath(state.executablePath) ||
          observed.generation !== state.generation ||
          observed.processStart !== state.processStart ||
          observed.scriptPath !== canonicalPath(state.scriptPath) ||
          observed.uid !== state.uid ||
          observed.user !== state.user))
    ) {
      return null;
    }
  } else if (
    observed !== null &&
    (observed.adapterPort !== adapterPort ||
      observed.generation !== null ||
      observed.uid !== owner.uid ||
      observed.user !== owner.user)
  ) {
    return null;
  }

  const processAuthority =
    evidence.state ??
    observed ??
    (evidence.generation.startsWith("legacy:")
      ? {
          processStart: "legacy-unbound",
          user: owner.user,
          uid: owner.uid,
          executablePath: canonicalPath(process.execPath),
          scriptPath: canonicalPath(path.resolve("bedrock-runtime-adapter.mts")),
        }
      : null);
  if (!processAuthority) return null;
  const now = new Date().toISOString();
  return {
    version: 1,
    phase: "prepared",
    gatewayPort,
    generation: evidence.generation,
    pid: evidence.pid,
    processStart: processAuthority.processStart,
    user: processAuthority.user,
    uid: processAuthority.uid,
    executablePath: canonicalPath(processAuthority.executablePath),
    scriptPath: canonicalPath(processAuthority.scriptPath),
    adapterPort,
    tokenHash: evidence.tokenHash,
    createdAt: now,
    updatedAt: now,
  };
}

function advanceBedrockJournal(
  journalPath: string,
  journal: BedrockRuntimeAdapterUninstallJournal,
  phase: BedrockRuntimeAdapterUninstallPhase,
): BedrockRuntimeAdapterUninstallJournal {
  const next = { ...journal, phase, updatedAt: new Date().toISOString() };
  writeDurablePrivateBedrockRuntimeJson(journalPath, next);
  return next;
}

function stopFailure(
  _runtime: RuntimeAdapterCleanupRuntime,
  message: string,
  pid?: number,
): BedrockRuntimeAdapterStopResult {
  return { ok: false, fatal: true, message, ...(pid === undefined ? {} : { pid }) };
}

function pidOnlyEvidenceMatches(
  evidencePaths: BedrockEvidencePaths,
  journalPath: string,
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
): boolean {
  if (
    !runtime.existsSync(evidencePaths.pidPath) ||
    runtime.existsSync(evidencePaths.statePath) ||
    runtime.existsSync(evidencePaths.tokenPath) ||
    runtime.existsSync(journalPath)
  ) {
    return false;
  }
  const pidText = readPrivateBedrockRuntimeFile(evidencePaths.pidPath);
  return pidText !== null && canonicalPid(pidText) === pid;
}

function retireAbsentPidOnlyEvidence(
  evidencePaths: BedrockEvidencePaths,
  journalPath: string,
  pid: number,
  runtime: RuntimeAdapterCleanupRuntime,
): BedrockRuntimeAdapterStopResult {
  const presence = bedrockRuntimeAdapterProcessPresence(pid, runtime);
  if (presence === "unknown") {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter PID-only process state is unavailable; PID evidence was preserved.",
      pid,
    );
  }
  if (presence === "present") {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter PID-only evidence cannot authorize a process signal; PID evidence was preserved.",
      pid,
    );
  }
  if (!pidOnlyEvidenceMatches(evidencePaths, journalPath, pid, runtime)) {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter PID-only evidence changed before cleanup; no files were removed.",
      pid,
    );
  }
  if (
    bedrockRuntimeAdapterProcessPresence(pid, runtime) !== "absent" ||
    !pidOnlyEvidenceMatches(evidencePaths, journalPath, pid, runtime)
  ) {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter process absence or PID-only evidence could not be revalidated before deletion; PID evidence was preserved.",
      pid,
    );
  }
  removeDurableBedrockRuntimeFile(evidencePaths.pidPath);
  runtime.log(`Removed stale Bedrock Runtime adapter PID evidence ${String(pid)}`);
  return { ok: true, status: "stopped", pid };
}

function waitForRecordedProcessExit(
  journal: BedrockRuntimeAdapterUninstallJournal,
  runtime: RuntimeAdapterCleanupRuntime,
): boolean | null {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const presence = bedrockRuntimeAdapterProcessPresence(journal.pid, runtime);
    if (presence === "absent") return true;
    if (presence === "unknown") return null;
    (runtime.sleep ?? sleepMs)(PROCESS_EXIT_POLL_MS);
  }
  const presence = bedrockRuntimeAdapterProcessPresence(journal.pid, runtime);
  return presence === "unknown" ? null : presence === "absent";
}

function signalRecordedProcess(
  journalPath: string,
  journal: BedrockRuntimeAdapterUninstallJournal,
  phase: "term-sent" | "kill-sent",
  signal: "SIGTERM" | "SIGKILL",
  runtime: RuntimeAdapterCleanupRuntime,
): { journal: BedrockRuntimeAdapterUninstallJournal; exited: boolean | null } | null {
  const next = advanceBedrockJournal(journalPath, journal, phase);
  if (!observeBedrockRuntimeAdapterProcess(next.pid, runtime, next)) return null;
  runtime.kill(next.pid, signal);
  return { journal: next, exited: waitForRecordedProcessExit(next, runtime) };
}

function runBedrockStopPhases(
  journalPath: string,
  initial: BedrockRuntimeAdapterUninstallJournal,
  runtime: RuntimeAdapterCleanupRuntime,
):
  | { kind: "failure"; message: string; journal: BedrockRuntimeAdapterUninstallJournal }
  | { kind: "ready"; journal: BedrockRuntimeAdapterUninstallJournal } {
  let journal = initial;
  const initialPresence = bedrockRuntimeAdapterProcessPresence(journal.pid, runtime);
  if (initialPresence === "unknown") {
    return {
      kind: "failure",
      message: "Bedrock Runtime adapter process state is unavailable.",
      journal,
    };
  }
  if (initialPresence === "absent") {
    journal = advanceBedrockJournal(journalPath, journal, "process-absent");
    return { kind: "ready", journal };
  }

  if (journal.generation.startsWith("legacy:")) {
    return {
      kind: "failure",
      message:
        "Bedrock Runtime adapter legacy state cannot prove the live process generation; no signal was sent. Resolve the unverified live process outside this command, then rerun uninstall.",
      journal,
    };
  }

  if (journal.phase === "prepared" || journal.phase === "term-sent") {
    const term = signalRecordedProcess(journalPath, journal, "term-sent", "SIGTERM", runtime);
    if (!term) {
      return {
        kind: "failure",
        message: "Bedrock Runtime adapter process identity could not be revalidated before TERM.",
        journal,
      };
    }
    journal = term.journal;
    if (term.exited === null) {
      return {
        kind: "failure",
        message: "Bedrock Runtime adapter process state became unavailable after TERM.",
        journal,
      };
    }
    if (term.exited) {
      journal = advanceBedrockJournal(journalPath, journal, "process-absent");
      return { kind: "ready", journal };
    }
  }

  if (journal.phase === "term-sent" || journal.phase === "kill-sent") {
    const kill = signalRecordedProcess(journalPath, journal, "kill-sent", "SIGKILL", runtime);
    if (!kill) {
      return {
        kind: "failure",
        message: "Bedrock Runtime adapter process identity could not be revalidated before KILL.",
        journal,
      };
    }
    journal = kill.journal;
    if (kill.exited === null) {
      return {
        kind: "failure",
        message: "Bedrock Runtime adapter process state became unavailable after KILL.",
        journal,
      };
    }
    if (!kill.exited) {
      return {
        kind: "failure",
        message: "Failed to stop Bedrock Runtime adapter after TERM and KILL.",
        journal,
      };
    }
    journal = advanceBedrockJournal(journalPath, journal, "process-absent");
  }
  return { kind: "ready", journal };
}

function stateMatchesJournal(
  stateText: string,
  journal: BedrockRuntimeAdapterUninstallJournal,
): boolean {
  const stateValue = parseJsonObject(stateText);
  if (!stateValue) return false;
  const statePid = canonicalPid(`${String(stateValue.pid)}\n`);
  if (statePid !== journal.pid) return false;
  if (isBedrockRuntimeAdapterState(stateValue)) {
    return (
      stateValue.generation === journal.generation &&
      stateValue.processStart === journal.processStart &&
      stateValue.user === journal.user &&
      stateValue.uid === journal.uid &&
      canonicalPath(stateValue.executablePath) === canonicalPath(journal.executablePath) &&
      canonicalPath(stateValue.scriptPath) === canonicalPath(journal.scriptPath) &&
      stateValue.adapterPort === journal.adapterPort &&
      stateValue.tokenHash === journal.tokenHash
    );
  }
  return (
    legacyBedrockRuntimeGeneration(stateText, journal.pid, journal.tokenHash) === journal.generation
  );
}

function evidenceFileMatchesJournal(
  target: keyof BedrockEvidencePaths,
  evidencePaths: BedrockEvidencePaths,
  journal: BedrockRuntimeAdapterUninstallJournal,
): boolean {
  const raw = readPrivateBedrockRuntimeFile(evidencePaths[target]);
  if (raw === null) return false;
  if (target === "pidPath") return canonicalPid(raw) === journal.pid;
  if (target === "tokenPath") {
    return crypto.createHash("sha256").update(raw.trim()).digest("hex") === journal.tokenHash;
  }
  return stateMatchesJournal(raw, journal);
}

function validateRetirementEvidence(
  evidencePaths: BedrockEvidencePaths,
  journal: BedrockRuntimeAdapterUninstallJournal,
  allowAbsent: boolean,
  runtime: RuntimeAdapterCleanupRuntime,
): boolean {
  return (["pidPath", "tokenPath", "statePath"] as const).every((target) => {
    if (!runtime.existsSync(evidencePaths[target])) return allowAbsent;
    return evidenceFileMatchesJournal(target, evidencePaths, journal);
  });
}

function retireBedrockEvidence(
  journalPath: string,
  initial: BedrockRuntimeAdapterUninstallJournal,
  evidencePaths: BedrockEvidencePaths,
  runtime: RuntimeAdapterCleanupRuntime,
): BedrockRuntimeAdapterStopResult {
  if (bedrockRuntimeAdapterProcessPresence(initial.pid, runtime) !== "absent") {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter process absence could not be revalidated before evidence deletion.",
      initial.pid,
    );
  }
  if (!validateRetirementEvidence(evidencePaths, initial, true, runtime)) {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter lifecycle generation could not be revalidated before evidence deletion; current evidence was preserved.",
      initial.pid,
    );
  }
  if (initial.phase === "evidence-retired") {
    if (
      runtime.existsSync(evidencePaths.pidPath) ||
      runtime.existsSync(evidencePaths.tokenPath) ||
      runtime.existsSync(evidencePaths.statePath)
    ) {
      return stopFailure(
        runtime,
        "Bedrock Runtime adapter lifecycle evidence reappeared after retirement; current evidence and journal were preserved.",
        initial.pid,
      );
    }
    removeDurableBedrockRuntimeFile(journalPath);
    return { ok: true, status: "stopped", pid: initial.pid };
  }

  let journal = advanceBedrockJournal(journalPath, initial, "evidence-retiring");
  for (const target of ["pidPath", "tokenPath", "statePath"] as const) {
    if (!runtime.existsSync(evidencePaths[target])) continue;
    if (bedrockRuntimeAdapterProcessPresence(journal.pid, runtime) !== "absent") {
      return stopFailure(
        runtime,
        "Bedrock Runtime adapter PID was reused during evidence deletion; remaining evidence and journal were preserved.",
        journal.pid,
      );
    }
    if (!evidenceFileMatchesJournal(target, evidencePaths, journal)) {
      return stopFailure(
        runtime,
        "Bedrock Runtime adapter lifecycle generation could not be revalidated during evidence deletion; remaining evidence was preserved.",
        journal.pid,
      );
    }
    removeDurableBedrockRuntimeFile(evidencePaths[target]);
  }
  journal = advanceBedrockJournal(journalPath, journal, "evidence-retired");
  removeDurableBedrockRuntimeFile(journalPath);
  runtime.log(`Stopped Bedrock Runtime adapter ${String(journal.pid)}`);
  return { ok: true, status: "stopped", pid: journal.pid };
}

function discoverUnboundBedrockListeners(
  runtime: RuntimeAdapterCleanupRuntime,
  adapterPort: number,
): void {
  if (!runtime.commandExists("lsof")) {
    runtime.warn("lsof not found; skipping orphan Bedrock Runtime adapter scan.");
    return;
  }
  const lsof = runtime.run("lsof", ["-ti", `:${String(adapterPort)}`], { env: runtime.env });
  if (lsof.status !== 0 && lsof.status !== 1) {
    runtime.warn(
      "Bedrock Runtime adapter orphan scan could not inspect the configured port; no process was signaled.",
    );
    return;
  }
  const pids = splitNonEmptyLines(lsof.stdout)
    .map((raw) => canonicalPid(`${raw}\n`))
    .filter((pid): pid is number => pid !== null);
  const owner = currentProcessOwner();
  const candidates = owner
    ? pids.filter((pid) => {
        const observed = observeBedrockRuntimeAdapterProcess(pid, runtime);
        return (
          observed?.uid === owner.uid &&
          observed.user === owner.user &&
          observed.adapterPort === adapterPort
        );
      })
    : [];
  if (candidates.length > 0) {
    runtime.warn(
      "Found an unbound Bedrock Runtime adapter listener; no process was signaled without matching lifecycle state.",
    );
  } else {
    runtime.log("No Bedrock Runtime adapter processes found");
  }
}

function discoverBedrockListenerPids(
  runtime: RuntimeAdapterCleanupRuntime,
  adapterPort: number,
): number[] | null {
  if (!runtime.commandExists("lsof")) return null;
  const lsof = runtime.run("lsof", ["-ti", `:${String(adapterPort)}`], { env: runtime.env });
  if (lsof.status !== 0 && lsof.status !== 1) return null;
  return splitNonEmptyLines(lsof.stdout)
    .map((raw) => canonicalPid(`${raw}\n`))
    .filter((pid): pid is number => pid !== null);
}

function stopBedrockRuntimeAdapterLocked(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  journalPath: string,
  gatewayPort: number,
  scanOrphans: boolean,
): BedrockRuntimeAdapterStopResult {
  const evidencePaths = bedrockEvidencePaths(paths.nemoclawStateDir);
  const adapterPort = resolveRuntimeAdapterPort(runtime, BEDROCK_RUNTIME_ADAPTER);
  const journalExists = runtime.existsSync(journalPath);
  let journal = journalExists ? readBedrockRuntimeAdapterUninstallJournal(journalPath) : null;
  if (
    journalExists &&
    (!journal || journal.gatewayPort !== gatewayPort || journal.adapterPort !== adapterPort)
  ) {
    return stopFailure(
      runtime,
      "Bedrock Runtime adapter uninstall journal is unsafe, malformed, or does not match the selected gateway and configured adapter port; lifecycle evidence was preserved.",
    );
  }

  if (!journal) {
    const evidenceResult = readBedrockEvidence(evidencePaths, runtime);
    if (evidenceResult.kind === "invalid") {
      return stopFailure(runtime, evidenceResult.message);
    }
    if (evidenceResult.kind === "pid-only") {
      return retireAbsentPidOnlyEvidence(
        evidencePaths,
        journalPath,
        evidenceResult.pid,
        runtime,
      );
    }
    if (evidenceResult.kind === "absent") {
      if (scanOrphans) {
        discoverUnboundBedrockListeners(
          runtime,
          resolveRuntimeAdapterPort(runtime, BEDROCK_RUNTIME_ADAPTER),
        );
      } else {
        runtime.log("No selected-gateway Bedrock Runtime adapter found");
      }
      return { ok: true, status: "absent" };
    }

    const { evidence } = evidenceResult;
    const presence = bedrockRuntimeAdapterProcessPresence(evidence.pid, runtime);
    if (presence === "unknown") {
      return stopFailure(
        runtime,
        "Bedrock Runtime adapter process state is unavailable; lifecycle evidence was preserved.",
        evidence.pid,
      );
    }
    if (scanOrphans && !evidence.pidFilePresent && presence === "present") {
      const discovered = discoverBedrockListenerPids(runtime, adapterPort);
      if (!discovered || !discovered.includes(evidence.pid)) {
        return stopFailure(
          runtime,
          "Bedrock Runtime adapter orphan discovery did not confirm the state-bound listener; lifecycle evidence was preserved.",
          evidence.pid,
        );
      }
    }
    const observed =
      presence === "present" ? observeBedrockRuntimeAdapterProcess(evidence.pid, runtime) : null;
    if (presence === "present" && !observed) {
      return stopFailure(
        runtime,
        "Bedrock Runtime adapter process ownership could not be proven; no process was signaled.",
        evidence.pid,
      );
    }
    journal = journalFromEvidence(evidence, observed, gatewayPort, adapterPort);
    if (!journal) {
      return stopFailure(
        runtime,
        "Bedrock Runtime adapter lifecycle state does not match the configured adapter port, current user, process identity, or generation; no process was signaled.",
        evidence.pid,
      );
    }
    writeDurablePrivateBedrockRuntimeJson(journalPath, journal);
    if (presence === "absent") {
      journal = advanceBedrockJournal(journalPath, journal, "process-absent");
    }
  }

  if (
    journal.phase === "process-absent" ||
    journal.phase === "evidence-retiring" ||
    journal.phase === "evidence-retired"
  ) {
    return retireBedrockEvidence(journalPath, journal, evidencePaths, runtime);
  }
  const stopped = runBedrockStopPhases(journalPath, journal, runtime);
  if (stopped.kind === "failure") {
    return stopFailure(runtime, stopped.message, stopped.journal.pid);
  }
  return retireBedrockEvidence(journalPath, stopped.journal, evidencePaths, runtime);
}

export function stopBedrockRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  options: { gatewayPort: number; scanOrphans?: boolean },
): BedrockRuntimeAdapterStopResult {
  const home = runtime.env.HOME || os.homedir();
  const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, options.gatewayPort);
  try {
    return withBedrockRuntimeAdapterLifecycleLock(lifecycle, () =>
      stopBedrockRuntimeAdapterLocked(
        paths,
        runtime,
        lifecycle.journalPath,
        options.gatewayPort,
        options.scanOrphans !== false,
      ),
    );
  } catch (error) {
    return stopFailure(
      runtime,
      `Bedrock Runtime adapter cleanup could not preserve its lifecycle journal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function stopOpenRouterRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  options: { scanOrphans?: boolean } = {},
): void {
  stopRuntimeAdapter(paths, runtime, OPENROUTER_RUNTIME_ADAPTER, options);
}

export function stopHttpsPinRuntimeAdapter(
  paths: Pick<UninstallPaths, "nemoclawStateDir">,
  runtime: RuntimeAdapterCleanupRuntime,
  options: { scanOrphans?: boolean } = {},
): void {
  stopRuntimeAdapter(paths, runtime, HTTPS_PIN_RUNTIME_ADAPTER, options);
}
