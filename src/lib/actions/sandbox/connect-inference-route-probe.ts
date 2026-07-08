// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type InferenceRouteProbeAgent = { name: string } | null;

export type ParsedInferenceRouteProbe = {
  healthy: boolean;
  broken: boolean;
  httpStatus: number;
  detail: string;
};

export type InferenceRouteFailureLabel = "unhealthy" | "unreachable";

type InferenceRouteProbeCommandResult = {
  status?: number | null;
  output?: string | null;
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
  "HTTP_CODE=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --cacert \"$CA_BUNDLE\" --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || HTTP_CODE=000",
  'case "$HTTP_CODE" in [2-4][0-9][0-9]) printf \'OK %s\' "$HTTP_CODE" ;; *) printf \'BROKEN %s\' "$HTTP_CODE" ;; esac',
].join("; ");
export const INFERENCE_ROUTE_PROBE_SCRIPT = [
  INFERENCE_ROUTE_CA_FROM_ENV,
  INFERENCE_ROUTE_CA_VALIDATION,
  INFERENCE_ROUTE_PROBE_CORE_SCRIPT,
].join("; ");
const INFERENCE_ROUTE_PROBE_FROM_ARG0_SCRIPT = [
  'CA_BUNDLE="$0"',
  INFERENCE_ROUTE_PROBE_CORE_SCRIPT,
].join("; ");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

const DCODE_INFERENCE_ROUTE_PROBE_WRAPPER = [
  INFERENCE_ROUTE_CA_FROM_ENV,
  INFERENCE_ROUTE_CA_VALIDATION,
  // bash -lc receives CA_BUNDLE as argv[0], so the inner script reads the
  // exact OpenShell-injected CA path from $0 after the login shell loads.
  `exec env ${PROXY_ENV_KEYS.map((key) => `-u ${key}`).join(" ")} HOME=/sandbox bash -lc "$1" "$CA_BUNDLE"`,
].join("; ");

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
  const command =
    agent?.name === "langchain-deepagents-code"
      ? [
          // Capture OpenShell's trusted CA before the login shell sources the
          // DCode runtime environment. The login shell still reconstructs the
          // proxy contract from /tmp/nemoclaw-proxy-env.sh after inherited
          // proxy variables are cleared.
          "sh",
          "-c",
          DCODE_INFERENCE_ROUTE_PROBE_WRAPPER,
          "nemoclaw-ca-capture",
          INFERENCE_ROUTE_PROBE_FROM_ARG0_SCRIPT,
        ]
      : ["sh", "-c", INFERENCE_ROUTE_PROBE_SCRIPT];

  return ["sandbox", "exec", "--name", sandboxName, "--", ...command];
}

/** Parse the shared route-probe output used by connect, status, and doctor. */
export function parseSandboxInferenceRouteProbeResult(
  result: InferenceRouteProbeCommandResult,
): ParsedInferenceRouteProbe {
  const rawDetail = String(result.output ?? "").trim();
  // Some OpenShell releases frame child stdout for humans. Normalize only the
  // two known frame prefixes at the beginning of the captured output.
  const detail = rawDetail.replace(/^(?:\[stdout\]|stdout:)\s*/i, "");
  const match = /^(OK|BROKEN)\s+([0-9]{3})\b/.exec(detail);
  const httpStatus = match ? Number.parseInt(match[2], 10) : 0;
  const isReachableHttpStatus = httpStatus >= 200 && httpStatus < 500;
  const commandSucceeded = result.status === 0;
  const healthy = commandSucceeded && match?.[1] === "OK" && isReachableHttpStatus;
  const broken =
    commandSucceeded && Boolean(match) && (match?.[1] === "BROKEN" || !isReachableHttpStatus);
  return {
    healthy,
    broken,
    httpStatus,
    detail: detail || `openshell sandbox exec exited with status ${String(result.status ?? 1)}`,
  };
}
