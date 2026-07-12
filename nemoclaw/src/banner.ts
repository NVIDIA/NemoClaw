// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
 * Render content lines inside a dynamically-sized Unicode box.
 *
 * The renderer expands to fit long content when the terminal is wide enough and
 * otherwise truncates content while preserving a two-space safety gap before the
 * closing border. That gap prevents terminal link detectors from treating the
 * box-drawing border as part of long URLs or endpoints.
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
