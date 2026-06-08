// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProbeContext, ProbeFn, ProbeOutcome } from "./types.ts";
import { runSandboxCmd, writeProbeEvidence } from "./util.ts";

/**
 * Probe: security.policy.enforced (`networkPolicyProbe`).
 *
 * Mirrors the deny-by-default contract from
 * test/e2e/test-network-policy.sh TC-NET-01: when no policy preset
 * widens egress for a given hostname, a request to that hostname
 * from inside the sandbox MUST be rejected by the gateway. A success
 * status is a hard failure \u2014 it means the network-policy enforcement
 * layer is not catching the request.
 *
 * Implementation: from inside the sandbox, run `curl` against a
 * non-whitelisted URL and inspect:
 *   - HTTP status code (via curl -w '%{http_code}')
 *   - curl exit code (curl exit 7 / 28 / etc. when DNS or connect
 *     is blocked outright)
 *
 * Expected outcomes:
 *   - HTTP 403   (gateway proxy rejected the request)
 *   - HTTP 4xx (any other 4xx that's not 401 \u2014 401 indicates the
 *     request reached an upstream auth wall, which counts as policy
 *     bypass, NOT block)
 *   - curl exit != 0 with HTTP code 000 (DNS / connect error) \u2014 the
 *     gateway dropped the request before HTTP could be spoken
 *
 * Anything else (HTTP 2xx, 3xx, 401) means policy is NOT enforcing
 * deny-by-default and the probe fails.
 *
 * Hostname choice: example.com is the canonical "should never be on
 * any preset" target the legacy test uses. Probes that need a
 * different fixture override via E2E_NETWORK_POLICY_BLOCKED_URL.
 */

const DEFAULT_BLOCKED_URL = "https://example.com/";
const CURL_MAX_TIME_S = 10;
const PER_CALL_SECONDS = 25;

interface NetworkPolicyEvidence {
  blockedUrl: string;
  curlExitCode: number | null;
  curlSignal: string | null;
  httpStatus: string | null;
  stdoutTail: string;
  stderrTail: string;
}

function isBlockedHttpStatus(code: string): boolean {
  if (code === "000") return true; // DNS/connect refused before HTTP
  if (code === "401") return false; // reached upstream auth -> NOT blocked
  return /^4[0-9][0-9]$/.test(code) || /^5[0-9][0-9]$/.test(code);
}

export const networkPolicyProbe: ProbeFn = async (ctx: ProbeContext): Promise<ProbeOutcome> => {
  if (!ctx.sandboxName) {
    return { status: "failed", message: "networkPolicyProbe: E2E_SANDBOX_NAME missing in context.env" };
  }
  const blockedUrl = ctx.contextEnv.E2E_NETWORK_POLICY_BLOCKED_URL || DEFAULT_BLOCKED_URL;

  // curl -sS keeps stderr informative on failure; -o /dev/null discards
  // body so the gateway's HTML reject page doesn't pollute stdout;
  // -w prints the status code we parse below.
  const result = await runSandboxCmd(
    ctx,
    [
      "curl",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      String(CURL_MAX_TIME_S),
      blockedUrl,
    ],
    { perCallSeconds: PER_CALL_SECONDS },
  );

  // curl writes the status code to stdout (or '000' on connect/DNS
  // failure). Trim whitespace; some curl builds emit a trailing
  // newline.
  const httpStatus = result.stdout.trim() || null;
  const evidence: NetworkPolicyEvidence = {
    blockedUrl,
    curlExitCode: result.exitCode,
    curlSignal: result.signal,
    httpStatus,
    stdoutTail: result.stdout,
    stderrTail: result.stderr,
  };
  writeProbeEvidence(ctx.evidencePath, evidence);

  if (result.signal === "SIGTERM") {
    return {
      status: "failed",
      classifier: "gateway-transient",
      message: `networkPolicyProbe: curl into sandbox timed out after ${PER_CALL_SECONDS}s`,
    };
  }

  // The probe accepts:
  //   - curl exit 0 with a 4xx/5xx body (gateway returned a reject)
  //   - curl exit != 0 with status '000' (gateway dropped the
  //     connection, curl never got an HTTP response)
  if (httpStatus && isBlockedHttpStatus(httpStatus)) {
    return {
      status: "passed",
      message: `networkPolicyProbe: ${blockedUrl} blocked (http_code=${httpStatus}, curl exit ${result.exitCode})`,
    };
  }
  if (result.exitCode !== 0 && (!httpStatus || httpStatus === "000")) {
    return {
      status: "passed",
      message: `networkPolicyProbe: ${blockedUrl} blocked (curl exit ${result.exitCode}, no HTTP response)`,
    };
  }
  return {
    status: "failed",
    message: `networkPolicyProbe: ${blockedUrl} reachable from sandbox (http_code=${httpStatus ?? "<empty>"}, curl exit ${result.exitCode}); deny-by-default not enforced`,
  };
};
