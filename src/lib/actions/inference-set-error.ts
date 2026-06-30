// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import { compactText } from "../core/url-utils";
import { redactFull } from "../security/redact";

const OPEN_SHELL_PROVIDER_NOT_FOUND_PATTERNS = [
  /\bprovider\s+["'`]([^"'`\r\n]+)["'`]\s+(?:was\s+)?not found\b/iu,
  /\bnot found\b[^\r\n]*\bprovider\s+["'`]([^"'`\r\n]+)["'`]/iu,
];

const FAILURE_DETAIL_LIMIT = 500;

/**
 * OpenShell 0.0.71 exposes provider lookup failures only as subprocess text.
 * Parse the reviewed quoted-provider shape and keep unknown or drifted output
 * generic. Remove this compatibility parser when OpenShell returns a structured
 * provider-not-found error with the missing provider as a field.
 */
export function openshellReportsProviderNotFound(
  output: string,
  requestedProvider: string,
): boolean {
  const missingProvider = OPEN_SHELL_PROVIDER_NOT_FOUND_PATTERNS.map(
    (pattern) => output.match(pattern)?.[1]?.trim() ?? null,
  ).find((candidate): candidate is string => candidate !== null);
  return missingProvider === requestedProvider;
}

export function buildOpenshellInferenceSetFailureMessage(args: {
  exitCode: number;
  providerNotFound: boolean;
  registeredProviders?: readonly string[];
  stderr: string;
  stdout: string;
}): string {
  const detail = compactText(redactFull(`${args.stderr}\n${args.stdout}`)).slice(
    0,
    FAILURE_DETAIL_LIMIT,
  );
  const base = `OpenShell inference route update failed with exit ${args.exitCode}.`;
  const detailLine = detail ? `\nOpenShell detail: ${detail}` : "";
  if (!args.providerNotFound) return `${base}${detailLine}`;

  const providerLine =
    args.registeredProviders === undefined
      ? ""
      : args.registeredProviders.length > 0
        ? `\nRegistered providers: ${args.registeredProviders.join(", ")}`
        : "\nNo providers registered";
  return `${base}${detailLine}${providerLine}\nTip: register a new provider with \`${CLI_NAME} onboard\`.`;
}
