// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PORTABLE_LIFECYCLE_TIMING_STAGES = [
  "authority",
  "inspect",
  "containerStart",
  "execReady",
  "ollama",
  "gatewayHealth",
  "startupProbe",
  "startupLaunch",
  "gatewayReady",
] as const;

export type PortableLifecycleTimingStage = (typeof PORTABLE_LIFECYCLE_TIMING_STAGES)[number];
export type PortableLifecycleTimingResult =
  | "not-installed"
  | "already-running"
  | "recovered"
  | "failed";
export type PortableLifecycleContainerAction = "unknown" | "reused" | "started";
export type PortableLifecycleGatewayAction = "unavailable" | "reused" | "waited" | "started";
export type PortableLifecycleOllamaAction =
  | "not-applicable"
  | "checking"
  | "reused"
  | "not-owned"
  | "start-attempted"
  | "started";
export type PortableLifecycleAttemptOutcome = "ready" | "not-ready" | "timeout" | "error";
export type PortableOpenClawGatewayTimingReadOutcome =
  | "recorded"
  | "not-applicable"
  | "missing"
  | "malformed"
  | "stale"
  | "timeout"
  | "clock-error"
  | "error";

export const PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX =
  "  Portable OpenClaw gateway startup timing:";
export const PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_MAX_LINE_LENGTH = 512;
export const PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_PATH =
  "/tmp/nemoclaw-openclaw-gateway-startup-timing";
export const PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MAX_BYTES = 512;
export const PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MISSING_STATUS = 44;
// Nine non-overlapping startup phases partition launchToFirstHealth. Probe and
// sleep are overlapping diagnostics and are excluded. The phases and total are
// rounded independently to milliseconds, so emitted values may differ by 5 ms.
export const PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECONCILIATION_TOLERANCE_MS = 5;

const PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_FIELDS = [
  "entry",
  "configStart",
  "configEnd",
  "providerEnd",
  "tokenEnd",
  "messagingEnd",
  "workspaceEnd",
  "spawnEnd",
] as const;
const MAX_EMITTED_GATEWAY_TIMING_MS = 999_999;
const MAX_EMITTED_GATEWAY_ATTEMPTS = 9_999;

type PortableOpenClawGatewayStartupRecordField =
  (typeof PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_FIELDS)[number];
type PortableOpenClawGatewayStartupRecord = Record<
  PortableOpenClawGatewayStartupRecordField,
  number
>;
type PortableOpenClawGatewayLastFailure =
  | Exclude<PortableLifecycleAttemptOutcome, "ready">
  | "none";
type PortableOpenClawGatewayTimingReadResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  error?: Error;
};

export type PortableLifecycleTimingRecorder = {
  measure<T>(stage: PortableLifecycleTimingStage, operation: () => T): T;
  recordExecAttempt(outcome: PortableLifecycleAttemptOutcome): void;
  recordGatewayAttempt(outcome: PortableLifecycleAttemptOutcome): void;
  beginOpenClawGatewayStartup(): void;
  measureOpenClawGatewayProbe<T>(operation: () => T): T;
  measureOpenClawGatewaySleep<T>(operation: () => T): T;
  readOpenClawGatewayStartupTiming(
    operation: () => PortableOpenClawGatewayTimingReadResult,
    maxCorrelationWindowMs: number,
  ): PortableOpenClawGatewayTimingReadOutcome;
  incrementOllamaAttempts(): void;
  setContainerAction(action: PortableLifecycleContainerAction): void;
  setGatewayAction(action: PortableLifecycleGatewayAction): void;
  setOllamaAction(action: PortableLifecycleOllamaAction): void;
  markFailureStage(stage: PortableLifecycleTimingStage): void;
  finish(result: PortableLifecycleTimingResult): void;
};

type PortableLifecycleTimingDeps = {
  now?: () => number;
  epochNow?: () => number;
  write?: (line: string) => void;
};

function safeElapsed(startedAt: number | null, finishedAt: number | null): number {
  if (startedAt === null || finishedAt === null) return 0;
  return Math.max(0, Math.round(finishedAt - startedAt));
}

type AttemptCounts = Record<PortableLifecycleAttemptOutcome, number>;

function createAttemptCounts(): AttemptCounts {
  return { ready: 0, "not-ready": 0, timeout: 0, error: 0 };
}

function boundedGatewayTimingValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_EMITTED_GATEWAY_TIMING_MS, Math.max(0, Math.round(value)));
}

function parsePortableOpenClawGatewayStartupRecord(
  raw: string,
): PortableOpenClawGatewayStartupRecord | null {
  if (Buffer.byteLength(raw, "utf8") > PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MAX_BYTES) {
    return null;
  }
  const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) return null;
  const tokens = line.split(" ");
  if (tokens.length !== PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_FIELDS.length + 1) return null;
  if (tokens[0] !== "schema=1") return null;

  const record = {} as PortableOpenClawGatewayStartupRecord;
  for (const [index, field] of PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_FIELDS.entries()) {
    const token = tokens[index + 1];
    const prefix = `${field}=`;
    if (!token.startsWith(prefix)) return null;
    const encoded = token.slice(prefix.length);
    if (!/^\d{10,13}\.\d{1,6}$/u.test(encoded)) return null;
    const milliseconds = Number(encoded) * 1_000;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
    record[field] = milliseconds;
  }

  const ordered = PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_FIELDS.map((field) => record[field]);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] < ordered[index - 1]) return null;
  }
  return record;
}

function formatPortableOpenClawGatewayStartupTiming(fields: {
  launchToEntry: number;
  entrySetup: number;
  configIntegrity: number;
  providerModelCors: number;
  tokenPlaceholderHash: number;
  messagingChannelsPreloadsScan: number;
  workspaceAuthTemp: number;
  gatewaySpawn: number;
  spawnToFirstHealth: number;
  launchToFirstHealth: number;
  probe: number;
  sleep: number;
  firstReadyAttempt: number;
  lastFailure: PortableOpenClawGatewayLastFailure;
  diagnosticRead: number;
  diagnosticReadOutcome: PortableOpenClawGatewayTimingReadOutcome;
}): string {
  const line = `${PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX} launchToEntry=${String(boundedGatewayTimingValue(fields.launchToEntry))}ms entrySetup=${String(boundedGatewayTimingValue(fields.entrySetup))}ms configIntegrity=${String(boundedGatewayTimingValue(fields.configIntegrity))}ms providerModelCors=${String(boundedGatewayTimingValue(fields.providerModelCors))}ms tokenPlaceholderHash=${String(boundedGatewayTimingValue(fields.tokenPlaceholderHash))}ms messagingChannelsPreloadsScan=${String(boundedGatewayTimingValue(fields.messagingChannelsPreloadsScan))}ms workspaceAuthTemp=${String(boundedGatewayTimingValue(fields.workspaceAuthTemp))}ms gatewaySpawn=${String(boundedGatewayTimingValue(fields.gatewaySpawn))}ms spawnToFirstHealth=${String(boundedGatewayTimingValue(fields.spawnToFirstHealth))}ms launchToFirstHealth=${String(boundedGatewayTimingValue(fields.launchToFirstHealth))}ms probe=${String(boundedGatewayTimingValue(fields.probe))}ms sleep=${String(boundedGatewayTimingValue(fields.sleep))}ms firstReadyAttempt=${String(Math.min(MAX_EMITTED_GATEWAY_ATTEMPTS, Math.max(0, fields.firstReadyAttempt)))} lastFailure=${fields.lastFailure} diagnosticRead=${String(boundedGatewayTimingValue(fields.diagnosticRead))}ms diagnosticReadOutcome=${fields.diagnosticReadOutcome}`;
  if (line.length <= PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_MAX_LINE_LENGTH) return line;
  return `${PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX} launchToEntry=0ms entrySetup=0ms configIntegrity=0ms providerModelCors=0ms tokenPlaceholderHash=0ms messagingChannelsPreloadsScan=0ms workspaceAuthTemp=0ms gatewaySpawn=0ms spawnToFirstHealth=0ms launchToFirstHealth=0ms probe=0ms sleep=0ms firstReadyAttempt=0 lastFailure=none diagnosticRead=0ms diagnosticReadOutcome=error`;
}

/**
 * Record one bounded, credential-free breakdown of Portable lifecycle recovery.
 * The OpenClaw phase fields apply only when recovery launches nemoclaw-start.
 * Diagnostic clock and writer failures are intentionally fail-open.
 */
export function createPortableLifecycleTimingRecorder(
  deps: PortableLifecycleTimingDeps = {},
): PortableLifecycleTimingRecorder {
  const now = deps.now ?? (() => performance.now());
  const epochNow = deps.epochNow ?? Date.now;
  const write = deps.write ?? ((line: string) => console.log(line));
  const durations = new Map<PortableLifecycleTimingStage, number>();
  let containerAction: PortableLifecycleContainerAction = "unknown";
  let gatewayAction: PortableLifecycleGatewayAction = "unavailable";
  let ollamaAction: PortableLifecycleOllamaAction = "not-applicable";
  let ollamaAttempts = 0;
  const execAttempts = createAttemptCounts();
  const gatewayAttempts = createAttemptCounts();
  let gatewayStartupAttemptOrdinal = 0;
  let firstReadyAttempt = 0;
  let gatewayLastFailure: PortableOpenClawGatewayLastFailure = "none";
  let gatewayLaunchAttempted = false;
  let gatewayLaunchEpochMs: number | null = null;
  let gatewayFirstHealthEpochMs: number | null = null;
  let gatewayProbeMs = 0;
  let gatewaySleepMs = 0;
  let gatewayDiagnosticReadMs = 0;
  let gatewayTimingReadOutcome: PortableOpenClawGatewayTimingReadOutcome = "not-applicable";
  let gatewayPhaseDurations = {
    launchToEntry: 0,
    entrySetup: 0,
    configIntegrity: 0,
    providerModelCors: 0,
    tokenPlaceholderHash: 0,
    messagingChannelsPreloadsScan: 0,
    workspaceAuthTemp: 0,
    gatewaySpawn: 0,
    spawnToFirstHealth: 0,
    launchToFirstHealth: 0,
  };
  let failureStage: PortableLifecycleTimingStage | null = null;
  let finished = false;

  const safeNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const totalStartedAt = safeNow();

  const safeEpochNow = (): number | null => {
    try {
      const value = epochNow();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  const measureGatewayDuration = <T>(operation: () => T, record: (elapsed: number) => void): T => {
    const startedAt = safeNow();
    try {
      return operation();
    } finally {
      record(safeElapsed(startedAt, safeNow()));
    }
  };

  const finish = (result: PortableLifecycleTimingResult): void => {
    if (finished) return;
    finished = true;
    try {
      const stageFields = PORTABLE_LIFECYCLE_TIMING_STAGES.map(
        (stage) => `${stage}=${String(durations.get(stage) ?? 0)}ms`,
      );
      const failure = result === "failed" ? ` failedStage=${failureStage ?? "unknown"}` : "";
      const execTotal = Object.values(execAttempts).reduce((total, count) => total + count, 0);
      const gatewayTotal = Object.values(gatewayAttempts).reduce(
        (total, count) => total + count,
        0,
      );
      write(
        `  Portable lifecycle timing: ${stageFields.join(" ")} total=${String(safeElapsed(totalStartedAt, safeNow()))}ms containerAction=${containerAction} gatewayAction=${gatewayAction} ollamaAction=${ollamaAction} ollamaAttempts=${String(ollamaAttempts)} execAttempts=${String(execTotal)} execNotReady=${String(execAttempts["not-ready"])} execTimeouts=${String(execAttempts.timeout)} execErrors=${String(execAttempts.error)} gatewayAttempts=${String(gatewayTotal)} gatewayNotReady=${String(gatewayAttempts["not-ready"])} gatewayTimeouts=${String(gatewayAttempts.timeout)} gatewayErrors=${String(gatewayAttempts.error)} result=${result}${failure}`,
      );
    } catch {
      // Lifecycle timing must never change recovery status or its original error.
    }
    try {
      write(
        formatPortableOpenClawGatewayStartupTiming({
          ...gatewayPhaseDurations,
          probe: gatewayLaunchAttempted ? gatewayProbeMs : 0,
          sleep: gatewayLaunchAttempted ? gatewaySleepMs : 0,
          firstReadyAttempt: gatewayLaunchAttempted ? firstReadyAttempt : 0,
          lastFailure: gatewayLaunchAttempted ? gatewayLastFailure : "none",
          diagnosticRead: gatewayLaunchAttempted ? gatewayDiagnosticReadMs : 0,
          diagnosticReadOutcome: gatewayLaunchAttempted
            ? gatewayTimingReadOutcome
            : "not-applicable",
        }),
      );
    } catch {
      // OpenClaw gateway startup timing must never change lifecycle recovery.
    }
  };

  const measure = <T>(stage: PortableLifecycleTimingStage, operation: () => T): T => {
    const startedAt = safeNow();
    let failed = false;
    try {
      return operation();
    } catch (error) {
      failed = true;
      failureStage ??= stage;
      throw error;
    } finally {
      const elapsed = safeElapsed(startedAt, safeNow());
      durations.set(stage, (durations.get(stage) ?? 0) + elapsed);
      if (failed) finish("failed");
    }
  };

  return {
    measure,
    recordExecAttempt(outcome: PortableLifecycleAttemptOutcome): void {
      execAttempts[outcome] += 1;
    },
    recordGatewayAttempt(outcome: PortableLifecycleAttemptOutcome): void {
      gatewayAttempts[outcome] += 1;
      if (!gatewayLaunchAttempted) return;
      gatewayStartupAttemptOrdinal += 1;
      if (outcome !== "ready") {
        gatewayLastFailure = outcome;
        return;
      }
      firstReadyAttempt ||= gatewayStartupAttemptOrdinal;
      if (gatewayFirstHealthEpochMs === null) {
        gatewayFirstHealthEpochMs = safeEpochNow();
        if (gatewayFirstHealthEpochMs === null) gatewayTimingReadOutcome = "clock-error";
      }
    },
    beginOpenClawGatewayStartup(): void {
      gatewayLaunchAttempted = true;
      gatewayStartupAttemptOrdinal = 0;
      firstReadyAttempt = 0;
      gatewayLastFailure = "none";
      gatewayFirstHealthEpochMs = null;
      gatewayLaunchEpochMs = safeEpochNow();
      if (gatewayLaunchEpochMs === null) gatewayTimingReadOutcome = "clock-error";
    },
    measureOpenClawGatewayProbe<T>(operation: () => T): T {
      return measureGatewayDuration(operation, (elapsed) => {
        gatewayProbeMs += elapsed;
      });
    },
    measureOpenClawGatewaySleep<T>(operation: () => T): T {
      return measureGatewayDuration(operation, (elapsed) => {
        gatewaySleepMs += elapsed;
      });
    },
    readOpenClawGatewayStartupTiming(
      operation: () => PortableOpenClawGatewayTimingReadResult,
      maxCorrelationWindowMs: number,
    ): PortableOpenClawGatewayTimingReadOutcome {
      if (!gatewayLaunchAttempted) return "not-applicable";
      if (gatewayLaunchEpochMs === null || gatewayFirstHealthEpochMs === null) {
        gatewayTimingReadOutcome = "clock-error";
        return gatewayTimingReadOutcome;
      }
      const startedAt = safeNow();
      try {
        const result = operation();
        const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ETIMEDOUT") {
          gatewayTimingReadOutcome = "timeout";
          return gatewayTimingReadOutcome;
        }
        if (result.error) {
          gatewayTimingReadOutcome = "error";
          return gatewayTimingReadOutcome;
        }
        if (result.status === PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MISSING_STATUS) {
          gatewayTimingReadOutcome = "missing";
          return gatewayTimingReadOutcome;
        }
        if (result.status !== 0) {
          gatewayTimingReadOutcome = "error";
          return gatewayTimingReadOutcome;
        }
        const record = parsePortableOpenClawGatewayStartupRecord(String(result.stdout ?? ""));
        if (!record) {
          gatewayTimingReadOutcome = "malformed";
          return gatewayTimingReadOutcome;
        }
        if (
          record.entry < gatewayLaunchEpochMs ||
          record.spawnEnd > gatewayFirstHealthEpochMs ||
          gatewayFirstHealthEpochMs < gatewayLaunchEpochMs ||
          gatewayFirstHealthEpochMs - gatewayLaunchEpochMs > maxCorrelationWindowMs
        ) {
          gatewayTimingReadOutcome = "stale";
          return gatewayTimingReadOutcome;
        }
        gatewayPhaseDurations = {
          launchToEntry: record.entry - gatewayLaunchEpochMs,
          entrySetup: record.configStart - record.entry,
          configIntegrity: record.configEnd - record.configStart,
          providerModelCors: record.providerEnd - record.configEnd,
          tokenPlaceholderHash: record.tokenEnd - record.providerEnd,
          messagingChannelsPreloadsScan: record.messagingEnd - record.tokenEnd,
          workspaceAuthTemp: record.workspaceEnd - record.messagingEnd,
          gatewaySpawn: record.spawnEnd - record.workspaceEnd,
          spawnToFirstHealth: gatewayFirstHealthEpochMs - record.spawnEnd,
          launchToFirstHealth: gatewayFirstHealthEpochMs - gatewayLaunchEpochMs,
        };
        gatewayTimingReadOutcome = "recorded";
        return gatewayTimingReadOutcome;
      } catch {
        gatewayTimingReadOutcome = "error";
        return gatewayTimingReadOutcome;
      } finally {
        gatewayDiagnosticReadMs += safeElapsed(startedAt, safeNow());
      }
    },
    incrementOllamaAttempts(): void {
      ollamaAttempts += 1;
    },
    setContainerAction(action: PortableLifecycleContainerAction): void {
      containerAction = action;
    },
    setGatewayAction(action: PortableLifecycleGatewayAction): void {
      gatewayAction = action;
    },
    setOllamaAction(action: PortableLifecycleOllamaAction): void {
      ollamaAction = action;
    },
    markFailureStage(stage: PortableLifecycleTimingStage): void {
      failureStage ??= stage;
    },
    finish,
  };
}
