// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type MetricLabels = Record<string, string | number | boolean | null | undefined>;
export type MetricType = "counter" | "histogram";

export interface MetricMetadata {
  help: string;
  type: MetricType;
}

interface CounterSeries {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSeries {
  labels: Record<string, string>;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

export function isMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEMOCLAW_METRICS_ENABLED === "true";
}

function assertMetricName(name: string): void {
  if (!METRIC_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Prometheus metric name: ${name}`);
  }
}

function assertLabelName(name: string): void {
  if (!LABEL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Prometheus label name: ${name}`);
  }
}

function normalizeLabels(labels: MetricLabels): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || value === null) {
      continue;
    }
    assertLabelName(key);
    normalized[key] = String(value);
  }
  return normalized;
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const labelKey = Object.entries(labels)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",");
  return `${name}{${labelKey}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelpText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const body = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",");
  return `{${body}}`;
}

function formatLabelsWithExtra(
  labels: Record<string, string>,
  extra: Record<string, string>,
): string {
  return formatLabels({ ...labels, ...extra });
}

function validateHistogramValue(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Histogram values must be finite non-negative numbers, got ${String(value)}`);
  }
}

function normalizeBuckets(buckets: readonly number[]): number[] {
  const unique = [...new Set(buckets)];
  unique.forEach(validateHistogramValue);
  return unique.sort((a, b) => a - b);
}

function bucketsMatch(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((bucket, index) => bucket === right[index]);
}

export class MetricsRegistry {
  private readonly enabled: () => boolean;
  private readonly metadata = new Map<string, MetricMetadata>();
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();

  public constructor(enabled: () => boolean = () => isMetricsEnabled()) {
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled();
  }

  public reset(): void {
    this.metadata.clear();
    this.counters.clear();
    this.histograms.clear();
  }

  public incrementCounter(
    name: string,
    labels: MetricLabels = {},
    amount = 1,
    help = `Total count of ${name}`,
  ): void {
    if (!this.isEnabled()) {
      return;
    }
    assertMetricName(name);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(
        `Counter increments must be finite non-negative numbers, got ${String(amount)}`,
      );
    }

    this.registerMetadata(name, { help, type: "counter" });
    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    const current = this.counters.get(key);
    if (current) {
      current.value += amount;
    } else {
      this.counters.set(key, { labels: normalized, value: amount });
    }
  }

  public observeHistogram(
    name: string,
    value: number,
    labels: MetricLabels = {},
    buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS,
    help = `Duration histogram for ${name}`,
  ): void {
    if (!this.isEnabled()) {
      return;
    }
    assertMetricName(name);
    validateHistogramValue(value);

    const normalizedBuckets = normalizeBuckets(buckets);
    this.registerMetadata(name, { help, type: "histogram" });
    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    let series = this.histograms.get(key);
    if (!series) {
      series = {
        labels: normalized,
        buckets: normalizedBuckets,
        counts: normalizedBuckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, series);
    } else if (!bucketsMatch(series.buckets, normalizedBuckets)) {
      throw new Error(`Histogram ${name} already uses a different bucket configuration`);
    }

    series.sum += value;
    series.count += 1;
    series.buckets.forEach((bucket, index) => {
      if (value <= bucket) {
        series.counts[index] += 1;
      }
    });
  }

  public async observeOperation<T>(
    name: string,
    labels: MetricLabels,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled()) {
      return operation();
    }

    const startedAt = process.hrtime.bigint();
    try {
      const result = await operation();
      this.recordOperation(name, startedAt, { ...labels, status: "success" });
      return result;
    } catch (error) {
      this.recordOperation(name, startedAt, { ...labels, status: "error" });
      throw error;
    }
  }

  public renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, metadata] of [...this.metadata.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`# HELP ${name} ${escapeHelpText(metadata.help)}`);
      lines.push(`# TYPE ${name} ${metadata.type}`);
      if (metadata.type === "counter") {
        this.renderCounter(name, lines);
      } else {
        this.renderHistogram(name, lines);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  private registerMetadata(name: string, metadata: MetricMetadata): void {
    const existing = this.metadata.get(name);
    if (existing && existing.type !== metadata.type) {
      throw new Error(`Metric ${name} is already registered as ${existing.type}`);
    }
    if (!existing) {
      this.metadata.set(name, metadata);
    }
  }

  private recordOperation(name: string, startedAt: bigint, labels: MetricLabels): void {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    this.incrementCounter(`${name}_total`, labels);
    this.observeHistogram(`${name}_duration_seconds`, durationSeconds, labels);
  }

  private renderCounter(name: string, lines: string[]): void {
    const series = [...this.counters.entries()]
      .filter(([key]) => key.startsWith(`${name}{`))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [, counter] of series) {
      lines.push(`${name}${formatLabels(counter.labels)} ${String(counter.value)}`);
    }
  }

  private renderHistogram(name: string, lines: string[]): void {
    const series = [...this.histograms.entries()]
      .filter(([key]) => key.startsWith(`${name}{`))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [, histogram] of series) {
      histogram.buckets.forEach((bucket, index) => {
        lines.push(
          `${name}_bucket${formatLabelsWithExtra(histogram.labels, { le: String(bucket) })} ${String(histogram.counts[index])}`,
        );
      });
      lines.push(
        `${name}_bucket${formatLabelsWithExtra(histogram.labels, { le: "+Inf" })} ${String(histogram.count)}`,
      );
      lines.push(`${name}_sum${formatLabels(histogram.labels)} ${String(histogram.sum)}`);
      lines.push(`${name}_count${formatLabels(histogram.labels)} ${String(histogram.count)}`);
    }
  }
}

export const metrics = new MetricsRegistry();
