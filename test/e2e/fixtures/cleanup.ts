// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

  constructor(redact: RedactFn = (text) => text) {
    this.redact = redact;
  }

  add(name: string, run: CleanupFn): void {
    if (!name.trim()) {
      throw new Error("cleanup name is required");
    }
    this.entries.push({ name, run });
  }

  trackSandbox(host: CleanupHost, name: string, options: ShellProbeRunOptions = {}): void {
    this.add(`destroy sandbox ${name}`, () => host.cleanupSandbox(name, options));
  }

  trackGateway(host: CleanupHost, name: string, options: ShellProbeRunOptions = {}): void {
    this.add(`remove gateway ${name}`, () => host.cleanupGatewayRegistration(name, options));
  }

  trackForward(host: CleanupHost, port: number, options: ShellProbeRunOptions = {}): void {
    this.add(`stop forward ${port}`, () => host.cleanupForward(port, options));
  }

  trackDisposable(name: string, dispose: CleanupFn): void {
    this.add(name, dispose);
  }

  async runAll(): Promise<CleanupResult> {
    const result: CleanupResult = { passed: [], failures: [] };
    for (const entry of [...this.entries].reverse()) {
      try {
        await entry.run();
        result.passed.push(this.redact(entry.name));
      } catch (error) {
        result.failures.push({
          name: this.redact(entry.name),
          message: this.redact(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    this.entries.length = 0;
    return result;
  }
}

export function assertCleanupPassed(result: CleanupResult): void {
  if (result.failures.length === 0) return;
  const details = result.failures
    .map((failure) => `${failure.name}: ${failure.message}`)
    .join("; ");
  throw new Error(`E2E cleanup failed: ${details}`);
}
