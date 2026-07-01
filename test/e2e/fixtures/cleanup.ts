// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
