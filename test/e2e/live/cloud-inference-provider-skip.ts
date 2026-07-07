// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const ENDPOINT_VALIDATION_RE =
  /endpoint validation failed|failed to verify inference endpoint|Chat Completions API validation/i;
const RATE_LIMIT_OR_SANITIZED_EXTERNAL_RE =
  /HTTP 429|\b429\b|rate[- ]?limit|too many requests|quota|temporar|timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|failed to connect|error sending request|\b(redacted|sanitized)\b/i;
const CREDENTIAL_OR_AUTH_RE =
  /invalid.*(api[_-]?key|credential)|unauthorized|forbidden|HTTP 40[13]\b|\b40[13]\b/i;

export const PRE_CONTRACT_EXTERNAL_PROVIDER_SKIP_REASON =
  "external-provider-validation-unavailable-before-legacy-contract";
export const PRE_CONTRACT_EXTERNAL_PROVIDER_SOURCE_BOUNDARY =
  "external NVIDIA Endpoints provider availability";
export const PRE_CONTRACT_EXTERNAL_PROVIDER_REMOVAL_CONDITION =
  "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture";

export interface PreContractExternalProviderFailure {
  classifier: "transient-endpoint-validation" | "rate-limited-or-sanitized-endpoint-validation";
  outputTail: string;
}

export interface PreContractExternalProviderSkipEvidence {
  id: "cloud-inference";
  status: "skipped";
  reason: typeof PRE_CONTRACT_EXTERNAL_PROVIDER_SKIP_REASON;
  classifier: PreContractExternalProviderFailure["classifier"];
  phase: "install-sh-onboard";
  legacyContractStarted: false;
  installExitCode: ShellProbeResult["exitCode"];
  installTimedOut: boolean;
  outputTail: string;
  artifacts: ShellProbeResult["artifacts"];
  sourceBoundary: typeof PRE_CONTRACT_EXTERNAL_PROVIDER_SOURCE_BOUNDARY;
  removalCondition: typeof PRE_CONTRACT_EXTERNAL_PROVIDER_REMOVAL_CONDITION;
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function tailForEvidence(text: string, maxLength = 1600): string {
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

export function classifyPreContractExternalProviderFailure(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
): PreContractExternalProviderFailure | null {
  const output = resultText(result);
  if (!ENDPOINT_VALIDATION_RE.test(output)) return null;
  if (CREDENTIAL_OR_AUTH_RE.test(output)) return null;
  if (isTransientProviderValidationFailure(result)) {
    return {
      classifier: "transient-endpoint-validation",
      outputTail: tailForEvidence(output),
    };
  }
  if (RATE_LIMIT_OR_SANITIZED_EXTERNAL_RE.test(output)) {
    return {
      classifier: "rate-limited-or-sanitized-endpoint-validation",
      outputTail: tailForEvidence(output),
    };
  }
  return null;
}

export function buildPreContractExternalProviderSkipEvidence(
  install: Pick<ShellProbeResult, "exitCode" | "timedOut" | "artifacts">,
  classification: PreContractExternalProviderFailure,
): PreContractExternalProviderSkipEvidence {
  return {
    id: "cloud-inference",
    status: "skipped",
    reason: PRE_CONTRACT_EXTERNAL_PROVIDER_SKIP_REASON,
    classifier: classification.classifier,
    phase: "install-sh-onboard",
    legacyContractStarted: false,
    installExitCode: install.exitCode,
    installTimedOut: install.timedOut,
    outputTail: classification.outputTail,
    artifacts: install.artifacts,
    sourceBoundary: PRE_CONTRACT_EXTERNAL_PROVIDER_SOURCE_BOUNDARY,
    removalCondition: PRE_CONTRACT_EXTERNAL_PROVIDER_REMOVAL_CONDITION,
  };
}
