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
 * logs a note when running-vLLM takes precedence over the env-var opt-in. N1x
 * and explicit managed GPU selection keep the managed selection so the
 * provider flow can report the running-server conflict without changing the
 * user's intent.
 */

import { VLLM_PORT } from "../core/ports";
import type { NvidiaPlatform } from "../inference/nim";

/** Provider key for a NemoClaw-managed local vLLM install or start. */
export const MANAGED_VLLM_PROVIDER_KEY = "install-vllm";

interface VllmProfileShape {
  name: string;
}

const MANAGED_VLLM_DEFAULT_PLATFORMS = new Set<NvidiaPlatform>(["spark", "station", "n1x"]);

/** NVIDIA platforms where the provider menu exposes managed vLLM without `experimental`. */
export function isManagedVllmDefaultPlatform(platform: NvidiaPlatform | null | undefined): boolean {
  return platform != null && MANAGED_VLLM_DEFAULT_PLATFORMS.has(platform);
}

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

export function buildVllmMenuEntries(opts: BuildVllmMenuOptions): VllmMenuEntry[] {
  const log = opts.log ?? console.log;
  // Read NEMOCLAW_PROVIDER directly so interactive runs with an explicit
  // env-var opt-in surface the menu entry too — the non-interactive provider
  // hint is null outside non-interactive mode.
  const env = opts.env ?? process.env;
  const userChoseManagedVllm =
    (env.NEMOCLAW_PROVIDER || "").trim().toLowerCase() === MANAGED_VLLM_PROVIDER_KEY;
  const hasManagedVllmGpuSelection =
    String(env.NEMOCLAW_VLLM_GPU_DEVICE ?? "").trim() !== "";
  const preserveManagedVllmIntent =
    userChoseManagedVllm && (opts.platform === "n1x" || hasManagedVllmGpuSelection);
  if (opts.vllmRunning && !preserveManagedVllmIntent) {
    if (userChoseManagedVllm) {
      log(
        `  Note: NEMOCLAW_PROVIDER=install-vllm requested, but vLLM is already running on localhost:${VLLM_PORT} — selecting the running instance.`,
      );
    }
    const experimentalLabel = isManagedVllmDefaultPlatform(opts.platform) ? "" : " [experimental]";
    return [
      {
        key: "vllm",
        label: `Local vLLM${experimentalLabel} (localhost:${VLLM_PORT}) — running${
          opts.platform === "n1x" ? "" : " (suggested)"
        }`,
      },
    ];
  }
  if (
    userChoseManagedVllm ||
    (opts.vllmProfile && (opts.experimental || isManagedVllmDefaultPlatform(opts.platform)))
  ) {
    const verb = opts.hasVllmImage ? "Start" : "Install";
    const profileLabel = opts.vllmProfile?.name ?? "no profile detected";
    const previewLabel = opts.platform === "n1x" ? " [Deferred preview]" : "";
    return [{ key: "install-vllm", label: `${verb} vLLM (${profileLabel})${previewLabel}` }];
  }
  return [];
}
