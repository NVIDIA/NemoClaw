// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../runner";
import { executeSandboxExecCommand, type SandboxCommandResult } from "./process-recovery";

export type RebuildWebSearchPreflightResult = { ok: true } | { ok: false; detail: string };

export type RebuildWebSearchPreflightDeps = {
  execute?: (sandboxName: string, command: string, timeout?: number) => SandboxCommandResult | null;
};

const BRAVE_CREDENTIAL_PLACEHOLDER = "openshell:resolve:env:BRAVE_API_KEY";

export function buildRebuildBraveSearchProbeCommand(): string {
  const endpoint = shellQuote("https://api.search.brave.com/res/v1/web/search");
  const header = shellQuote(`X-Subscription-Token: ${BRAVE_CREDENTIAL_PLACEHOLDER}`);
  return [
    "out=$(mktemp)",
    "trap 'rm -f \"$out\"' EXIT",
    `code=$(curl -sS --compressed --connect-timeout 5 --max-time 30 -G -o \"$out\" -w '%{http_code}' -H ${header} --data-urlencode q=ping --data-urlencode count=1 ${endpoint}) || { rc=$?; printf 'curl-error:%s\\n' \"$rc\"; head -c 512 \"$out\"; exit \"$rc\"; }`,
    "printf '%s\\n' \"$code\"",
    'head -c 512 "$out"',
    'case "$code" in 2??) exit 0 ;; *) exit 1 ;; esac',
  ].join("; ");
}

/**
 * Exercise the retained Brave provider from the still-running sandbox. The
 * literal OpenShell placeholder is rewritten by the gateway, so this proves
 * the gateway-held credential without reading or rotating a host-side key.
 */
export function preflightRebuildBraveSearchRoute(
  sandboxName: string,
  deps: RebuildWebSearchPreflightDeps = {},
): RebuildWebSearchPreflightResult {
  const execute = deps.execute ?? executeSandboxExecCommand;
  const result = execute(sandboxName, buildRebuildBraveSearchProbeCommand(), 40_000);
  if (result?.status === 0) return { ok: true };
  if (!result) return { ok: false, detail: "existing sandbox Brave Search probe was unavailable" };
  const httpStatus = result.stdout.match(/(?:^|\n)(\d{3})(?:\n|$)/)?.[1] ?? null;
  return {
    ok: false,
    detail: httpStatus
      ? `existing sandbox Brave Search probe returned HTTP ${httpStatus}`
      : `existing sandbox Brave Search probe exited with status ${result.status}`,
  };
}
