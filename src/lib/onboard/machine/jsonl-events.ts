// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { withStdoutRedirectedToStderr } from "../../cli/stdout-guard";
import type { JsonObject } from "../../core/json-types";
import { redactForLog, redactSensitiveText } from "../../security/redact";
import {
  addOnboardMachineEventListener,
  type OnboardMachineEvent,
  sanitizeOnboardMachineEventMetadata,
} from "./events";

export const ONBOARD_JSONL_SCHEMA_VERSION = 1 as const;

const MAX_JAVASCRIPT_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAX_CREDENTIAL_ENV_NAME_LENGTH = 128;
const CREDENTIAL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Session version 1 used an eight-character base36 suffix before switching to
// `randomUUID()`. Both remain resumable persisted-session formats.
const ONBOARD_SESSION_ID_PATTERN =
  /^((?:0|[1-9]\d{0,15}))-(?:[a-z0-9]{8}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export interface OnboardJsonlEvent {
  schemaVersion: typeof ONBOARD_JSONL_SCHEMA_VERSION;
  session: string | null;
  type: OnboardMachineEvent["type"];
  timestamp: string;
  payload: JsonObject;
}

type WriteJsonlLine = (line: string) => boolean | void;

function canonicalPersistedSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ONBOARD_SESSION_ID_PATTERN.exec(value);
  if (!match) return null;

  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || timestamp > MAX_JAVASCRIPT_DATE_MILLISECONDS) {
    return null;
  }
  return value;
}

function canonicalCredentialEnvName(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CREDENTIAL_ENV_NAME_LENGTH ||
    !CREDENTIAL_ENV_NAME_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function createStdoutJsonlTransport(disable: () => void): {
  close: () => void;
  writeLine: WriteJsonlLine;
} {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  let closeRequested = false;
  let pendingWrites = 0;
  const pendingWriteErrors = new Set<Error>();
  const removeErrorHandlerWhenIdle = () => {
    if (closeRequested && pendingWrites === 0 && pendingWriteErrors.size === 0) {
      stdout.off("error", onError);
    }
  };
  const onError = (error: Error) => {
    pendingWriteErrors.delete(error);
    disable();
    removeErrorHandlerWhenIdle();
  };
  stdout.on("error", onError);
  return {
    close: () => {
      closeRequested = true;
      removeErrorHandlerWhenIdle();
    },
    writeLine: (line) => {
      pendingWrites += 1;
      try {
        const accepted = write(line, (error) => {
          pendingWrites -= 1;
          if (error) {
            // Node reports an asynchronous stream write failure to this
            // callback before emitting the paired `error` event. Keep the
            // listener installed until that event is consumed.
            pendingWriteErrors.add(error);
            disable();
          }
          removeErrorHandlerWhenIdle();
        });
        if (!accepted) disable();
        return accepted;
      } catch {
        pendingWrites -= 1;
        disable();
        removeErrorHandlerWhenIdle();
        return false;
      }
    },
  };
}

export function toOnboardJsonlEvent(event: OnboardMachineEvent): OnboardJsonlEvent {
  const context = sanitizeOnboardMachineEventMetadata({ ...event.context });
  if (Object.prototype.hasOwnProperty.call(event.context, "credentialEnv")) {
    context.credentialEnv = canonicalCredentialEnvName(event.context.credentialEnv);
  }
  const payload: JsonObject = {
    state: event.state,
    step: event.step,
    context,
    error: redactSensitiveText(event.error),
    metadata: redactForLog(sanitizeOnboardMachineEventMetadata(event.metadata)) as JsonObject,
  };

  return {
    schemaVersion: ONBOARD_JSONL_SCHEMA_VERSION,
    session: canonicalPersistedSessionId(event.sessionId),
    type: event.type,
    timestamp: event.occurredAt,
    payload,
  };
}

export function observeOnboardJsonlEvents(requestedWriteLine?: WriteJsonlLine): () => void {
  let active = true;
  let closeTransport: () => void = () => {};
  let removeListener: () => void = () => {};
  const disable = () => {
    if (!active) return;
    active = false;
    removeListener();
    closeTransport();
  };
  const transport = requestedWriteLine
    ? { close: closeTransport, writeLine: requestedWriteLine }
    : createStdoutJsonlTransport(disable);
  closeTransport = transport.close;
  removeListener = addOnboardMachineEventListener((event) => {
    if (!active) return;
    try {
      if (transport.writeLine(`${JSON.stringify(toOnboardJsonlEvent(event))}\n`) === false) {
        disable();
      }
    } catch {
      // Observation is best-effort. Disable the failed transport without
      // changing canonical onboarding state or control flow.
      disable();
    }
  });

  return disable;
}

export async function withOnboardJsonlEventStream<T>(
  runOnboard: () => Promise<T>,
  writeLine?: WriteJsonlLine,
): Promise<T> {
  const stopObserving = observeOnboardJsonlEvents(writeLine);
  try {
    return await withStdoutRedirectedToStderr(runOnboard);
  } finally {
    stopObserving();
  }
}
