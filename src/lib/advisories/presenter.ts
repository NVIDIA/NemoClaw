// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Advisory } from "./types";

/** Supported pure rendering targets. */
export type AdvisoryFormat = "console" | "json";

/** Error raised when a caller attempts to continue past blocking advisories. */
export class BlockingAdvisoryError extends Error {
  readonly advisories: readonly Advisory[];

  constructor(advisories: readonly Advisory[]) {
    super(`Blocked by ${advisories.length} advisory finding${advisories.length === 1 ? "" : "s"}.`);
    this.name = "BlockingAdvisoryError";
    this.advisories = advisories;
  }
}

function formatConsoleAdvisory(advisory: Advisory): string {
  const lines = [
    `[${advisory.severity.toUpperCase()}] ${advisory.title} (${advisory.id})`,
    `  ${advisory.reason}`,
  ];
  for (const command of advisory.commands ?? []) lines.push(`  Run: ${command}`);
  if (advisory.docsUrl) lines.push(`  More: ${advisory.docsUrl}`);
  return lines.join("\n");
}

/** Formats advisories without writing to stdout, stderr, or process state. */
export function formatAdvisories(advisories: readonly Advisory[], format: AdvisoryFormat): string {
  if (format === "json") return JSON.stringify(advisories, null, 2);
  return advisories.map(formatConsoleAdvisory).join("\n\n");
}

/** Returns the findings that prohibit the caller from continuing. */
export function blockingAdvisories(advisories: readonly Advisory[]): readonly Advisory[] {
  return advisories.filter(
    (advisory) => advisory.severity === "fatal" || advisory.severity === "blocking",
  );
}

/** Throws one structured error when any fatal or blocking finding is present. */
export function assertNoBlocking(advisories: readonly Advisory[]): void {
  const blocking = blockingAdvisories(advisories);
  if (blocking.length > 0) throw new BlockingAdvisoryError(blocking);
}
