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
  "HTTP_CODE=$(/usr/bin/curl -q -s -o /dev/null -w '%{http_code}' --cacert \"$CA_BUNDLE\" --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || HTTP_CODE=000",
  'case "$HTTP_CODE" in [2-4][0-9][0-9]) printf \'OK %s\' "$HTTP_CODE" ;; *) printf \'BROKEN %s\' "$HTTP_CODE" ;; esac',
].join("; ");
export const INFERENCE_ROUTE_PROBE_SCRIPT = [
  INFERENCE_ROUTE_CA_FROM_ENV,
  INFERENCE_ROUTE_CA_VALIDATION,
  INFERENCE_ROUTE_PROBE_CORE_SCRIPT,
].join("; ");
const DCODE_PROXY_HOST_FILE = "/usr/local/share/nemoclaw/dcode-proxy-host";
const DCODE_PROXY_PORT_FILE = "/usr/local/share/nemoclaw/dcode-proxy-port";
const DCODE_PROXY_UNAVAILABLE =
  "UNAVAILABLE managed DCode proxy files are missing, unsafe, or invalid";
const DCODE_INFERENCE_ROUTE_PROBE_SCRIPT = [
  INFERENCE_ROUTE_CA_FROM_ENV,
  INFERENCE_ROUTE_CA_VALIDATION,
  `PROXY_HOST_FILE="${DCODE_PROXY_HOST_FILE}"`,
  `PROXY_PORT_FILE="${DCODE_PROXY_PORT_FILE}"`,
  `[ -f "$PROXY_HOST_FILE" ] && [ ! -L "$PROXY_HOST_FILE" ] && [ "$(/usr/bin/stat -c '%u:%a' "$PROXY_HOST_FILE" 2>/dev/null)" = "0:444" ] && [ -f "$PROXY_PORT_FILE" ] && [ ! -L "$PROXY_PORT_FILE" ] && [ "$(/usr/bin/stat -c '%u:%a' "$PROXY_PORT_FILE" 2>/dev/null)" = "0:444" ] || { printf '${DCODE_PROXY_UNAVAILABLE}'; exit 1; }`,
  `PROXY_HOST=$(/usr/bin/cat "$PROXY_HOST_FILE") || { printf '${DCODE_PROXY_UNAVAILABLE}'; exit 1; }`,
  `PROXY_PORT=$(/usr/bin/cat "$PROXY_PORT_FILE") || { printf '${DCODE_PROXY_UNAVAILABLE}'; exit 1; }`,
  `case "$PROXY_HOST" in ""|*[!A-Za-z0-9._-]*) printf '${DCODE_PROXY_UNAVAILABLE}'; exit 1 ;; esac`,
  `case "$PROXY_PORT" in ""|*[!0-9]*) printf '${DCODE_PROXY_UNAVAILABLE}'; exit 1 ;; esac`,
  `[ "$PROXY_PORT" -ge 1 ] 2>/dev/null && [ "$PROXY_PORT" -le 65535 ] 2>/dev/null || { printf '${DCODE_PROXY_UNAVAILABLE}'; exit 1; }`,
  'PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
  'export HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" http_proxy="$PROXY_URL" https_proxy="$PROXY_URL"',
  'export NO_PROXY="localhost,127.0.0.1,::1,${PROXY_HOST}" no_proxy="localhost,127.0.0.1,::1,${PROXY_HOST}"',
  "unset ALL_PROXY all_proxy OPENAI_PROXY",
  INFERENCE_ROUTE_PROBE_CORE_SCRIPT,
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
          // Do not run a login shell: sandbox-writable startup files can write
          // to every inherited descriptor. Reconstruct only the required proxy
          // route from immutable image files before running the fixed probe.
          "sh",
          "-c",
          DCODE_INFERENCE_ROUTE_PROBE_SCRIPT,
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
  // A trusted probe emits one result line. Reject preambles or extra lines so
  // shell startup output can never be mistaken for the authoritative result.
  const match = /^(OK|BROKEN)\s+([0-9]{3})\b[^\r\n]*$/.exec(detail);
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
