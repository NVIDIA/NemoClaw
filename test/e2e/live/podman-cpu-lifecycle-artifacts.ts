// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { redactString } from "../fixtures/redaction.ts";

// This CLI stays independent of product-module loading so it can run after a
// failed build. The focused support test binds these allowlist keys to the
// production Podman ownership constants.
const PODMAN_MANAGED_LABEL = "openshell.managed";
const PODMAN_SANDBOX_ID_LABEL = "openshell.ai/sandbox-id";
const PODMAN_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const PODMAN_SANDBOX_NAMESPACE_LABEL = "openshell.ai/sandbox-namespace";
const PODMAN_SANDBOX_WORKSPACE_LABEL = "openshell.ai/sandbox-workspace";
const PODMAN_SANDBOX_WORKSPACE = "default";
const AGENT_LABEL = "nemoclaw.agent";
const SAFE_IDENTITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const SAFE_STATE_VALUES = new Set([
  "created",
  "exited",
  "initialized",
  "paused",
  "removing",
  "running",
  "stopped",
  "stopping",
  "unknown",
]);
const MAX_INSPECT_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface PodmanContainerArtifactSummary {
  readonly labels: Readonly<Record<string, string | null>>;
  readonly state: {
    readonly paused: boolean | null;
    readonly running: boolean | null;
    readonly status: string | null;
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function identityValue(value: unknown, allowEmpty = false): string | null {
  if (allowEmpty && value === "") return "";
  if (typeof value !== "string" || !SAFE_IDENTITY_VALUE.test(value)) return null;
  return redactString(value) === value ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stateValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return SAFE_STATE_VALUES.has(normalized) ? normalized : null;
}

/**
 * Reduce one Podman inspect response to the non-secret state and ownership
 * fields needed to diagnose the CPU lifecycle proof. Raw inspect data must
 * never cross the artifact boundary.
 */
export function sanitizePodmanInspectArtifact(output: string): PodmanContainerArtifactSummary {
  if (Buffer.byteLength(output, "utf8") > MAX_INSPECT_BYTES) {
    throw new Error("Podman inspect output exceeds the diagnostic input limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Podman inspect output is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Podman inspect output must contain exactly one container.");
  }
  const inspect = record(parsed[0], "Podman inspect entry");
  const config = record(inspect.Config, "Podman inspect Config");
  const labels = record(config.Labels, "Podman inspect Config.Labels");
  const state = record(inspect.State, "Podman inspect State");

  return Object.freeze({
    labels: Object.freeze({
      [PODMAN_MANAGED_LABEL]: labels[PODMAN_MANAGED_LABEL] === "true" ? "true" : null,
      [PODMAN_SANDBOX_ID_LABEL]: identityValue(labels[PODMAN_SANDBOX_ID_LABEL]),
      [PODMAN_SANDBOX_NAME_LABEL]: identityValue(labels[PODMAN_SANDBOX_NAME_LABEL]),
      [PODMAN_SANDBOX_NAMESPACE_LABEL]: identityValue(labels[PODMAN_SANDBOX_NAMESPACE_LABEL], true),
      [PODMAN_SANDBOX_WORKSPACE_LABEL]:
        labels[PODMAN_SANDBOX_WORKSPACE_LABEL] === PODMAN_SANDBOX_WORKSPACE
          ? PODMAN_SANDBOX_WORKSPACE
          : null,
      [AGENT_LABEL]: identityValue(labels[AGENT_LABEL]),
    }),
    state: Object.freeze({
      paused: booleanValue(state.Paused),
      running: booleanValue(state.Running),
      status: stateValue(state.Status),
    }),
  });
}

async function sanitizeStdin(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, "utf8") > MAX_INSPECT_BYTES) {
      throw new Error("Podman inspect output exceeds the diagnostic input limit.");
    }
  }
  process.stdout.write(`${JSON.stringify(sanitizePodmanInspectArtifact(input))}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void sanitizeStdin().catch(() => {
    process.stderr.write("Podman inspect sanitization failed.\n");
    process.exitCode = 1;
  });
}
