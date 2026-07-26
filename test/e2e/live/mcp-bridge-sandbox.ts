// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const MCP_CURL_HTTP_CODE_MARKER = "NEMOCLAW_MCP_CURL_HTTP_CODE=";

export type McpDnsRebindingAdapter = "mcporter" | "hermes-config" | "deepagents-config";

export async function hostAddressForSandbox(_host: HostCliClient): Promise<string> {
  return "host.openshell.internal";
}

/** Concrete runner address used only to simulate a post-validation DNS rebind. */
export async function hostPrivateAddressForSandbox(host: HostCliClient): Promise<string> {
  const probe = await host.command(
    "bash",
    [
      "-lc",
      [
        'ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk \'{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}\')"',
        'if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "ip_addr=\"$(hostname -I 2>/dev/null | awk '{print $1}')\"",
        'if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "echo 127.0.0.1",
      ].join("\n"),
    ],
    {
      artifactName: "host-private-ip-for-mcp-rebinding",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  return probe.stdout.trim().split(/\s+/)[0] || "127.0.0.1";
}

export {
  type DnsRebindingHostsFixture,
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./dns-rebinding-hosts-fixture.ts";

/**
 * Accept the two fail-closed shapes OpenShell can expose for a denied HTTPS
 * request: an L7 HTTP 403, or curl's exit 56 for a CONNECT-level proxy 403.
 */
export function isExpectedMcpCurlPolicyDenial(
  result: Pick<ShellProbeResult, "exitCode" | "stderr" | "stdout" | "timedOut">,
): boolean {
  if (result.timedOut) return false;

  const httpCode = result.stdout.match(
    new RegExp(`^${MCP_CURL_HTTP_CODE_MARKER}([0-9]{3})$`, "m"),
  )?.[1];
  if (result.exitCode === 0) return httpCode === "403";

  return (
    result.exitCode === 56 &&
    /curl:\s*\(56\)\s*CONNECT tunnel failed,\s*response 403/i.test(result.stderr)
  );
}

/**
 * Build an MCP request whose curl child retains the selected adapter runtime
 * as an ancestor. OpenShell v0.0.85 attributes policy to /proc/<pid>/exe and
 * ancestors, so this exercises the same unavoidable Node/Python identity used
 * by the corresponding adapter instead of an unrelated curl-only identity.
 *
 * Pinned upstream source contract:
 * NVIDIA/OpenShell@3dee5570a46076a57a3b056f35f35ebc0861ac85,
 * crates/openshell-supervisor-network/src/proxy.rs:2648-2674 resolves once,
 * :2699-2739 and :2794-2803 validate and return that same address list,
 * and :1079-1081 passes it directly to TcpStream::connect.
 */
export function buildMcpDnsRebindingProbeScript(
  adapter: McpDnsRebindingAdapter,
  targetUrl: string,
  credentialKey: string,
): string {
  const fileStem = `/tmp/nemoclaw-mcp-rebinding-${adapter}`;
  const responsePath = `${fileStem}.body`;
  const stdoutPath = `${fileStem}.stdout`;
  const stderrPath = `${fileStem}.stderr`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const curlArgs = [
    "curl",
    "-sS",
    "--max-time",
    "30",
    "-o",
    responsePath,
    "-w",
    `${MCP_CURL_HTTP_CODE_MARKER}%{http_code}\n`,
    "-X",
    "POST",
    targetUrl,
    "-H",
    "content-type: application/json",
    "-H",
    `authorization: Bearer openshell:resolve:env:${credentialKey}`,
    "--data-binary",
    body,
  ];
  const quotedCurl = curlArgs.map(shellQuote).join(" ");
  const runtimeCommand = (() => {
    switch (adapter) {
      case "mcporter": {
        const runner =
          'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1);';
        return `nemoclaw-start node -e ${shellQuote(runner)} ${quotedCurl}`;
      }
      case "hermes-config": {
        const runner =
          "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
        return `/opt/hermes/.venv/bin/python -c ${shellQuote(runner)} ${quotedCurl}`;
      }
      case "deepagents-config": {
        const runner =
          "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
        return `/opt/venv/bin/python3 -c ${shellQuote(runner)} ${quotedCurl}`;
      }
    }
  })();

  return [
    "set -u",
    `rm -f ${shellQuote(responsePath)} ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)}`,
    "set +e",
    `${runtimeCommand} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`,
    "probe_rc=$?",
    "set -e",
    `cat ${shellQuote(responsePath)} 2>/dev/null || true`,
    `cat ${shellQuote(stdoutPath)} 2>/dev/null || true`,
    `cat ${shellQuote(stderrPath)} >&2 2>/dev/null || true`,
    'exit "$probe_rc"',
  ].join("\n");
}
