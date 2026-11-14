// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resultText } from "./clients/command.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

const MCP_CURL_HTTP_CODE_MARKER = "NEMOCLAW_MCP_CURL_HTTP_CODE=";
export const INFERENCE_CURL_HTTP_CODE_MARKER = "NEMOCLAW_INFERENCE_CURL_HTTP_CODE=";

/** Keep connect errors while withholding verbose outgoing headers from artifacts. */
export const INFERENCE_CURL_DIAGNOSTIC_SCRIPT = `curl() (
  probe_stderr=$(mktemp) || exit 2
  trap 'rm -f "$probe_stderr"' EXIT
  LC_ALL=C command curl --verbose --write-out '\n${INFERENCE_CURL_HTTP_CODE_MARKER}%{http_code}\n' "$@" 2>"$probe_stderr"
  probe_status=$?
  sed -n '/^\\* Immediate connect fail for /p; /^\\* connect to .* failed: /p; /^curl: /p' "$probe_stderr" >&2
  exit "$probe_status"
)`;

/**
 * Require a policy response or curl's explicit connect permission error.
 * Exit 7 alone also represents refused connections and is not denial evidence.
 */
export function isExpectedMcpCurlPolicyDenial(
  result: Pick<ShellProbeResult, "exitCode" | "stderr" | "stdout" | "timedOut">,
  httpCodeMarker = MCP_CURL_HTTP_CODE_MARKER,
  connectDeniedHttpCode: "000" | "302" = "000",
): boolean {
  if (result.timedOut) return false;

  const records = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(httpCodeMarker));
  if (records.length !== 1) return false;
  const httpCode = records[0]?.slice(httpCodeMarker.length);
  if (result.exitCode === 0) {
    return httpCode === "403" && /policy[_ ]denied|not allowed by any policy/iu.test(result.stdout);
  }
  // A followed redirect retains its last response code when the next connect is denied.
  if (result.exitCode === 7 && httpCode === connectDeniedHttpCode) {
    // curl 8.14.1 cf-socket.c reports connect(2)'s errno here. Require every
    // attempted address to fail with EACCES, not a mixed transport failure.
    const failures = result.stderr
      .split(/\r?\n/u)
      .filter(
        (line) =>
          line.startsWith("* Immediate connect fail for ") ||
          (line.startsWith("* connect to ") && line.includes(" failed: ")),
      );
    return (
      failures.length > 0 &&
      failures.every((line) =>
        /^\* Immediate connect fail for [0-9a-f:.]+: Permission denied$/iu.test(line),
      )
    );
  }

  return (
    result.exitCode === 56 &&
    /curl:\s*\(56\)\s*CONNECT tunnel failed,\s*response 403/i.test(result.stderr)
  );
}

type DnsDenialProbe = Pick<
  ShellProbeResult,
  "exitCode" | "stdout" | "stderr" | "signal" | "timedOut"
>;

export function isExpectedMcpDnsPolicyDenial(
  result: DnsDenialProbe,
  before: DnsDenialProbe,
  after: DnsDenialProbe,
  hostname: string,
  httpCodeMarker = MCP_CURL_HTTP_CODE_MARKER,
  connectDeniedHttpCode: "000" | "302" = "000",
): boolean {
  const lines = result.stdout.split(/\r?\n/u);
  const codes = lines.filter((line) => line.startsWith(httpCodeMarker));
  const locations = lines.filter((line) => /^location:/iu.test(line));
  const location = locations[0]?.slice("location:".length).trim() ?? "";
  const expectedResponse =
    connectDeniedHttpCode === "000"
      ? result.stdout.trim() === `${httpCodeMarker}000`
      : codes.length === 1 &&
        codes[0] === `${httpCodeMarker}302` &&
        /^HTTP\/1\.[01] 302 /mu.test(result.stdout) &&
        locations.length === 1 &&
        URL.canParse(location) &&
        new URL(location).hostname === hostname;
  if (
    result.timedOut ||
    result.signal !== null ||
    result.exitCode !== 6 ||
    !expectedResponse ||
    !result.stderr.split(/\r?\n/u).includes(`curl: (6) Could not resolve host: ${hostname}`) ||
    [before, after].some((logs) => logs.timedOut || logs.signal !== null || logs.exitCode !== 0)
  )
    return false;
  // OpenShell 0.1.3 filters resolved addresses before issuing a synthetic DNS
  // answer. Curl exit 6 alone cannot distinguish that denial from broken DNS.
  const events = ["policy_dns_no_valid_address", "policy_dns_ineligible"].map(
    (reason) => `NET:REFUSE [MED] DENIED ${hostname} [reason:${reason}]`,
  );
  const previous = new Set(resultText(before).split(/\r?\n/u));
  return resultText(after)
    .split(/\r?\n/u)
    .some((line) => events.some((event) => line.endsWith(event)) && !previous.has(line));
}

/** Confirm one request; only repeat audit reads while its DNS refusal reaches the gateway. */
export async function waitForMcpCurlPolicyDenial(
  result: DnsDenialProbe,
  before: DnsDenialProbe,
  readDnsAudit: (suffix: string) => Promise<DnsDenialProbe>,
  hostname: string,
  httpCodeMarker = MCP_CURL_HTTP_CODE_MARKER,
  connectDeniedHttpCode: "000" | "302" = "000",
): Promise<boolean> {
  let policyDenied = isExpectedMcpCurlPolicyDenial(result, httpCodeMarker, connectDeniedHttpCode);
  for (let attempt = 1; !policyDenied && result.exitCode === 6 && attempt <= 5; attempt += 1) {
    policyDenied = isExpectedMcpDnsPolicyDenial(
      result,
      before,
      await readDnsAudit(`after-${attempt}`),
      hostname,
      httpCodeMarker,
      connectDeniedHttpCode,
    );
    if (!policyDenied && attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return policyDenied;
}
