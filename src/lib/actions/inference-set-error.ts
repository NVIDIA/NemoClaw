// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import { compactText } from "../core/url-utils";
import { redact, redactFull } from "../security/redact";

const FAILURE_DETAIL_LIMIT = 2_000;
/** Bound untrusted subprocess output; classification scans this same captured window. */
export const OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER = 64 * 1024;
const PROVIDER_ERROR_SCAN_LIMIT = OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER;
const PROVIDER_QUOTES = ["'", '"', "`"] as const;

function isWordCharacter(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function containsNotFoundPhrase(value: string): boolean {
  const phrase = "not found";
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(phrase, offset);
    if (index === -1) return false;
    const before = value[index - 1];
    const after = value[index + phrase.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = index + phrase.length;
  }
  return false;
}

function startsWithNotFoundPhrase(value: string): boolean {
  let remainder = value.trimStart();
  if (remainder.startsWith("was") && !isWordCharacter(remainder["was".length])) {
    remainder = remainder.slice("was".length).trimStart();
  }
  if (!remainder.startsWith("not") || isWordCharacter(remainder["not".length])) return false;
  remainder = remainder.slice("not".length).trimStart();
  return remainder.startsWith("found") && !isWordCharacter(remainder["found".length]);
}

function lineReportsProviderNotFound(line: string, requestedProvider: string): boolean {
  for (const quote of PROVIDER_QUOTES) {
    const quotedProvider = `${quote}${requestedProvider}${quote}`;
    let offset = 0;
    while (offset < line.length) {
      const quotedIndex = line.indexOf(quotedProvider, offset);
      if (quotedIndex === -1) break;
      const prefix = line.slice(0, quotedIndex).trimEnd();
      const providerIndex = prefix.length - "provider".length;
      const charBeforeProvider = providerIndex > 0 ? prefix[providerIndex - 1] : undefined;
      const hasProviderLabel =
        providerIndex >= 0 &&
        prefix.slice(providerIndex) === "provider" &&
        !isWordCharacter(charBeforeProvider);
      if (hasProviderLabel) {
        const beforeProvider = prefix.slice(0, providerIndex);
        const afterProvider = line.slice(quotedIndex + quotedProvider.length).trimStart();
        if (containsNotFoundPhrase(beforeProvider) || startsWithNotFoundPhrase(afterProvider)) {
          return true;
        }
      }
      offset = quotedIndex + quotedProvider.length;
    }
  }
  return false;
}

/**
 * OpenShell 0.0.71 exposes provider lookup failures only as subprocess text (#5924).
 * Parse the reviewed quoted-provider shape and keep unknown or drifted output
 * generic. Remove this compatibility parser when OpenShell returns a structured
 * provider-not-found error with the missing provider as a field.
 */
export function openshellReportsProviderNotFound(
  output: string,
  requestedProvider: string,
): boolean {
  const normalizedProvider = requestedProvider.trim().toLowerCase();
  if (!normalizedProvider) return false;
  return output
    .slice(0, PROVIDER_ERROR_SCAN_LIMIT)
    .toLowerCase()
    .split("\n")
    .some((line) => lineReportsProviderNotFound(line, normalizedProvider));
}

export class InferenceSetError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InferenceSetError";
  }
}

export function buildOpenshellInferenceSetFailureMessage(args: {
  exitCode: number;
  providerNotFound: boolean;
  registeredProviders?: readonly string[];
  stderr: string;
  stdout: string;
}): string {
  // Fully mask token patterns first, then use `redact()` only for URL userinfo and
  // query forms absent from `redactFull`; no secret prefix survives an intermediate.
  const detail = compactText(redact(redactFull(`${args.stderr}\n${args.stdout}`))).slice(
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
