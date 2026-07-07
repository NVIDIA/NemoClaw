// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #5735: A rebuild recreates a sandbox from its persisted registry/session
// config. Ambient onboarding-selection env vars left over from an *unrelated*
// onboard (e.g. the installer's just-completed Deep Agents onboard right before
// `upgrade-sandboxes --auto`) must never steer `onboard --resume` away from the
// target sandbox's recorded agent/provider/model/credential. These are the env
// vars that onboard's resume path reads to pick the agent, provider, model,
// endpoint, credential, preferred inference API, and endpoint reasoning mode —
// isolating them during the recreate forces the pinned session +
// gateway-registered provider to win.
//
// SOURCE-OF-TRUTH NOTE (#5735, PRA-4): the real source boundary is
// `onboard --resume`, which still reads these from the global `process.env`:
//   - NEMOCLAW_AGENT        → src/lib/agent/defs.ts resolveAgentName()
//   - NEMOCLAW_PROVIDER     → src/lib/onboard/providers.ts getNonInteractiveProvider()
//   - NEMOCLAW_PROVIDER_KEY → src/lib/onboard/provider-key-bridge.ts / providers.ts
//   - NEMOCLAW_ENDPOINT_URL → src/lib/onboard.ts (remote endpoint override)
//   - NEMOCLAW_MODEL        → src/lib/onboard.ts (model override)
//   - NEMOCLAW_COMPAT_MODEL / NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL
//                           → src/lib/onboard/providers.ts (hosted model aliases)
//   - NEMOCLAW_PREFERRED_API → src/lib/onboard/setup-nim-selection.ts
//   - NEMOCLAW_REASONING    → src/lib/onboard/reasoning-mode.ts
//   - NEMOCLAW_VLLM_MODEL / NEMOCLAW_VLLM_EXTRA_ARGS_JSON
//                           → src/lib/onboard/setup-nim-vllm.ts
//   - NEMOCLAW_FROM_DOCKERFILE → src/lib/onboard/entry-options.ts
//   - NEMOCLAW_POLICY_TIER / NEMOCLAW_POLICY_MODE / NEMOCLAW_POLICY_PRESETS
//                           → src/lib/onboard/policy-tier-env.ts / policy selection
//   - NEMOCLAW_SANDBOX_GPU / NEMOCLAW_SANDBOX_GPU_DEVICE
//                           → src/lib/onboard/sandbox-gpu-mode.ts
//   - NEMOCLAW_TOOL_DISCLOSURE → src/lib/tool-disclosure.ts
// This list MUST stay in sync with those reads; a contract test in
// rebuild-env-isolation.test.ts pins the exact set so adding a new
// onboard-selection env var forces a conscious update here.
// REMOVAL CONDITION: delete this isolation once `onboard --resume` accepts an
// explicit registry-derived recreate config (or a constrained env map) and
// stops consulting ambient selection env for rebuild recreates — then the
// source boundary enforces the invariant and this wrapper is redundant.
export const AMBIENT_RECREATE_ENV_VARS = [
  "NEMOCLAW_AGENT",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_PROVIDER_KEY",
  "NEMOCLAW_ENDPOINT_URL",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_COMPAT_MODEL",
  "NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_REASONING",
  "NEMOCLAW_VLLM_MODEL",
  "NEMOCLAW_VLLM_EXTRA_ARGS_JSON",
  "NEMOCLAW_FROM_DOCKERFILE",
  "NEMOCLAW_WEB_SEARCH_PROVIDER",
  "NEMOCLAW_POLICY_TIER",
  "NEMOCLAW_POLICY_MODE",
  "NEMOCLAW_POLICY_PRESETS",
  "NEMOCLAW_SANDBOX_GPU",
  "NEMOCLAW_SANDBOX_GPU_DEVICE",
  "NEMOCLAW_TOOL_DISCLOSURE",
] as const;

/**
 * Render an untrusted env value safe to print on a single terminal line (#5735,
 * PRA-7). `NEMOCLAW_AGENT` is process-environment input and may contain
 * newlines, ANSI escape sequences, or other control characters that could
 * inject fake status lines into a destructive rebuild/recovery path. Strip
 * control + C1 characters (including ESC, which neuters any ANSI sequence),
 * collapse whitespace runs, and cap the length so the displayed value is a
 * single bounded token.
 */
export function sanitizeEnvValueForDisplay(value: string, maxLength = 80): string {
  const stripped = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

export interface AmbientRecreateEnvAssessment {
  /** Ambient onboard-selection env vars currently set (non-empty). */
  readonly presentVars: string[];
  /**
   * Set when ambient `NEMOCLAW_AGENT` would recreate the sandbox as a different
   * agent than the registry records — the structural target change behind the
   * reporter's destroyed-then-recreated-as-Deep-Agents failure.
   */
  readonly agentMismatch: { readonly envAgent: string; readonly registryAgent: string } | null;
}

/**
 * Describe how the ambient process env would alter this sandbox's recreate,
 * relative to its authoritative registry agent. Pure — does not mutate env.
 */
export function assessAmbientRecreateEnv(
  registryAgent: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AmbientRecreateEnvAssessment {
  const presentVars = AMBIENT_RECREATE_ENV_VARS.filter(
    (name) => typeof env[name] === "string" && env[name]?.trim() !== "",
  );

  // The registry's null agent is the default OpenClaw runtime.
  const effectiveRegistryAgent = (registryAgent || "openclaw").trim();
  const envAgent = (env.NEMOCLAW_AGENT || "").trim();
  const agentMismatch =
    envAgent && envAgent !== effectiveRegistryAgent
      ? { envAgent, registryAgent: effectiveRegistryAgent }
      : null;

  return { presentVars: [...presentVars], agentMismatch };
}

/**
 * Remove the ambient onboard-selection env vars so the immediate
 * `onboard --resume` recreate cannot read a different onboard's values.
 * Returns a restore function that puts the original values back (including
 * re-deleting any var that was unset). Always pair with a `finally`.
 */
export function isolateAmbientRecreateEnv(env: NodeJS.ProcessEnv = process.env): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of AMBIENT_RECREATE_ENV_VARS) {
    saved.set(name, env[name]);
    delete env[name];
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  };
}
