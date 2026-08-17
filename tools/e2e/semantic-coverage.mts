// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_AGENT_RUNTIMES = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
  "none",
  "openclaw + hermes",
  "openclaw + langchain-deepagents-code",
  "openclaw + hermes + langchain-deepagents-code",
  "unresolved",
] as const;

export type E2eAgentRuntime = (typeof E2E_AGENT_RUNTIMES)[number];

export interface E2eSemanticMetadata {
  agentRuntime: E2eAgentRuntime;
  observableOutcome: string;
  environmentOrInferenceEndpoint: string;
  unresolvedReason: string;
}

export const E2E_SEMANTIC_EXECUTION_SOURCES = [
  "catalogue",
  "typed-registry",
  "shared-e2e",
  "retained-workflow",
  "staging",
] as const;

export type E2eSemanticExecutionSource = (typeof E2E_SEMANTIC_EXECUTION_SOURCES)[number];

export interface E2eSemanticExecutionRow extends E2eSemanticMetadata {
  id: string;
  variant: string;
  source: E2eSemanticExecutionSource;
}

const SELECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMANTIC_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,+()/:;_-]{0,199}$/u;

export function validateE2eSemanticMetadata(
  metadata: E2eSemanticMetadata,
  context: string,
): E2eSemanticMetadata {
  if (!E2E_AGENT_RUNTIMES.includes(metadata.agentRuntime)) {
    throw new Error(`${context} has an invalid agent runtime`);
  }
  for (const [field, value] of [
    ["observable outcome", metadata.observableOutcome],
    ["environment or inference endpoint", metadata.environmentOrInferenceEndpoint],
  ] as const) {
    if (!SEMANTIC_TEXT_PATTERN.test(value)) {
      throw new Error(`${context} has an invalid ${field}`);
    }
  }
  const unresolved =
    metadata.agentRuntime === "unresolved" ||
    metadata.observableOutcome === "unresolved" ||
    metadata.environmentOrInferenceEndpoint === "unresolved";
  if (unresolved !== (metadata.unresolvedReason !== "")) {
    throw new Error(
      `${context} must declare an unresolved reason exactly when a semantic field is unresolved`,
    );
  }
  if (metadata.unresolvedReason !== "" && !SEMANTIC_TEXT_PATTERN.test(metadata.unresolvedReason)) {
    throw new Error(`${context} has an invalid unresolved reason`);
  }
  return metadata;
}

export function validateE2eSemanticExecutionRows(
  rows: readonly E2eSemanticExecutionRow[],
): readonly E2eSemanticExecutionRow[] {
  const keys = new Set<string>();
  const semanticEvidence = new Map<string, string>();
  for (const row of rows) {
    if (!SELECTOR_ID_PATTERN.test(row.id)) {
      throw new Error(`E2E semantic coverage contains an invalid ID: ${row.id}`);
    }
    if (row.variant !== "" && !SELECTOR_ID_PATTERN.test(row.variant)) {
      throw new Error(`E2E semantic coverage ${row.id} has an invalid variant`);
    }
    if (!E2E_SEMANTIC_EXECUTION_SOURCES.includes(row.source)) {
      throw new Error(`E2E semantic coverage ${row.id} has an invalid source`);
    }
    validateE2eSemanticMetadata(row, `E2E semantic coverage ${row.id}`);
    const key = `${row.source}:${row.id}:${row.variant}`;
    if (keys.has(key)) {
      throw new Error(`E2E semantic coverage contains a duplicate row: ${key}`);
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
      ].join("\u0000");
      const previous = semanticEvidence.get(evidenceKey);
      if (previous) {
        throw new Error(
          `E2E semantic coverage duplicates evidence between ${previous} and ${e2eSemanticExecutionLabel(row)}`,
        );
      }
      semanticEvidence.set(evidenceKey, e2eSemanticExecutionLabel(row));
    }
  }
  return rows;
}

export function e2eSemanticExecutionLabel(row: E2eSemanticExecutionRow): string {
  return row.variant === "" ? row.id : `${row.id} / ${row.variant}`;
}
