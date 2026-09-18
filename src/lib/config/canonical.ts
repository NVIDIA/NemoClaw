// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import YAML from "yaml";
import { sortCanonicalMappings } from "./canonical-mapping";

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

/** Render one validated document and its digests without parsing it again. */
export function renderCanonicalNemoClawConfig(
  config: Readonly<{ readonly spec: unknown }>,
): RenderedNemoClawConfig {
  const yaml = canonicalYaml(config);
  return {
    yaml,
    documentDigest: sha256(yaml),
    specDigest: sha256(canonicalYaml(config.spec)),
  };
}
