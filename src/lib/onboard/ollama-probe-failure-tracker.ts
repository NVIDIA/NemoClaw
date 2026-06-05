// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OllamaProbeFailureTrackerOptions = {
  excludeAfterFailures?: number;
  maxFailuresSameModel?: number;
  maxFailuresTotal?: number;
};

const DEFAULT_EXCLUDE_AFTER_FAILURES = 1;
const DEFAULT_MAX_FAILURES_SAME_MODEL = 2;
const DEFAULT_MAX_FAILURES_TOTAL = 3;

export class OllamaProbeFailureTracker {
  private readonly excludeAfterFailures: number;
  private readonly maxFailuresSameModel: number;
  private readonly maxFailuresTotal: number;
  private readonly failureCounts = new Map<string, number>();
  private readonly excludedModelTags = new Set<string>();
  private totalProbeFailures = 0;

  constructor(options: OllamaProbeFailureTrackerOptions = {}) {
    this.excludeAfterFailures = options.excludeAfterFailures ?? DEFAULT_EXCLUDE_AFTER_FAILURES;
    this.maxFailuresSameModel = options.maxFailuresSameModel ?? DEFAULT_MAX_FAILURES_SAME_MODEL;
    this.maxFailuresTotal = options.maxFailuresTotal ?? DEFAULT_MAX_FAILURES_TOTAL;
  }

  recordFailure(tag: string): boolean {
    const sameModelFailures = this.getFailureCount(tag) + 1;
    this.failureCounts.set(tag, sameModelFailures);
    this.totalProbeFailures += 1;
    if (sameModelFailures >= this.excludeAfterFailures) {
      this.excludedModelTags.add(tag);
    }
    return this.limitReached(tag);
  }

  shouldExclude(tag: string): boolean {
    return this.excludedModelTags.has(tag);
  }

  excludedModels(): ReadonlySet<string> {
    return this.excludedModelTags;
  }

  getTotalFailures(): number {
    return this.totalProbeFailures;
  }

  getFailureCount(tag: string): number {
    return this.failureCounts.get(tag) ?? 0;
  }

  limitReached(tag: string): boolean {
    return (
      this.getFailureCount(tag) >= this.maxFailuresSameModel ||
      this.totalProbeFailures >= this.maxFailuresTotal
    );
  }

  formatLimitMessage(tag: string): string {
    return (
      `  Ollama model selection has hit ${this.totalProbeFailures} probe failure(s) ` +
      `(model '${tag}' alone failed ${this.getFailureCount(tag)} time(s)). ` +
      "Returning to provider selection — pick a different provider, free GPU memory, " +
      "or set NEMOCLAW_MODEL to a model known to fit this host before retrying Ollama."
    );
  }

  reset(): void {
    this.failureCounts.clear();
    this.excludedModelTags.clear();
    this.totalProbeFailures = 0;
  }
}
