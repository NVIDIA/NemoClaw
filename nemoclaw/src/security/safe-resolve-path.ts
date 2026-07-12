// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host boundary contract
 * ----------------------
 *
 * `safeResolvePath` sits at the boundary between the NemoClaw plugin and the
 * OpenClaw host's plugin API. The host is the source of truth for path
 * resolution: in the gateway-managed runtime, `api.resolvePath` canonicalises
 * symlinks and `..` traversals against the agent's sandbox CWD, producing an
 * absolute path that downstream classifiers (e.g. `isMemoryPath`) can match
 * against known persistent-state segments.
 *
 * Allowed raw path forms (per the OpenClaw write-tool contract):
 *   - Absolute paths anchored at `/sandbox/` (e.g. `/sandbox/.openclaw/memory/notes.md`).
 *   - Workspace-relative paths (e.g. `IDENTITY.md`, `memory/2026-05-29.md`) that
 *     the host would resolve against the agent's workspace directory.
 *
 * Why this helper exists:
 *   OpenClaw's embedded-fallback runtime — entered when the gateway has a
 *   pending scope upgrade — provides a degraded `api` object whose
 *   `resolvePath` returns `undefined` (or is absent). Without a fallback the
 *   downstream `filePath.includes(segment)` check crashed the
 *   `before_tool_call` hook with a TypeError. Returning the raw path keeps the
 *   memory-path classifier operational on its literal form; the classifier
 *   recognises both absolute resolved paths and the canonical
 *   workspace-relative forms above.
 *
 * Removal condition:
 *   Once OpenClaw guarantees that `api.resolvePath` is always present and
 *   returns a non-empty string in every runtime (including embedded
 *   fallback), this helper becomes an unnecessary indirection over a direct
 *   `api.resolvePath(rawPath)` call and can be deleted along with its tests.
 */

export interface SafeResolvePathHost {
  resolvePath?: (input: string) => string | undefined;
  logger?: {
    debug?: (message: string) => void;
  };
}

/**
 * Resolve `rawPath` through the host's resolver, falling back to the raw path
 * when the host runtime does not expose a usable resolver. OpenClaw's
 * embedded-fallback runtime ships a degraded api object whose `resolvePath`
 * returns `undefined` or is missing entirely; previously this poisoned the
 * downstream `filePath.includes(...)` check and crashed the hook. Returning
 * the raw path keeps the memory-path check operational on its literal form.
 */
export function safeResolvePath(host: SafeResolvePathHost, rawPath: string): string {
  if (typeof host.resolvePath !== "function") return rawPath;
  try {
    const resolved = host.resolvePath(rawPath);
    return typeof resolved === "string" && resolved.length > 0 ? resolved : rawPath;
  } catch (err) {
    host.logger?.debug?.(
      `safeResolvePath: host resolver threw for '${rawPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return rawPath;
  }
}
