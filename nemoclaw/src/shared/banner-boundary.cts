// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: This is the one implementation of the terminal banner box
// renderer. It is compiled to generated .cjs/.d.cts files by build:cli before
// both the plugin and root CLI are built.
// consumers: The root CLI re-exports renderBox through src/lib/cli/banner.ts
// for src/lib/tunnel/services.ts; the ESM plugin re-exports it through
// nemoclaw/src/banner.ts for nemoclaw/src/index.ts. Keeping one renderer
// prevents the drift already observed between the two former copies.
// sourceBoundary: Callers own content safety; this renderer only sizes and
// truncates the box. It does not escape terminal control sequences.
// regressionTest: nemoclaw/src/shared/banner-boundary.test.ts covers the
// renderer directly; test/package-contract/banner-boundary.test.ts proves both
// built package wrappers resolve to this one generated function.
// removalCondition: remove only when a single package renders the banner.

/** A banner content row; null renders as a blank separator row. */
export type BannerLine = string | null;

/** Options for rendering a Unicode terminal banner box. */
export interface RenderBoxOptions {
  /** Minimum inner box width, excluding borders. */
  minInner?: number;
  /** Terminal width to respect. Defaults to process.stdout.columns, then 100. */
  columns?: number;
}

/**
 * Render content lines inside a dynamically-sized Unicode box. Long content
 * expands the box when the terminal is wide enough, otherwise it is truncated
 * with a two-space safety gap before the closing border so terminal link
 * detectors do not treat the border as part of a long URL or endpoint.
 */
export function renderBox(
  lines: BannerLine[],
  { minInner = 53, columns }: RenderBoxOptions = {},
): string[] {
  const detectedColumns = columns ?? process.stdout.columns;
  const terminalColumns =
    Number.isFinite(detectedColumns) && detectedColumns > 0 ? detectedColumns : 100;
  const maxInner = Math.max(0, Math.floor(terminalColumns) - 4);
  const contentInner = lines.reduce<number>(
    (max, line) => (line === null ? max : Math.max(max, line.length + 2)),
    minInner,
  );
  const inner = Math.min(maxInner, Math.max(0, contentInner));

  const pad = (line: string): string => {
    if (line.length > inner) {
      if (inner <= 2) return " ".repeat(inner);
      return `${line.slice(0, inner - 2)}  `;
    }
    return line + " ".repeat(inner - line.length);
  };

  const hBar = "─".repeat(inner);
  const blank = " ".repeat(inner);

  return [
    `  ┌${hBar}┐`,
    ...lines.map((line) => (line === null ? `  │${blank}│` : `  │${pad(line)}│`)),
    `  └${hBar}┘`,
  ];
}
