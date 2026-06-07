// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatEnvAssignment } from "../core/url-utils";
import { withLocalNoProxy } from "../subprocess-env";

const HOST_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function appendHostProxyEnvArgs(
  envArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const proxyEnv: Record<string, string> = {};
  for (const name of HOST_PROXY_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") {
      const trimmed = value.trim();
      // Filter on the trimmed value but ALSO store the trimmed value —
      // forwarding the surrounding whitespace would break consumers that
      // don't re-trim.
      if (trimmed !== "") proxyEnv[name] = trimmed;
    }
  }

  // #2598: NEMOCLAW_MINIMAL_BOOTSTRAP is a host-side opt-in flag (set to
  // "1") that the sandbox's nemoclaw-start.sh:seed_default_workspace_templates
  // reads to skip default workspace template seeding for new/pristine
  // workspaces (does NOT delete files already present), knocking ~3k tokens
  // off OpenClaw's per-turn bootstrap context injection. Partial #2598
  // mitigation: addresses the project-context contribution from NemoClaw's
  // seeded templates; the remaining OpenClaw framework/non-project context
  // is tracked upstream. Bundled here with the proxy propagation because
  // both are env vars forwarded from the host into `openshell sandbox
  // create -- env ... nemoclaw-start`, and the top-level onboard.ts
  // entrypoint is line-budget-constrained per codebase-growth-guardrails.
  if (env.NEMOCLAW_MINIMAL_BOOTSTRAP === "1") {
    envArgs.push(formatEnvAssignment("NEMOCLAW_MINIMAL_BOOTSTRAP", "1"));
  }

  const hasProxy =
    proxyEnv.HTTP_PROXY || proxyEnv.HTTPS_PROXY || proxyEnv.http_proxy || proxyEnv.https_proxy;
  if (!hasProxy) return;

  withLocalNoProxy(proxyEnv);
  for (const name of HOST_PROXY_ENV_NAMES) {
    const value = proxyEnv[name];
    if (value) envArgs.push(formatEnvAssignment(name, value));
  }
}
