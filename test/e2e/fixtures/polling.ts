// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface PollAttempt<T> {
  attempt: number;
  artifactName: string;
  value: T;
}

export interface PollOptions<T> {
  artifactPrefix: string;
  probe: (attempt: number, artifactName: string) => Promise<T>;
  accept: (value: T, attempt: number) => boolean;
  attempts?: number;
  deadlineMs?: number;
  delayMs?: number | ((attempt: number) => number);
  signal?: AbortSignal;
  terminal?: (value: T, attempt: number) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type PollingFailureReason = "aborted" | "terminal" | "exhausted";

export class PollingError<T> extends Error {
  constructor(
    message: string,
    readonly lastAttempt?: PollAttempt<T>,
    readonly reason: PollingFailureReason = "exhausted",
  ) {
    super(message);
  }
}

export function pollingArtifactName(prefix: string, attempt: number): string {
  return `${prefix}-attempt-${String(attempt).padStart(2, "0")}`;
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<PollAttempt<T>> {
  if (options.attempts === undefined && options.deadlineMs === undefined) {
    throw new Error("pollUntil requires attempts or deadlineMs");
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = options.deadlineMs === undefined ? undefined : now() + options.deadlineMs;
  let lastAttempt: PollAttempt<T> | undefined;
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) throw new PollingError("polling aborted", lastAttempt, "aborted");
    if (options.attempts !== undefined && attempt > options.attempts) break;
    if (deadline !== undefined && attempt > 1 && now() >= deadline) break;
    const artifactName = pollingArtifactName(options.artifactPrefix, attempt);
    const value = await options.probe(attempt, artifactName);
    lastAttempt = { attempt, artifactName, value };
    const terminal = options.terminal?.(value, attempt);
    if (terminal) throw new PollingError(terminal, lastAttempt, "terminal");
    if (options.accept(value, attempt)) return lastAttempt;
    const delay =
      typeof options.delayMs === "function" ? options.delayMs(attempt) : (options.delayMs ?? 0);
    if (delay > 0) await sleep(delay);
  }
  throw new PollingError("polling exhausted its configured bound", lastAttempt);
}
