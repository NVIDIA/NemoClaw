// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition } from "../../../agent/definition-types";

function copyHermesManifestAgent(source: AgentDefinition): AgentDefinition {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-manifest-"));
  const manifestPath = path.join(directory, "manifest.yaml");
  fs.copyFileSync(source.manifestPath, manifestPath);
  fs.chmodSync(manifestPath, 0o600);
  return { ...source, manifestPath };
}

const privateCopies = new Map<string, AgentDefinition>();

/**
 * Return an owner-only copy of a source agent's manifest and a cloned agent
 * definition that points at it.
 *
 * Startup-contract reads reject group- or world-writable manifest sources, so
 * a checkout created under a permissive umask (for example 0002) must not feed
 * its own manifest path to those checks. The copy keeps the source bytes, so
 * manifest digests and reviewed-version comparisons are unchanged. The result
 * is cached per source path and must be treated as read-only; tests that
 * mutate a manifest copy must clone it into their own directory first.
 */
export function privateHermesManifestAgent(source: AgentDefinition): AgentDefinition {
  const existing = privateCopies.get(source.manifestPath);
  if (existing) return existing;
  const copy = copyHermesManifestAgent(source);
  privateCopies.set(source.manifestPath, copy);
  return copy;
}
