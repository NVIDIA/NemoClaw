// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition } from "../../../agent/definition-types";

import type { loadAgent } from "../../../agent/defs";

type DefsModule = { loadAgent: typeof loadAgent };

/** Copy an agent's manifest into an owner-only temp directory and re-point the definition. */
function copyHermesManifestAgent(source: AgentDefinition): AgentDefinition {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-manifest-"));
  const manifestPath = path.join(directory, "manifest.yaml");
  fs.copyFileSync(source.manifestPath, manifestPath);
  fs.chmodSync(manifestPath, 0o600);
  return { ...source, manifestPath };
}

const privateCopies = new Map<
  string,
  { agent: AgentDefinition; contents: Buffer; directory: string }
>();

/**
 * Factory for mocking loadAgent in Hermes test files.
 *
 * Returns a function that resolves "hermes" through the owner-only manifest copy,
 * while passing other agents through unchanged. The hoisted vi.mock() call in
 * each test file delegates to this factory. Example:
 *
 * ```ts
 * vi.mock("../../agent/defs", async (importOriginal) => {
 *   const original = await importOriginal<typeof import("../../agent/defs")>();
 *   return { ...original, loadAgent: privateHermesLoadAgentMock(original) };
 * });
 * ```
 */
export function privateHermesLoadAgentMock(
  original: DefsModule,
): DefsModule["loadAgent"] {
  return (name: string, env?: NodeJS.ProcessEnv) =>
    name === "hermes"
      ? privateHermesManifestAgent(original.loadAgent(name, env))
      : original.loadAgent(name, env);
}

/**
 * Return an owner-only copy of a source agent's manifest and a cloned agent
 * definition that points at it.
 *
 * Startup-contract reads reject group- or world-writable manifest sources, so
 * a checkout created under a permissive umask (for example 0002) must not feed
 * its own manifest path to those checks. The copy keeps the source bytes, so
 * manifest digests and reviewed-version comparisons are unchanged. The result
 * is cached per source path AND manifest contents: a source definition whose
 * manifest bytes change gets a fresh private copy, while unchanged contents
 * reuse the cached copy. The cached copies must be treated as read-only; tests
 * that mutate a manifest copy must clone it into their own directory first.
 */
export function privateHermesManifestAgent(source: AgentDefinition): AgentDefinition {
  const manifestContents = fs.readFileSync(source.manifestPath);
  const existing = privateCopies.get(source.manifestPath);
  // Return the CURRENT definition with the cached private manifest path. The
  // cached agent snapshot goes stale when a test passes a changed definition
  // for the same manifest path; the on-disk private copy is unaffected.
  if (
    existing &&
    fs.existsSync(existing.agent.manifestPath) &&
    Buffer.compare(existing.contents, manifestContents) === 0
  ) {
    return { ...source, manifestPath: existing.agent.manifestPath };
  }
  // Replace any stale copy for this path so its directory does not leak.
  const stale = privateCopies.get(source.manifestPath);
  if (stale) {
    try {
      fs.rmSync(stale.directory, { recursive: true, force: true });
    } catch {
      // Best effort; the fresh copy below is authoritative.
    }
  }
  const copy = copyHermesManifestAgent(source);
  // Extract the directory from the manifest path for cleanup
  const directory = path.dirname(copy.manifestPath);
  privateCopies.set(source.manifestPath, { agent: copy, directory, contents: manifestContents });
  return copy;
}

/**
 * Remove all cached manifest copies and their directories.
 * Call this in an `afterEach` or `afterAll` hook to clean up temporary files;
 * either lifecycle hook is acceptable.
 */
export function cleanupPrivateHermesManifestAgent(): void {
  for (const { directory } of privateCopies.values()) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort cleanup; ignore errors
    }
  }
  privateCopies.clear();
}