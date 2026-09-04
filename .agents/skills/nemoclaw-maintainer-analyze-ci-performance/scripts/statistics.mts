// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const round = (value: number): number => Math.round(value * 10) / 10;
export function quantile(values: number[], q: number): number {
  if (values.length === 0) throw new Error("quantile requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  return (
    sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (position - low)
  );
}
export function medianConfidenceInterval(values: number[]): number[] {
  if (values.length < 2) return [round(values[0] ?? 0), round(values[0] ?? 0)];
  let seed = 0x7372;
  const estimates: number[] = [];
  for (let iteration = 0; iteration < 3_000; iteration += 1) {
    const sample = values.map(() => {
      seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
      return values[Math.floor((seed / 4_294_967_296) * values.length)];
    });
    estimates.push(quantile(sample, 0.5));
  }
  return [round(quantile(estimates, 0.025)), round(quantile(estimates, 0.975))];
}
