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

const STAGES: Record<string, string> = {
  inference: "preparing inference",
  runtime: "preparing the agent runtime",
  broker: "starting the local inference broker",
  gateway: "starting the native gateway",
  sandbox: "creating the private sandbox",
  bootstrap: "connecting the sandbox to the local broker",
  dashboard: "opening the dashboard",
  agent: "running the agent",
  cleanup: "closing the private session",
};

export function createNativeSessionDiagnostics(launcher: string, stateRoot: string, agent: string) {
  const secrets: string[] = [];
  const captures = new Map<string, ReturnType<typeof createNativeDiagnosticCapture>>();
  let stage = "inference";
  let primary: unknown;
  let failureStage = stage;
  let saved: Promise<NativeFailurePresentation> | undefined;
  let document: string | undefined;
  const cleanup: string[] = [];
  return {
    secret(...values: string[]) {
      secrets.push(...values.filter(Boolean));
    },
    stage(value: keyof typeof STAGES) {
      if (!Object.hasOwn(STAGES, value)) throw new Error("Invalid native diagnostic stage.");
      stage = value;
    },
    capture(channel: string, chunk: Buffer | string) {
      if (!captures.has(channel)) {
        if (captures.size >= 6) return;
        captures.set(
          channel,
          createNativeDiagnosticCapture(() => secrets),
        );
      }
      captures.get(channel)!.write(chunk);
    },
    fail(error: unknown) {
      if (primary === undefined) {
        primary = error;
        failureStage = stage;
      }
    },
    cleanupFailed(...labels: string[]) {
      cleanup.push(...labels);
    },
    failureEvidence() {
      if (document === undefined) throw new Error("Native failure details have not been saved.");
      return document;
    },
    async persist(error: unknown, cleanupFailures: string[] = []) {
      if (saved) return await saved;
      this.fail(error);
      saved = (async () => {
        const presentation: NativeFailurePresentation = {
          stage: failureStage,
          message: `NemoClaw failed while ${STAGES[failureStage]}.`,
        };
        const root = path.join(stateRoot, `session-diagnostics-${randomBytes(10).toString("hex")}`);
        let owner: Awaited<ReturnType<typeof openNativeUiFileOwner>> | undefined;
        document =
          JSON.stringify(
            {
              schemaVersion: 1,
              classification: "native-session-failure",
              agent,
              stage: failureStage,
              recordedAt: new Date().toISOString(),
              failure: errorDetail(primary, secrets),
              cleanupFailures: [...cleanup, ...cleanupFailures].map((label) =>
                sanitizeNativeDiagnostic(label, secrets),
              ),
              output: Object.fromEntries(
                [...captures].map(([name, capture]) => [name, capture.finish()]),
              ),
            },
            null,
            2,
          ) + "\n";
        try {
          owner = await openNativeUiFileOwner(launcher, root);
          await owner.write("ready", document);
          presentation.diagnosticPath = path.join(root, "ready");
        } catch {
          presentation.message += " The diagnostic file could not be saved.";
        } finally {
          await owner?.close().catch(() => {});
        }
        if (presentation.diagnosticPath)
          presentation.message += ` Details: ${presentation.diagnosticPath}`;
        return presentation;
      })();
      return await saved;
    },
  };
}
