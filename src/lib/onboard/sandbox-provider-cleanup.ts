// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type SandboxProviderRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type DetachSandboxProvidersDeps = {
  runOpenshell?: SandboxProviderRunOpenshell;
};

export type DetachSandboxProvidersResult = {
  detached: string[];
  failures: Array<{ name: string; output: string }>;
};

export const SANDBOX_PROVIDER_SUFFIXES = [
  "telegram-bridge",
  "discord-bridge",
  "slack-bridge",
  "slack-app",
  "wechat-bridge",
  "brave-search",
] as const;

export type SandboxProviderSuffix = (typeof SANDBOX_PROVIDER_SUFFIXES)[number];

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function") {
    return (value as Buffer).toString();
  }
  return "";
}

function defaultRunOpenshell(
  args: string[],
  opts?: Record<string, unknown>,
): ReturnType<SandboxProviderRunOpenshell> {
  const runtime = require("../adapters/openshell/runtime") as {
    runOpenshell: SandboxProviderRunOpenshell;
  };
  return runtime.runOpenshell(args, opts);
}

/**
 * Detach every per-sandbox messaging and search provider before the sandbox
 * itself is removed. OpenShell `sandbox delete` does not auto-detach
 * providers, so a follow-up `provider delete` (or `provider create` after a
 * `replaceExisting` upsert) trips on FailedPrecondition with
 * "is attached to sandbox(es): <name>" — the canonical pattern is detach
 * first, then delete the sandbox, then delete the provider.
 *
 * Best-effort across the full suffix set: `NotFound` / `not attached`
 * outputs are treated as success-equivalent. Non-matching failures are
 * returned in `failures` for the caller to surface; the caller decides
 * whether to abort or continue.
 */
export function detachSandboxProviders(
  sandboxName: string,
  deps: DetachSandboxProvidersDeps = {},
): DetachSandboxProvidersResult {
  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  const detached: string[] = [];
  const failures: Array<{ name: string; output: string }> = [];
  for (const suffix of SANDBOX_PROVIDER_SUFFIXES) {
    const name = `${sandboxName}-${suffix}`;
    const result = runOpenshell(
      ["sandbox", "provider", "detach", sandboxName, name],
      { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) {
      detached.push(name);
      continue;
    }
    const output = `${bufferOrStringToText(result.stdout)}${bufferOrStringToText(result.stderr)}`;
    if (/\bNotFound\b|not found|not attached/i.test(output)) {
      continue;
    }
    failures.push({ name, output: output.trim() });
  }
  return { detached, failures };
}
