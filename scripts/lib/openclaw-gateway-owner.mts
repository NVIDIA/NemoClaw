// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

type NativeFunction = (...args: unknown[]) => unknown;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native ownership inspection result");
  return value as Record<string, unknown>;
}

/** Wait for native ownership to end without reading config or changing any state. */
export async function waitForOpenClawGatewayOwner(
  root: string,
  deps: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<unknown>;
    budgetMs?: number;
  } = {},
): Promise<void> {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (metadata.name !== "openclaw" || metadata.version !== "2026.10.5")
    throw new Error("Unreviewed ownership inspector");
  const readOwner = await nativeFunction(root, "gateway-lock-", "readActiveGatewayLockIdentity");
  const assertLeaseStopped = await nativeFunction(
    root,
    "gateway-owner-lease-",
    "assertGatewayOwnerLeaseStopped",
  );
  const now = deps.now ?? (() => performance.now());
  const wait = deps.sleep ?? sleep;
  // The default leaves time for configuration inside root apply's five-minute
  // deadline. Host settlement uses its separate five-minute lease budget.
  const deadline = now() + (deps.budgetMs ?? 120_000);
  let reported = false;
  while (now() < deadline) {
    try {
      const owner = await readOwner({
        env: process.env,
        requireInspection: true,
        includeEmbedded: true,
        timeoutMs: Math.max(1, Math.min(5_000, deadline - now())),
      });
      if (owner === undefined) {
        // The native assertion checks process identity, namespace, heartbeat,
        // and expiry together. A lease's age never proves a live owner stopped.
        await assertLeaseStopped(process.env);
        return;
      } else if (!Number.isSafeInteger(object(owner).pid))
        throw new Error("Invalid native owner identity");
    } catch (error) {
      // A foreign PID namespace cannot prove death while the native heartbeat
      // is fresh. Retry native namespace or live-lease refusals only; malformed
      // or unreadable state fails immediately.
      const namespaceRefusal =
        error instanceof Error &&
        (error.name === "GatewayLockNamespaceError" ||
          (error.name === "GatewayLockError" &&
            error.cause instanceof Error &&
            error.cause.name === "GatewayLockNamespaceError"));
      const liveLease =
        error instanceof Error &&
        error.message.startsWith(
          "Another Gateway owner lease is still active for this state directory:",
        );
      if (!namespaceRefusal && !liveLease) throw error;
    }
    if (!reported) {
      process.stderr.write("[setup] Waiting for OpenClaw native gateway ownership to end\n");
      reported = true;
    }
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(2_000, remaining));
  }
  throw new Error("OpenClaw gateway ownership did not end within the maintenance budget");
}

/** Resolve only the reviewed native module family, refusing missing/ambiguous exports. */
export async function nativeFunction(
  root: string,
  prefix: string,
  name: string,
): Promise<NativeFunction> {
  const dist = path.join(root, "dist");
  const candidates: { file: string; exported: string }[] = [];
  for (const nameOnDisk of fs.readdirSync(dist)) {
    if (!nameOnDisk.startsWith(prefix) || !/\.m?js$/.test(nameOnDisk)) continue;
    const file = path.join(dist, nameOnDisk);
    const source = fs.readFileSync(file, "utf8");
    for (const declaration of source.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const specifier of declaration[1]!.split(",")) {
        const match = specifier.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (match?.[1] === name) candidates.push({ file, exported: match[2] ?? name });
      }
    }
  }
  // Prefer the public facade over the same implementation's minified export.
  const facades = candidates.filter((candidate) => candidate.exported === name);
  const selected = facades.length ? facades : candidates;
  if (selected.length !== 1) throw new Error("Native migration export missing or ambiguous");
  const candidate = selected[0]!;
  const loaded = await import(pathToFileURL(candidate.file).href);
  if (typeof loaded[candidate.exported] !== "function") {
    throw new Error("Native migration export is not callable");
  }
  return loaded[candidate.exported] as NativeFunction;
}
