// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import YAML from "yaml";
import type { NemoClawConfigSpec } from "./model";
import { validateNemoClawConfig } from "./schema";

function sortMappings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortMappings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortMappings(child)]),
  );
}

function canonicalYaml(value: unknown): string {
  return YAML.stringify(sortMappings(value), { indent: 2, lineWidth: 0 });
}

function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

/** Serialize a validated aggregate config as deterministic canonical YAML. */
export function serializeCanonicalNemoClawConfig(value: unknown): string {
  return canonicalYaml(validateNemoClawConfig(value));
}

export interface NemoClawConfigDigests {
  readonly documentDigest: string;
  readonly specDigest: string;
}

/** Digest the canonical document and its desired-state spec separately. */
export function digestNemoClawConfig(value: unknown): NemoClawConfigDigests {
  const config = validateNemoClawConfig(value);
  return {
    documentDigest: sha256(canonicalYaml(config)),
    specDigest: sha256(canonicalYaml(config.spec satisfies NemoClawConfigSpec)),
  };
}
