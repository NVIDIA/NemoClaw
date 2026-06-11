// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { DEFAULT_NEMOCLAW_INSTANCE, isDefaultInstance, NEMOCLAW_INSTANCE } from "../core/instance";

export const ROOT = path.resolve(__dirname, "..", "..", "..");
export const SCRIPTS = path.join(ROOT, "scripts");

/** Leaf directory name for today's singleton state root. */
export const BASE_NEMOCLAW_HOME_DIR_NAME = ".nemoclaw";

/**
 * Resolve the leaf directory name for the NemoClaw state root, derived from
 * the active instance identity. The default instance keeps the bare
 * `.nemoclaw` name verbatim so existing single-instance deployments and
 * on-disk state are untouched; any non-default instance gets a
 * `.nemoclaw-<instance>` leaf so callers that route through this helper land
 * in a per-instance tree.
 *
 * Migration is partial. Surfaces that route through this helper today: the
 * credentials store (`credentials/store.ts`), rebuild backups + blueprint
 * digest (`state/sandbox.ts`), the local-adapter state directory and Ollama
 * auth-proxy token (`inference/local-adapter-lifecycle.ts`, `inference/local.ts`),
 * the gateway-name binding (`onboard/gateway-binding.ts`), and every consumer
 * of `resolveNemoclawStateDir()` — shields audit (`shields/audit.ts`),
 * shields posture (`shields/index.ts`), and the shields timer
 * (`shields/timer.ts`) all already land under `.nemoclaw-<instance>/state`.
 * Surfaces that still hard-code `.nemoclaw` — the sandbox registry
 * (`state/registry.ts`), onboard session state (`state/onboard-session.ts`),
 * messaging configuration, uninstall plan, host-side mount roots, and the
 * `config-io` host-root permission healer — continue to share state across
 * instances until follow-up PRs migrate them.
 */
export function resolveNemoclawHomeDirName(instance: string = NEMOCLAW_INSTANCE): string {
  return isDefaultInstance(instance)
    ? BASE_NEMOCLAW_HOME_DIR_NAME
    : `${BASE_NEMOCLAW_HOME_DIR_NAME}-${instance}`;
}

export function resolveNemoclawHomeDir(
  homeDir: string = process.env.HOME ?? os.homedir(),
  instance: string = NEMOCLAW_INSTANCE,
): string {
  return path.join(homeDir, resolveNemoclawHomeDirName(instance));
}

export function resolveNemoclawStateDir(
  homeDir: string = process.env.HOME ?? os.homedir(),
  instance: string = NEMOCLAW_INSTANCE,
): string {
  return path.join(resolveNemoclawHomeDir(homeDir, instance), "state");
}

export { DEFAULT_NEMOCLAW_INSTANCE, NEMOCLAW_INSTANCE };
