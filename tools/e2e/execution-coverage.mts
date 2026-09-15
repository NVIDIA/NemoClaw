// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_AGENT_RUNTIMES = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
  "pi",
  "none",
  "openclaw + hermes",
  "openclaw + langchain-deepagents-code",
  "openclaw + hermes + langchain-deepagents-code",
  "unresolved",
] as const;

export type E2eAgentRuntime = (typeof E2E_AGENT_RUNTIMES)[number];

export interface E2eExecutionMetadata {
  agentRuntime: E2eAgentRuntime;
  observableOutcome: string;
  environmentOrInferenceEndpoint: string;
  unresolvedReason: string;
}

export const E2E_EXECUTION_SOURCES = [
  "catalogue",
  "typed-registry",
  "shared-e2e",
  "retained-workflow",
  "staging",
] as const;

export type E2eExecutionSource = (typeof E2E_EXECUTION_SOURCES)[number];

export interface E2eExecutionRow extends E2eExecutionMetadata {
  id: string;
  variant: string;
  source: E2eExecutionSource;
}

const SELECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COVERAGE_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,'+()/:;_-]{0,199}$/u;

export function validateE2eExecutionMetadata(
  metadata: E2eExecutionMetadata,
  context: string,
): E2eExecutionMetadata {
  if (!E2E_AGENT_RUNTIMES.includes(metadata.agentRuntime)) {
    throw new Error(`${context} has an invalid agent runtime`);
  }
  for (const [field, value] of [
    ["observable outcome", metadata.observableOutcome],
    ["environment or inference endpoint", metadata.environmentOrInferenceEndpoint],
  ] as const) {
    if (!COVERAGE_TEXT_PATTERN.test(value)) {
      throw new Error(`${context} has an invalid ${field}`);
    }
  }
  const unresolved =
    metadata.agentRuntime === "unresolved" ||
    metadata.observableOutcome === "unresolved" ||
    metadata.environmentOrInferenceEndpoint === "unresolved";
  if (unresolved !== (metadata.unresolvedReason !== "")) {
    throw new Error(
      `${context} must declare an unresolved reason exactly when a coverage field is unresolved`,
    );
  }
  if (metadata.unresolvedReason !== "" && !COVERAGE_TEXT_PATTERN.test(metadata.unresolvedReason)) {
    throw new Error(`${context} has an invalid unresolved reason`);
  }
  return metadata;
}

export function validateE2eExecutionRows(
  rows: readonly E2eExecutionRow[],
): readonly E2eExecutionRow[] {
  const keys = new Set<string>();
  const coverageEvidence = new Map<string, string>();
  for (const row of rows) {
    if (!SELECTOR_ID_PATTERN.test(row.id)) {
      throw new Error(`E2E execution coverage contains an invalid ID: ${row.id}`);
    }
    if (row.variant !== "" && !SELECTOR_ID_PATTERN.test(row.variant)) {
      throw new Error(`E2E execution coverage ${row.id} has an invalid variant`);
    }
    if (!E2E_EXECUTION_SOURCES.includes(row.source)) {
      throw new Error(`E2E execution coverage ${row.id} has an invalid source`);
    }
    validateE2eExecutionMetadata(row, `E2E execution coverage ${row.id}`);
    const key = `${row.source}:${row.id}:${row.variant}`;
    if (keys.has(key)) {
      throw new Error(`E2E execution coverage contains a duplicate row: ${key}`);
    }
    keys.add(key);
    if (
      row.agentRuntime !== "unresolved" &&
      row.observableOutcome !== "unresolved" &&
      row.environmentOrInferenceEndpoint !== "unresolved"
    ) {
      const evidenceKey = [
        row.agentRuntime,
        row.observableOutcome,
        row.environmentOrInferenceEndpoint,
        row.variant,
      ].join("\u0000");
      const previous = coverageEvidence.get(evidenceKey);
      if (previous) {
        throw new Error(
          `E2E execution coverage duplicates evidence between ${previous} and ${e2eExecutionLabel(row)}`,
        );
      }
      coverageEvidence.set(evidenceKey, e2eExecutionLabel(row));
    }
  }
  return rows;
}

export function e2eExecutionLabel(row: E2eExecutionRow): string {
  return row.variant === "" ? row.id : `${row.id} / ${row.variant}`;
}

export function e2eExecutionTitle(metadata: E2eExecutionMetadata): string {
  return `${metadata.observableOutcome} [${metadata.agentRuntime}; ${metadata.environmentOrInferenceEndpoint}]`;
}
