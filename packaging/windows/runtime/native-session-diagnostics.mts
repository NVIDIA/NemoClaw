// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { openNativeUiFileOwner } from "./native-ui-file-owner.mts";

const LINE_LIMIT = 16 * 1024;
const TAIL_LIMIT = 24 * 1024;

export type NativeFailurePresentation = {
  stage: string;
  message: string;
  diagnosticPath?: string;
};

export class NativeSessionFailure extends Error {
  readonly presentation: NativeFailurePresentation;
  constructor(presentation: NativeFailurePresentation, cause: unknown) {
    super(presentation.message, { cause });
    this.name = "NativeSessionFailure";
    this.presentation = presentation;
  }
}

export function sanitizeNativeDiagnostic(text: string, secrets: readonly string[] = []) {
  let safe = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    values.add(JSON.stringify(secret).slice(1, -1));
    values.add(encodeURIComponent(secret));
  }
  for (const secret of [...values].sort((a, b) => b.length - a.length))
    safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/\b(Bearer\s+)[^\s"',;]+/giu, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|broker[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$1[REDACTED]",
    );
}

export function nativeDiagnosticTail(
  text: string,
  secrets: readonly string[] = [],
  limit = 16 * 1024,
) {
  const safe = sanitizeNativeDiagnostic(text, secrets);
  if (safe.length <= limit) return safe;
  const tail = safe.slice(-limit);
  const newline = tail.indexOf("\n");
  return "[earlier diagnostic output omitted]\n" + (newline >= 0 ? tail.slice(newline + 1) : tail);
}

// Complete lines are sanitized before entering the bounded tail. An oversized
// line is discarded in full, so a chunk boundary cannot expose a secret suffix.
export function createNativeDiagnosticCapture(secrets: () => readonly string[]) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  let tail = "";
  let finished = false;
  const emit = (line: string) => {
    tail += sanitizeNativeDiagnostic(line, secrets()) + "\n";
    if (tail.length > TAIL_LIMIT) {
      const start = tail.indexOf("\n", tail.length - TAIL_LIMIT);
      tail = start < 0 ? "" : tail.slice(start + 1);
    }
  };
  const consume = (text: string) => {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      const ended = part.endsWith("\n");
      if (!dropping) {
        if (pending.length + part.length > LINE_LIMIT) {
          pending = "";
          dropping = true;
        } else pending += part;
      }
      if (ended) {
        emit(dropping ? "[overlong diagnostic line omitted]" : pending.trimEnd());
        pending = "";
        dropping = false;
      }
    }
  };
  return {
    write(chunk: Buffer | string) {
      if (!finished) consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
    },
    finish() {
      if (!finished) {
        consume(decoder.end());
        if (pending || dropping) emit(dropping ? "[overlong diagnostic line omitted]" : pending);
        pending = "";
        finished = true;
      }
      tail = nativeDiagnosticTail(tail, secrets(), TAIL_LIMIT);
      return tail;
    },
    text() {
      return nativeDiagnosticTail(tail, secrets(), TAIL_LIMIT);
    },
  };
}

function errorDetail(error: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth >= 4) return { message: "Further error causes omitted." };
  if (!(error instanceof Error)) return { message: "The native operation failed." };
  return {
    name: nativeDiagnosticTail(error.name, secrets, 128),
    message: nativeDiagnosticTail(error.message, secrets, 8192),
    stack: nativeDiagnosticTail(error.stack ?? "", secrets, 16 * 1024),
    ...(error.cause ? { cause: errorDetail(error.cause, secrets, depth + 1) } : {}),
  };
}

const STAGES = {
  "control-open": "opening the native session control",
  inference: "preparing inference",
  runtime: "preparing the agent runtime",
  "runtime-copy-node": "copying the installed Node runtime",
  "runtime-copy-agent": "copying the installed agent runtime",
  "runtime-copy-python": "copying the installed Python runtime",
  broker: "starting the local inference broker",
  gateway: "starting the native gateway",
  sandbox: "creating the private sandbox",
  bootstrap: "connecting the sandbox to the local broker",
  dashboard: "opening the dashboard",
  browser: "requesting the agent browser interface",
  verification: "verifying the agent interface",
  agent: "observing the running agent session",
  cleanup: "closing the private session",
  "control-close": "closing the native session control",
} as const;

type NativeDiagnosticStage = keyof typeof STAGES;
// Existing qualification snapshots deliberately accept only these coarse phases.
const PRESENTATION_STAGES = {
  "control-open": "runtime",
  "runtime-copy-node": "runtime",
  "runtime-copy-agent": "runtime",
  "runtime-copy-python": "runtime",
  browser: "dashboard",
  verification: "dashboard",
  "control-close": "cleanup",
} as const;
const presentationStage = (stage: NativeDiagnosticStage) =>
  Object.hasOwn(PRESENTATION_STAGES, stage)
    ? PRESENTATION_STAGES[stage as keyof typeof PRESENTATION_STAGES]
    : stage;
type StageTiming = {
  stage: NativeDiagnosticStage;
  startMs: number;
  endMs: number;
  elapsedMs: number;
};
const MAX_STAGE_RECORDS = 128;

export function createNativeSessionDiagnostics(launcher: string, stateRoot: string, agent: string) {
  const secrets: string[] = [];
  const captures = new Map<string, ReturnType<typeof createNativeDiagnosticCapture>>();
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let stage: NativeDiagnosticStage = "inference";
  let stageStartMs = 0;
  const stages: StageTiming[] = [];
  let omittedStageRecords = 0;
  const finishStage = (endMs: number) => {
    const record = { stage, startMs: stageStartMs, endMs, elapsedMs: endMs - stageStartMs };
    if (stages.length < MAX_STAGE_RECORDS) stages.push(record);
    else omittedStageRecords++;
    stageStartMs = endMs;
  };
  let primary: unknown;
  let failed = false;
  let failureStage: NativeDiagnosticStage = stage;
  let failureElapsedMs: number | null = null;
  let saved: Promise<NativeFailurePresentation> | undefined;
  let document: string | undefined;
  const cleanup: string[] = [];
  const fail = (error: unknown) => {
    if (!failed && !saved) {
      failed = true;
      primary = error;
      failureStage = stage;
      failureElapsedMs = elapsed();
    }
  };
  const persist = async () => {
    if (saved) return await saved;
    // Freeze before diagnostic I/O. Failure callers save before the long notice
    // wait; success callers record native-control shutdown as its own phase.
    // These are elapsed host phases, not CPU/I/O attribution.
    const elapsedMs = elapsed();
    finishStage(elapsedMs);
    const presentation: NativeFailurePresentation = {
      stage: presentationStage(failed ? failureStage : stage),
      message: failed
        ? `NemoClaw failed while ${STAGES[failureStage]}.`
        : "NemoClaw session completed.",
    };
    document =
      JSON.stringify(
        {
          schemaVersion: 1,
          classification: failed ? "native-session-failure" : "native-session-success",
          agent,
          stage: presentationStage(failed ? failureStage : stage),
          recordedAt: new Date().toISOString(),
          failure: failed ? errorDetail(primary, secrets) : null,
          timing: {
            clock: "process.hrtime.bigint",
            unit: "milliseconds",
            scope: "host-session-through-owned-cleanup",
            elapsedMs,
            failureElapsedMs,
            stages,
            omittedStageRecords,
          },
          cleanupFailures: cleanup.map((label) => sanitizeNativeDiagnostic(label, secrets)),
          output: Object.fromEntries(
            [...captures].map(([name, capture]) => [
              sanitizeNativeDiagnostic(name, secrets),
              capture.finish(),
            ]),
          ),
        },
        null,
        2,
      ) + "\n";
    saved = (async () => {
      const root = path.join(stateRoot, `session-diagnostics-${randomBytes(10).toString("hex")}`);
      let owner: Awaited<ReturnType<typeof openNativeUiFileOwner>> | undefined;
      try {
        owner = await openNativeUiFileOwner(launcher, root);
        await owner.write("ready", document!);
        presentation.diagnosticPath = path.join(root, "ready");
      } catch {
        presentation.message += " The diagnostic file could not be saved.";
      } finally {
        try {
          await owner?.close();
        } catch {
          presentation.message += " The diagnostic file owner could not close cleanly.";
        }
      }
      if (presentation.diagnosticPath)
        presentation.message += ` Details: ${presentation.diagnosticPath}`;
      return presentation;
    })();
    return await saved;
  };
  return {
    secret(...values: string[]) {
      secrets.push(...values.filter(Boolean));
    },
    stage(value: NativeDiagnosticStage) {
      if (!Object.hasOwn(STAGES, value)) throw new Error("Invalid native diagnostic stage.");
      if (saved || value === stage) return;
      finishStage(elapsed());
      stage = value;
    },
    capture(channel: string, chunk: Buffer | string) {
      if (saved) return;
      if (!captures.has(channel)) {
        if (captures.size >= 6) return;
        captures.set(
          channel,
          createNativeDiagnosticCapture(() => secrets),
        );
      }
      captures.get(channel)!.write(chunk);
    },
    fail,
    hasFailure() {
      return failed;
    },
    primaryError() {
      return primary;
    },
    cleanupFailed(...labels: string[]) {
      cleanup.push(...labels);
    },
    // Kept for existing qualification consumers; success has its separate API.
    failureEvidence() {
      if (document === undefined) throw new Error("Native failure details have not been saved.");
      // Preserve the closed schema consumed by the installed qualifier. The
      // file at diagnosticPath and evidence() retain the full timing document.
      const legacy = JSON.parse(document);
      delete legacy.timing;
      return JSON.stringify(legacy, null, 2) + "\n";
    },
    evidence() {
      if (document === undefined) throw new Error("Native session details have not been saved.");
      return document;
    },
    async persist(error: unknown, cleanupFailures: string[] = []) {
      if (!saved) {
        fail(error);
        cleanup.push(...cleanupFailures);
      }
      return await persist();
    },
    async persistSuccess() {
      if (!saved && cleanup.length) fail(new Error("Native session cleanup failed."));
      return await persist();
    },
  };
}
