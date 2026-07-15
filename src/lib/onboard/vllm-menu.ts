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
 * available for this host." message. It also lets the caller surface managed
 * vLLM by default for known DGX platforms while generic Linux stays gated, and
 * logs a note when running-vLLM takes precedence over the env-var opt-in.
 * Exact qualified profiles are the exception: they retain the install entry so
 * the FSM can reject an occupied port instead of reusing an unqualified server.
 */

import { VLLM_PORT } from "../core/ports";
import type { NvidiaPlatform } from "../inference/nim";
import { EXPERIMENTAL_SINGLE_USER_PROFILE, VLLM_PROFILE_ENV } from "../inference/vllm-models";

interface VllmProfileShape {
  name: string;
}

const MANAGED_VLLM_DEFAULT_PLATFORMS = new Set<NvidiaPlatform>(["spark", "station"]);

export interface VllmMenuEntry {
  key: "vllm" | "install-vllm";
  label: string;
}

export interface BuildVllmMenuOptions {
  vllmRunning: boolean;
  vllmProfile: VllmProfileShape | null | undefined;
  experimental: boolean;
  platform?: NvidiaPlatform;
  hasVllmImage: boolean;
  /** Defaults to process.env so tests can inject a clean environment. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/**
 * Exact managed-runtime profiles cannot reuse an arbitrary listener on the
 * local vLLM port. Their image, arguments, environment, and safety checks are
 * part of the qualified contract, so onboarding must keep the managed-install
 * transition and let it fail closed until the existing server is stopped.
 */
export function requiresExactManagedVllm(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    String(env[VLLM_PROFILE_ENV] ?? "")
      .trim()
      .toLowerCase() === EXPERIMENTAL_SINGLE_USER_PROFILE
  );
}

export function buildVllmMenuEntries(opts: BuildVllmMenuOptions): VllmMenuEntry[] {
  const log = opts.log ?? console.log;
  // Read NEMOCLAW_PROVIDER directly so interactive runs with an explicit
  // env-var opt-in surface the menu entry too — the non-interactive provider
  // hint is null outside non-interactive mode.
  const env = opts.env ?? process.env;
  const userChoseManagedVllm =
    (env.NEMOCLAW_PROVIDER || "").trim().toLowerCase() === "install-vllm";
  const exactManagedVllmRequired = requiresExactManagedVllm(env);
  if (opts.vllmRunning && !exactManagedVllmRequired) {
    if (userChoseManagedVllm) {
      log(
        `  Note: NEMOCLAW_PROVIDER=install-vllm requested, but vLLM is already running on localhost:${VLLM_PORT} — selecting the running instance.`,
      );
    }
    const experimentalLabel =
      opts.platform && MANAGED_VLLM_DEFAULT_PLATFORMS.has(opts.platform) ? "" : " [experimental]";
    return [
      {
        key: "vllm",
        label: `Local vLLM${experimentalLabel} (localhost:${VLLM_PORT}) — running (suggested)`,
      },
    ];
  }
  if (opts.vllmRunning && exactManagedVllmRequired) {
    log(
      `  Note: ${VLLM_PROFILE_ENV}=${EXPERIMENTAL_SINGLE_USER_PROFILE} requires the qualified managed runtime; the existing vLLM instance on localhost:${VLLM_PORT} cannot be reused.`,
    );
  }
  if (
    exactManagedVllmRequired ||
    userChoseManagedVllm ||
    (opts.vllmProfile &&
      (opts.experimental || (opts.platform && MANAGED_VLLM_DEFAULT_PLATFORMS.has(opts.platform))))
  ) {
    const verb = opts.hasVllmImage ? "Start" : "Install";
    const profileLabel = opts.vllmProfile?.name ?? "no profile detected";
    return [{ key: "install-vllm", label: `${verb} vLLM (${profileLabel})` }];
  }
  return [];
}
