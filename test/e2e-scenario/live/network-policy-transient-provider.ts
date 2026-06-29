// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const TRANSIENT_PROVIDER_VALIDATION_RE =
  /endpoint validation failed|failed to verify inference endpoint|Chat Completions API validation/i;
const TRANSIENT_PROVIDER_DETAIL_RE =
  /timed? out|timeout|curl failed \(exit (7|28|35|52|56)\)|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|failed to connect|error sending request|HTTP (429|502|503|504)|returned HTTP (429|502|503|504)|too many requests|rate[- ]?limit|quota|temporar/i;
const LOCAL_VALIDATION_FAILURE_RE =
  /invalid .*credential|invalid .*api[_ -]?key|authorization failed|authentication failed|denied by network policy|policy .*failed|routing .*failed|route .*failed|proxy .*failed|hop-by-hop|header stripping/i;

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function isTransientProviderValidationFailure(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
): boolean {
  const output = resultText(result);
  return (
    TRANSIENT_PROVIDER_VALIDATION_RE.test(output) &&
    TRANSIENT_PROVIDER_DETAIL_RE.test(output) &&
    !LOCAL_VALIDATION_FAILURE_RE.test(output)
  );
}
