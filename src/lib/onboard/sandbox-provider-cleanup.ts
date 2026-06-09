// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";

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
  /**
   * Treat OpenShell `sandbox not found` outputs as success-equivalent. Used
   * by the resume-after-prune call site where the sandbox is expected to be
   * gone — the call exists only to clear any stale gateway-side attachment
   * record, so a missing-sandbox response means there is nothing to clean.
   */
  tolerateMissingSandbox?: boolean;
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
  /\bNotAttached\b|\bnot\s+attached\b|provider[^\n]{0,200}?(?:\bNotFound\b|\bnot\s+found\b)/i;

const MISSING_SANDBOX_OUTPUT_RE = /sandbox[^\n]{0,200}?(?:\bNotFound\b|\bnot\s+found\b)/i;

const ATTACHED_TO_SANDBOX_RE = /attached\s+to\s+sandbox\(\s*es?\s*\)?\s*:\s*([^"\n]+)/i;

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
 * Source boundary and removal condition: this helper owns the
 * NemoClaw-side workaround for OpenShell's sandbox-deletion lifecycle. The
 * source-of-truth fix lives in OpenShell — `sandbox delete` should either
 * fail fast on attached providers or release the attachment as part of the
 * deletion. When OpenShell guarantees one of those behaviours (released by
 * a future gateway/CLI version that surfaces a structured "detached on
 * delete" signal), this helper and both production call sites can be
 * removed in one pass.
 *
 * Best-effort across the full suffix set. Tolerated diagnostics are
 * narrowly scoped — `NotAttached` / "not attached" (the attachment is
 * already gone) and `provider … NotFound` / `provider … not found` (the
 * provider itself never existed or has already been deleted). Bare
 * `NotFound` is intentionally NOT tolerated because the same wording is
 * also used for missing-sandbox errors during the resume / pruned-sandbox
 * path, where the attachment may still be stale and require manual recovery.
 * Non-matching failures are returned in `failures` for the caller to
 * surface; the caller decides whether to abort or continue.
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
    const result = runOpenshell(["sandbox", "provider", "detach", sandboxName, name], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
    if (result.status === 0) {
      detached.push(name);
      continue;
    }
    const output = `${bufferOrStringToText(result.stdout)}${bufferOrStringToText(result.stderr)}`;
    if (TOLERATED_DETACH_OUTPUT_RE.test(output)) {
      continue;
    }
    if (deps.tolerateMissingSandbox && MISSING_SANDBOX_OUTPUT_RE.test(output)) {
      continue;
    }
    failures.push({ name, output: output.trim() });
  }
  return { detached, failures };
}

/**
 * Parse the sandbox names from an OpenShell `provider delete` FailedPrecondition
 * diagnostic of the shape
 *   `provider 'X' is attached to sandbox(es): A, B`
 * Returns an empty array when the input has no recognisable list.
 */
export function parseAttachedSandboxes(output: string): string[] {
  const match = ATTACHED_TO_SANDBOX_RE.exec(output);
  if (!match) return [];
  return match[1]
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/[.'"`]+$/u, ""))
    .filter((s) => s.length > 0 && s.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(s));
}

export type RecoverProviderResult = {
  detached: string[];
  failures: Array<{ sandbox: string; output: string }>;
};

/**
 * Recovery path for `provider delete` failures whose attachment list points
 * at a sandbox that the local recreate / destroy pass could not reach (the
 * resume-after-prune case: sandbox already gone, but the gateway still
 * tracks the orphaned attachment). Issues `sandbox provider detach
 * <sandbox> <provider>` for each listed sandbox, then returns the per-name
 * outcome so the caller can retry the original delete.
 */
export function recoverAttachedProvider(
  providerName: string,
  attachedSandboxes: string[],
  deps: DetachSandboxProvidersDeps = {},
): RecoverProviderResult {
  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  const detached: string[] = [];
  const failures: Array<{ sandbox: string; output: string }> = [];
  for (const sandbox of attachedSandboxes) {
    const result = runOpenshell(["sandbox", "provider", "detach", sandbox, providerName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
    if (result.status === 0) {
      detached.push(sandbox);
      continue;
    }
    const out = `${bufferOrStringToText(result.stdout)}${bufferOrStringToText(result.stderr)}`;
    if (TOLERATED_DETACH_OUTPUT_RE.test(out)) {
      detached.push(sandbox);
      continue;
    }
    failures.push({ sandbox, output: out.trim() });
  }
  return { detached, failures };
}

/**
 * Run the recreate / destroy preflight that detaches every per-sandbox
 * messaging and search provider, then surfaces any non-tolerated failure
 * through the injected `warn` channel with the failure output redacted and
 * length-capped. Returns the same result as `detachSandboxProviders` so
 * callers can inspect / re-test specific names if they want to short-circuit
 * downstream work.
 *
 * Non-tolerated detach failures are advisory rather than fatal because the
 * downstream operations that immediately follow the cleanup already surface
 * the same residual attachment with an actionable, name-scoped error:
 *
 *   - The onboard recreate path runs `upsertMessagingProviders(...,
 *     { replaceExisting: true })` next; its `provider delete` step calls
 *     `process.exit(1)` with the exact OpenShell FailedPrecondition diagnostic
 *     for any provider still attached.
 *   - The destroy path runs `runOpenshell(["sandbox", "delete", sandboxName])`
 *     next; that call hard-fails on non-`alreadyGone` errors before any
 *     registry state is removed, so a real gateway outage stops destroy
 *     before it can drop state needed for retry.
 *
 * Treating a non-tolerated detach return as a hard failure here would
 * regress the merely-flaky-gateway case (where the subsequent operation
 * succeeds) without gaining any signal that the immediately-following step
 * does not already provide. Callers that want stricter semantics inspect
 * the returned `failures` array directly.
 */
export function runSandboxProviderPreDeleteCleanup(
  sandboxName: string,
  deps: SandboxRecreateCleanupDeps = {},
): DetachSandboxProvidersResult {
  const result = detachSandboxProviders(sandboxName, {
    runOpenshell: deps.runOpenshell,
    tolerateMissingSandbox: deps.tolerateMissingSandbox,
  });
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

export type ProviderDeleteWithRecoveryResult = {
  ok: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
  recoveryFailures: Array<{ sandbox: string; output: string }>;
};

/**
 * Delete an OpenShell provider, recovering from a FailedPrecondition that
 * reports the provider as still attached to one or more sandboxes. The
 * source-of-truth fix lives in OpenShell: `provider delete` should either
 * cascade through the gateway-side attachment record or expose a structured
 * "force" path. Until that lands, this helper parses the attached-sandbox
 * list out of the diagnostic, force-detaches each entry (rejecting any
 * parsed name that fails NemoClaw's sandbox-name validator before issuing
 * a detach), and retries the delete once. Removable in the same future
 * OpenShell version that lets `runSandboxProviderPreDeleteCleanup` go away.
 *
 * Returns the final `provider delete` outcome plus the list of per-sandbox
 * detach failures, so the caller can fold those into the user-facing error
 * if the retry still doesn't land.
 */
export function deleteProviderWithRecovery(
  providerName: string,
  deps: DetachSandboxProvidersDeps = {},
): ProviderDeleteWithRecoveryResult {
  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  let result = runOpenshell(["provider", "delete", providerName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    suppressOutput: true,
  });
  let recoveryFailures: Array<{ sandbox: string; output: string }> = [];
  if (result.status !== 0) {
    const raw = `${bufferOrStringToText(result.stderr)}${bufferOrStringToText(result.stdout)}`;
    const attached = parseAttachedSandboxes(raw);
    if (attached.length > 0) {
      const recovery = recoverAttachedProvider(providerName, attached, { runOpenshell });
      recoveryFailures = recovery.failures;
      result = runOpenshell(["provider", "delete", providerName], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
      });
    }
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: bufferOrStringToText(result.stderr),
    stdout: bufferOrStringToText(result.stdout),
    recoveryFailures,
  };
}

/**
 * Emit a destroy-time residual cleanup hint when non-tolerated detach
 * failures left providers stuck attached. The hint guides the user through
 * the detach-then-delete sequence that OpenShell requires.
 */
export function emitProviderDetachResidualHint(
  sandboxName: string,
  failures: Array<{ name: string; output: string }>,
  warn?: (message: string) => void,
): void {
  if (failures.length === 0) return;
  const emit = warn ?? ((m: string) => console.warn(m));
  const names = failures.map((f) => f.name).join(", ");
  emit(`  Residual provider state may remain in the OpenShell gateway: ${names}.`);
  emit(
    `  Run 'openshell sandbox provider detach ${sandboxName} <name>' then 'openshell provider delete <name>' for each before the next onboard.`,
  );
}
