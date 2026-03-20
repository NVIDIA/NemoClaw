// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight metrics implementation for NemoClaw.
 *
 * Provides counters and histograms for request tracking and latency observation.
 * Enabled only when NEMOCLAW_METRICS_ENABLED=true.
 */

export interface MetricValue {
  name: string;
  help: string;
  type: "counter" | "histogram";
  labels: Record<string, string>;
  value: number;
  timestamp: number;
}

export interface HistogramValue extends MetricValue {
  type: "histogram";
  buckets: Record<number, number>;
  sum: number;
  count: number;
}

class MetricsRegistry {
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, { sum: number; count: number; buckets: Record<number, number> }> =
    new Map();

  // Standard buckets for latency (seconds)
  private defaultBuckets = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60];

  public isEnabled(): boolean {
    return process.env.NEMOCLAW_METRICS_ENABLED === "true";
  }

  public incrementCounter(name: string, labels: Record<string, string> = {}): void {
    if (!this.isEnabled()) return;
    const key = this.formatKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  public observeHistogram(
    name: string,
    value: number,
    labels: Record<string, string> = {},
    buckets = this.defaultBuckets,
  ): void {
    if (!this.isEnabled()) return;
    const key = this.formatKey(name, labels);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = { sum: 0, count: 0, buckets: {} };
      buckets.forEach((b) => (hist!.buckets[b] = 0));
      this.histograms.set(key, hist);
    }

    hist.sum += value;
    hist.count += 1;
    buckets.forEach((b) => {
      if (value <= b) {
        hist!.buckets[b] = (hist!.buckets[b] || 0) + 1;
      }
    });
  }

  public getPrometheusMetrics(): string {
    let output = "";

    // Export counters
    for (const [key, value] of this.counters.entries()) {
      const [name, labelStr] = this.parseKey(key);
      output += `# HELP ${name} Total count of ${name}\n`;
      output += `# TYPE ${name} counter\n`;
      output += `${name}${labelStr} ${value}\n\n`;
    }

    // Export histograms
    for (const [key, hist] of this.histograms.entries()) {
      const [name, labelStr] = this.parseKey(key);
      output += `# HELP ${name} Latency histogram for ${name}\n`;
      output += `# TYPE ${name} histogram\n`;

      const sortedBuckets = Object.keys(hist.buckets)
        .map(Number)
        .sort((a, b) => a - b);
      const labelsBase = labelStr.length > 2 ? labelStr.slice(1, -1) + "," : "";

      sortedBuckets.forEach((b) => {
        output += `${name}_bucket{${labelsBase}le="${b === Infinity ? "+Inf" : b}"} ${hist.buckets[b]}\n`;
      });
      output += `${name}_bucket{${labelsBase}le="+Inf"} ${hist.count}\n`;
      output += `${name}_sum${labelStr} ${hist.sum}\n`;
      output += `${name}_count${labelStr} ${hist.count}\n\n`;
    }

    return output;
  }

  private formatKey(name: string, labels: Record<string, string>): string {
    const labelPairs = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    return labelPairs ? `${name}{${labelPairs}}` : name;
  }

  private parseKey(key: string): [string, string] {
    const braceIdx = key.indexOf("{");
    if (braceIdx === -1) return [key, ""];
    return [key.slice(0, braceIdx), key.slice(braceIdx)];
  }
}

export const metrics = new MetricsRegistry();

/**
 * Helper to measure execution time of a promise.
 */
export async function observeLatency<T>(
  name: string,
  labels: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!metrics.isEnabled()) return fn();

  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const end = process.hrtime.bigint();
    const durationSec = Number(end - start) / 1e9;

    metrics.observeHistogram(`${name}_latency_seconds`, durationSec, {
      ...labels,
      status: "success",
    });
    metrics.incrementCounter(`${name}_total`, { ...labels, status: "success" });

    return result;
  } catch (error) {
    const end = process.hrtime.bigint();
    const durationSec = Number(end - start) / 1e9;

    metrics.observeHistogram(`${name}_latency_seconds`, durationSec, {
      ...labels,
      status: "error",
    });
    metrics.incrementCounter(`${name}_total`, { ...labels, status: "error" });

    throw error;
  }
}
