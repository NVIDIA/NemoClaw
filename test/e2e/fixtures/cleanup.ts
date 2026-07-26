// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TestProgress } from "./progress.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

export interface CleanupFailure {
  name: string;
  message: string;
}

export interface CleanupResult {
  passed: string[];
  failures: CleanupFailure[];
}

type CleanupFn = () => Promise<void> | void;
type RedactFn = (text: string) => string;
type CleanupProgress = Pick<TestProgress, "activity" | "event">;
const MAX_PROGRESS_CLEANUP_NAME_LENGTH = 120;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 10 * 60_000;

export interface CleanupRegistryOptions {
  testSignal?: AbortSignal;
  /** Shared deadline for signal-aware cleanup commands; callbacks are still awaited in order. */
  timeoutMs?: number;
}

export interface CleanupHost {
  cleanupSandbox(name: string, options?: ShellProbeRunOptions): Promise<void>;
  cleanupGatewayRegistration(name: string, options?: ShellProbeRunOptions): Promise<void>;
  cleanupForward(port: number, options?: ShellProbeRunOptions): Promise<void>;
}

interface CleanupEntry {
  name: string;
  run: CleanupFn;
}

export class CleanupRegistry {
  private readonly entries: CleanupEntry[] = [];
  private readonly redact: RedactFn;
  private readonly progress?: CleanupProgress;
  private readonly testSignal: AbortSignal;
  private readonly timeoutMs: number;
  private cleanupController?: AbortController;

  constructor(
    redact: RedactFn = (text) => text,
    progress?: CleanupProgress,
    options: CleanupRegistryOptions = {},
  ) {
    this.redact = redact;
    this.progress = progress;
    this.testSignal = options.testSignal ?? new AbortController().signal;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("cleanup timeoutMs must be a positive safe integer");
    }
  }

  currentSignal(): AbortSignal {
    return this.cleanupController?.signal ?? this.testSignal;
  }

  private safeRedact(text: string): string {
    try {
      return this.redact(text);
    } catch {
      return "[cleanup metadata unavailable]";
    }
  }

  private progressName(name: string): string {
    const normalized = this.safeRedact(name)
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!normalized) return "unnamed cleanup entry";
    if (normalized.length <= MAX_PROGRESS_CLEANUP_NAME_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_PROGRESS_CLEANUP_NAME_LENGTH - 12).trimEnd()} [truncated]`;
  }

  private startProgress(name: string): () => void {
    const redactedName = this.progressName(name);
    let finishActivity: (() => void) | undefined;
    try {
      finishActivity = this.progress?.activity(`cleanup: ${redactedName}`);
      this.progress?.event(`cleanup started: ${redactedName}`);
    } catch {
      // Cleanup diagnostics must never prevent resource release.
    }
    return () => {
      try {
        finishActivity?.();
      } catch {
        // Cleanup diagnostics must never prevent resource release.
      }
    };
  }

  private reportProgress(outcome: "failed" | "passed", name: string): void {
    try {
      this.progress?.event(`cleanup ${outcome}: ${this.progressName(name)}`);
    } catch {
      // Cleanup diagnostics must never change the cleanup result.
    }
  }

  add(name: string, run: CleanupFn): void {
    if (!name.trim()) {
      throw new Error("cleanup name is required");
    }
    this.entries.push({ name, run });
  }

  trackSandbox(
    host: Pick<CleanupHost, "cleanupSandbox">,
    name: string,
    options: ShellProbeRunOptions = {},
  ): void {
    this.add(`destroy sandbox ${name}`, () => host.cleanupSandbox(name, options));
  }

  trackGateway(
    host: Pick<CleanupHost, "cleanupGatewayRegistration">,
    name: string,
    options: ShellProbeRunOptions = {},
  ): void {
    this.add(`remove gateway ${name}`, () => host.cleanupGatewayRegistration(name, options));
  }

  trackForward(
    host: Pick<CleanupHost, "cleanupForward">,
    port: number,
    options: ShellProbeRunOptions = {},
  ): void {
    this.add(`stop forward ${port}`, () => host.cleanupForward(port, options));
  }

  trackDisposable(name: string, dispose: CleanupFn): void {
    this.add(name, dispose);
  }

  async runAll(): Promise<CleanupResult> {
    if (this.cleanupController) {
      throw new Error("cleanup is already running");
    }

    const cleanupController = new AbortController();
    this.cleanupController = cleanupController;
    const deadline = setTimeout(() => cleanupController.abort(), this.timeoutMs);
    deadline.unref();
    const result: CleanupResult = { passed: [], failures: [] };
    try {
      for (const entry of [...this.entries].reverse()) {
        const finishProgress = this.startProgress(entry.name);
        try {
          await entry.run();
          result.passed.push(this.safeRedact(entry.name));
          this.reportProgress("passed", entry.name);
        } catch (error) {
          result.failures.push({
            name: this.safeRedact(entry.name),
            message: this.safeRedact(error instanceof Error ? error.message : String(error)),
          });
          this.reportProgress("failed", entry.name);
        } finally {
          finishProgress();
        }
      }
      return result;
    } finally {
      clearTimeout(deadline);
      cleanupController.abort();
      this.cleanupController = undefined;
      this.entries.length = 0;
    }
  }
}

export function assertCleanupPassed(result: CleanupResult): void {
  if (result.failures.length === 0) return;
  const details = result.failures
    .map((failure) => `${failure.name}: ${failure.message}`)
    .join("; ");
  throw new Error(`E2E cleanup failed: ${details}`);
}
