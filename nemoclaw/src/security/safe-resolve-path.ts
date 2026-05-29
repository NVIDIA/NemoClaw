// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
