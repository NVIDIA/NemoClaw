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

export type SandboxRecreateCleanupDeps = DetachSandboxProvidersDeps & {
  warn?: (message: string) => void;
  redact?: (input: string) => string;
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

const TOLERATED_DETACH_OUTPUT_RE =
  /\bNotFound\b|\bNotAttached\b|not\s+found|not\s+attached/i;

const MAX_WARNING_OUTPUT_CHARS = 500;

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

function identityRedact(input: string): string {
  return input;
}

/**
 * Detach every per-sandbox messaging and search provider before the sandbox
 * itself is removed. OpenShell `sandbox delete` does not auto-detach
 * providers, so a follow-up `provider delete` (or `provider create` after a
 * `replaceExisting` upsert) trips on FailedPrecondition with
 * "is attached to sandbox(es): <name>" — the canonical pattern is detach
 * first, then delete the sandbox, then delete the provider.
 *
 * Best-effort across the full suffix set: `NotFound` / `NotAttached` /
 * `not found` / `not attached` outputs are treated as success-equivalent.
 * Non-matching failures are returned in `failures` for the caller to surface;
 * the caller decides whether to abort or continue.
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
    if (TOLERATED_DETACH_OUTPUT_RE.test(output)) {
      continue;
    }
    failures.push({ name, output: output.trim() });
  }
  return { detached, failures };
}

/**
 * Run the recreate / destroy preflight that detaches every per-sandbox
 * messaging and search provider, then surfaces any non-tolerated failure
 * through the injected `warn` channel with the failure output redacted and
 * length-capped. Returns the same result as `detachSandboxProviders` so
 * callers can inspect / re-test specific names if they want to short-circuit
 * downstream work; the rebuild and destroy paths both treat any residual
 * failures as advisory because the subsequent `sandbox delete` and
 * `provider delete` / `provider create` calls will surface the real
 * uncleanable provider with a more actionable diagnostic.
 */
export function runSandboxProviderPreDeleteCleanup(
  sandboxName: string,
  deps: SandboxRecreateCleanupDeps = {},
): DetachSandboxProvidersResult {
  const result = detachSandboxProviders(sandboxName, { runOpenshell: deps.runOpenshell });
  if (result.failures.length === 0) return result;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const redact = deps.redact ?? identityRedact;
  for (const failure of result.failures) {
    const safeOutput = redact(failure.output).slice(0, MAX_WARNING_OUTPUT_CHARS);
    warn(
      `  Warning: failed to detach provider '${failure.name}' before sandbox delete: ${safeOutput}`,
    );
  }
  return result;
}
