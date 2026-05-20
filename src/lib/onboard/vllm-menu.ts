// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for the local-vLLM entries of the onboarding inference menu.
 *
 * Lives here (rather than inline in onboard.ts) so the onboard-entrypoint-budget
 * gate sees a small net-zero or negative diff at the call site while the
 * actual logic gains comments, structure, and tests.
 *
 * #3765: NEMOCLAW_PROVIDER=install-vllm used to disappear silently when either
 *   (a) vLLM was already running — the menu correctly switched to the running
 *       entry but never told the user their env-var opt-in was ignored, or
 *   (b) no vllmProfile matched the host — the menu dropped the install entry
 *       entirely and the dispatcher emitted the generic "Requested provider
 *       'install-vllm' is not available in this environment." error.
 *
 * buildVllmMenuEntries always emits the install-vllm entry when the user
 * explicitly opts in via NEMOCLAW_PROVIDER=install-vllm, even when the profile
 * is null, so the dispatcher can emit the precise "No vLLM install profile
 * available for this host." message. It also logs a note when running-vLLM
 * takes precedence over the env-var opt-in.
 */

import { VLLM_PORT } from "../core/ports";

interface VllmProfileShape {
  name: string;
}

export interface VllmMenuEntry {
  key: "vllm" | "install-vllm";
  label: string;
}

export interface BuildVllmMenuOptions {
  vllmRunning: boolean;
  vllmProfile: VllmProfileShape | null | undefined;
  experimental: boolean;
  hasVllmImage: boolean;
  /** Defaults to process.env so tests can inject a clean environment. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export function buildVllmMenuEntries(opts: BuildVllmMenuOptions): VllmMenuEntry[] {
  const log = opts.log ?? console.log;
  // Read NEMOCLAW_PROVIDER directly so interactive runs with an explicit
  // env-var opt-in surface the menu entry too — the non-interactive provider
  // hint is null outside non-interactive mode.
  const env = opts.env ?? process.env;
  const userChoseManagedVllm = (env.NEMOCLAW_PROVIDER || "").trim().toLowerCase() === "install-vllm";
  if (opts.vllmRunning) {
    if (userChoseManagedVllm) {
      log(
        `  Note: NEMOCLAW_PROVIDER=install-vllm requested, but vLLM is already running on localhost:${VLLM_PORT} — selecting the running instance.`,
      );
    }
    return [
      {
        key: "vllm",
        label: `Local vLLM [experimental] (localhost:${VLLM_PORT}) — running (suggested)`,
      },
    ];
  }
  if (userChoseManagedVllm || (opts.vllmProfile && opts.experimental)) {
    const verb = opts.hasVllmImage ? "Start" : "Install";
    const profileLabel = opts.vllmProfile?.name ?? "no profile detected";
    return [{ key: "install-vllm", label: `${verb} vLLM (${profileLabel})` }];
  }
  return [];
}
