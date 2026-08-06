// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactSensitiveText } from "../../security/redact";

export type InferenceRouteProbeAgent = { name: string } | null;

export type ParsedInferenceRouteProbe = {
  healthy: boolean;
  broken: boolean;
  httpStatus: number;
  curlExitCode: number | null;
  tlsVerifyResult: number | null;
  canonicalCurlExitCode: number | null;
  canonicalHttpStatus: number | null;
  canonicalTlsVerifyResult: number | null;
  detail: string;
};

export type InferenceRouteFailureLabel = "unhealthy" | "unreachable";

type InferenceRouteProbeCommandResult = {
  status?: number | null;
  output?: string | null;
  stderr?: string | null;
};

// OpenShell injects the per-sandbox trust bundle into each exec process. Pass
// that exact path explicitly because curl backend support for the CA env names
// is not uniform across agent images.
const INFERENCE_ROUTE_CA_FROM_ENV = 'CA_BUNDLE="${CURL_CA_BUNDLE:-${SSL_CERT_FILE:-}}"';
// A missing OpenShell-managed CA means the probe boundary is unavailable, not
// that inference.local is known broken. Keep the marker outside the trusted
// OK/BROKEN grammar so connect cannot authorize repair from this evidence.
const INFERENCE_ROUTE_CA_VALIDATION =
  '[ -n "$CA_BUNDLE" ] && [ -f "$CA_BUNDLE" ] && [ -r "$CA_BUNDLE" ] || { printf \'UNAVAILABLE OpenShell CA bundle missing or unreadable\'; exit 1; }';
const INFERENCE_ROUTE_PROBE_CORE_SCRIPT = [
  "CURL_EXIT=0",
  "CURL_RESULT=$(/usr/bin/curl -q -s -o /dev/null -w '%{http_code} %{ssl_verify_result}' --cacert \"$CA_BUNDLE\" --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || CURL_EXIT=$?",
  'HTTP_CODE="${CURL_RESULT%% *}"',
  'TLS_VERIFY_RESULT="${CURL_RESULT#* }"',
  'HTTP_CODE="${HTTP_CODE:-000}"',
  'case "$TLS_VERIFY_RESULT" in ""|*[!0-9]*) TLS_VERIFY_RESULT=0 ;; esac',
  'CANONICAL_DETAIL=""',
  'if [ "$CURL_EXIT" -eq 60 ] && [ -r /etc/openshell-tls/ca-bundle.pem ]; then CANONICAL_CURL_EXIT=0; CANONICAL_RESULT=$(/usr/bin/curl -q -s -o /dev/null -w \'%{http_code} %{ssl_verify_result}\' --cacert /etc/openshell-tls/ca-bundle.pem --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || CANONICAL_CURL_EXIT=$?; CANONICAL_HTTP_CODE="${CANONICAL_RESULT%% *}"; CANONICAL_TLS_VERIFY="${CANONICAL_RESULT#* }"; case "$CANONICAL_HTTP_CODE" in [0-9][0-9][0-9]) ;; *) CANONICAL_HTTP_CODE=000 ;; esac; case "$CANONICAL_TLS_VERIFY" in ""|*[!0-9]*) CANONICAL_TLS_VERIFY=0 ;; esac; CANONICAL_DETAIL=" canonical_curl_exit=$CANONICAL_CURL_EXIT canonical_http=$CANONICAL_HTTP_CODE canonical_tls_verify=$CANONICAL_TLS_VERIFY"; fi',
  'case "$HTTP_CODE" in [2-4][0-9][0-9]) printf \'OK %s\' "$HTTP_CODE" ;; *) printf \'BROKEN %s curl_exit=%s tls_verify=%s%s\' "$HTTP_CODE" "$CURL_EXIT" "$TLS_VERIFY_RESULT" "$CANONICAL_DETAIL" ;; esac',
].join("; ");
export const INFERENCE_ROUTE_PROBE_SCRIPT = [
  INFERENCE_ROUTE_CA_FROM_ENV,
  INFERENCE_ROUTE_CA_VALIDATION,
  INFERENCE_ROUTE_PROBE_CORE_SCRIPT,
].join("; ");
// Invalid state: a DCode login shell runs sandbox-user startup files before the
// probe, so every inherited output descriptor is attacker-writable evidence.
// Source boundary: the image-baked launcher reconstructs the managed proxy from
// root-owned, mode-0444 files and execs a command without loading user profiles.
// Source-fix constraint: raw OpenShell exec does not inherit the entrypoint's
// trusted proxy contract, while a login shell cannot provide an output trust
// boundary. Regression: hostile-profile tests assert that no startup file or
// inherited descriptor can emit probe evidence. Removal condition: use a raw
// probe only when OpenShell provides the same trusted proxy environment to every
// sandbox exec process without shell startup.
// This separate regular-file install is intentionally absent from older images:
// a newer CLI probing one fails before the stateful entrypoint or dcode wrapper
// can run, so version skew cannot mutate observability state.
export const DCODE_MANAGED_EXEC_LAUNCHER = "/usr/local/lib/nemoclaw/dcode-managed-exec";
export const DCODE_MANAGED_EXEC_MISSING_DETAIL =
  "trusted Deep Agents Code route-probe helper is missing; rebuild this sandbox with the updated NemoClaw image before retrying connect, status, or doctor";

export function isDcodeManagedExecMissingDetail(detail: string): boolean {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized === DCODE_MANAGED_EXEC_MISSING_DETAIL) return true;
  return (
    normalized.includes(DCODE_MANAGED_EXEC_LAUNCHER) &&
    /\b(?:not found|no such file|does not exist|cannot stat|stat .* failed)\b/i.test(normalized)
  );
}

function formatUntrustedProbeDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (isDcodeManagedExecMissingDetail(normalized)) return DCODE_MANAGED_EXEC_MISSING_DETAIL;
  return redactSensitiveText(normalized) ?? "";
}

/**
 * Classify a route result that is already known not to be healthy.
 * Final HTTP 200-499 responses are handled as reachable before this helper is
 * called; passing one here is outside the helper's contract.
 */
export function classifyInferenceRouteFailureLabel(httpStatus: number): InferenceRouteFailureLabel {
  return httpStatus >= 500 && httpStatus < 600 ? "unhealthy" : "unreachable";
}

export function buildSandboxInferenceRouteProbeArgs(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
): string[] {
  if (agent?.name === "langchain-deepagents-code") {
    return [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--no-tty",
      "--env",
      "HOME=/usr/local/lib/nemoclaw",
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      "--",
      // The trusted launcher ignores ambient proxy overrides and does not
      // source sandbox-user startup files or rewrite persistent runtime
      // state before executing this probe.
      DCODE_MANAGED_EXEC_LAUNCHER,
      "/bin/sh",
      "-c",
      INFERENCE_ROUTE_PROBE_SCRIPT,
    ];
  }

  return ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", INFERENCE_ROUTE_PROBE_SCRIPT];
}

/** Parse the shared route-probe output used by connect, status, and doctor. */
export function parseSandboxInferenceRouteProbeResult(
  result: InferenceRouteProbeCommandResult,
  { allowCanonicalCa = false }: { allowCanonicalCa?: boolean } = {},
): ParsedInferenceRouteProbe {
  const stderr = String(result.stderr ?? "").trim();
  if (stderr) {
    return {
      healthy: false,
      broken: false,
      httpStatus: 0,
      curlExitCode: null,
      tlsVerifyResult: null,
      canonicalCurlExitCode: null,
      canonicalHttpStatus: null,
      canonicalTlsVerifyResult: null,
      detail: formatUntrustedProbeDetail(stderr),
    };
  }
  const rawDetail = String(result.output ?? "").trim();
  // Some OpenShell releases frame child stdout for humans. Normalize only the
  // two known frame prefixes at the beginning of the captured output.
  const detail = rawDetail.replace(/^(?:\[stdout\]|stdout:)\s*/i, "");
  // A trusted probe emits one result line. Reject preambles or extra lines so
  // shell startup output can never be mistaken for the authoritative result.
  const match = /^(OK|BROKEN)\s+([0-9]{3})\b[^\r\n]*$/.exec(detail);
  const primaryHttpStatus = match ? Number.parseInt(match[2], 10) : 0;
  const curlExitMatch = /\bcurl_exit=([0-9]{1,3})\b/u.exec(detail);
  const curlExitCode = curlExitMatch ? Number.parseInt(curlExitMatch[1], 10) : null;
  const tlsVerifyMatch = /\btls_verify=([0-9]{1,4})\b/u.exec(detail);
  const tlsVerifyResult = tlsVerifyMatch ? Number.parseInt(tlsVerifyMatch[1], 10) : null;
  const canonicalCurlExitMatch = /\bcanonical_curl_exit=([0-9]{1,3})\b/u.exec(detail);
  const canonicalCurlExitCode = canonicalCurlExitMatch
    ? Number.parseInt(canonicalCurlExitMatch[1], 10)
    : null;
  const canonicalHttpMatch = /\bcanonical_http=([0-9]{3})\b/u.exec(detail);
  const canonicalHttpStatus = canonicalHttpMatch
    ? Number.parseInt(canonicalHttpMatch[1], 10)
    : null;
  const canonicalTlsVerifyMatch = /\bcanonical_tls_verify=([0-9]{1,4})\b/u.exec(detail);
  const canonicalTlsVerifyResult = canonicalTlsVerifyMatch
    ? Number.parseInt(canonicalTlsVerifyMatch[1], 10)
    : null;
  const canonicalVerified =
    allowCanonicalCa &&
    canonicalCurlExitCode === 0 &&
    canonicalTlsVerifyResult === 0 &&
    canonicalHttpStatus !== null;
  const httpStatus = canonicalVerified ? canonicalHttpStatus : primaryHttpStatus;
  const isReachableHttpStatus = httpStatus >= 200 && httpStatus < 500;
  const commandSucceeded = result.status === 0;
  const healthy =
    commandSucceeded && isReachableHttpStatus && (match?.[1] === "OK" || canonicalVerified);
  const broken =
    commandSucceeded &&
    !healthy &&
    Boolean(match) &&
    (match?.[1] === "BROKEN" || !isReachableHttpStatus);
  const trustedDetail = !healthy && !broken ? formatUntrustedProbeDetail(detail) : detail;
  return {
    healthy,
    broken,
    httpStatus,
    curlExitCode,
    tlsVerifyResult,
    canonicalCurlExitCode,
    canonicalHttpStatus,
    canonicalTlsVerifyResult,
    detail:
      trustedDetail || `openshell sandbox exec exited with status ${String(result.status ?? 1)}`,
  };
}
