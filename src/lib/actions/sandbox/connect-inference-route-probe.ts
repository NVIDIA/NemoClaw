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
const DCODE_MANAGED_EXEC_LAUNCHER = "/usr/local/lib/nemoclaw/dcode-managed-exec";

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
          // The trusted launcher ignores ambient proxy overrides and does not
          // source sandbox-user startup files or rewrite persistent runtime
          // state before executing this probe.
          DCODE_MANAGED_EXEC_LAUNCHER,
          "/bin/sh",
          "-c",
          INFERENCE_ROUTE_PROBE_SCRIPT,
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
