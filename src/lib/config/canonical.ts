// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import YAML from "yaml";
import { sortCanonicalMappings } from "./canonical-mapping";
import type { NemoClawConfigSpec } from "./model";
import { validateNemoClawConfig } from "./schema";

function canonicalYaml(value: unknown): string {
  return YAML.stringify(sortCanonicalMappings(value), { indent: 2, lineWidth: 0 });
}

function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

export interface RenderedNemoClawConfig {
  readonly yaml: string;
  readonly documentDigest: string;
  readonly specDigest: string;
}

/** Validate and render one canonical document and its digests in one pass. */
export function renderCanonicalNemoClawConfig(value: unknown): RenderedNemoClawConfig {
  const config = validateNemoClawConfig(value);
  const yaml = canonicalYaml(config);
  return {
    yaml,
    documentDigest: sha256(yaml),
    specDigest: sha256(canonicalYaml(config.spec satisfies NemoClawConfigSpec)),
  };
}
