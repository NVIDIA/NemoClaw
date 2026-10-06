// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";

/** Quote one argument for an MCP bridge-owned shell command. */
export const quoteMcpBridgeShellArg = shellQuote;

/**
 * Process-control variables that must not reach a credential-bearing child
 * diagnostic. Trusted proxy and CA variables remain available; OpenShell
 * injects the managed MCP credential at the policy boundary, and the discovery
 * runtime never accepts a credential or Authorization header as input.
 */
export const MCP_RUNTIME_SANITIZED_ENV_VARS = [
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOCPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "SSLKEYLOGFILE",
] as const;

function unsupportedAdapter(adapter: never): never {
  throw new Error(`Unsupported MCP adapter: ${String(adapter)}`);
}

export interface McpAdapterHttpProbeRequest {
  authorization: string;
  body: string;
  httpMarker: string;
  timeoutSeconds: number;
  url: string;
}

/**
 * OpenShell attributes CONNECT to `/proc/<pid>/exe` of the socket owner.
 * Credential-bound MCP policy therefore allows only the selected adapter
 * runtime. The probe must open the socket from that runtime; a curl child
 * would either be denied or require widening the persistent allowlist.
 * Emit the status after headers arrive, then cancel or close the body
 * without reading it.
 */
export function mcpAdapterHttpProbeSource(
  adapter: AgentMcpAdapter,
  request: McpAdapterHttpProbeRequest,
): string {
  switch (adapter) {
    case "openclaw-config":
      return [
        `const url = ${JSON.stringify(request.url)};`,
        `const authorization = ${JSON.stringify(request.authorization)};`,
        `const httpMarker = ${JSON.stringify(request.httpMarker)};`,
        `const body = ${JSON.stringify(request.body)};`,
        `const timeoutMs = ${String(request.timeoutSeconds * 1000)};`,
        "function fail(err) {",
        '  const text = [err, err && err.message, err && err.cause, err && err.cause && err.cause.message].map(String).join("\\n");',
        '  process.stderr.write(text + "\\n");',
        "  process.exitCode = /timed out|timeout|aborted/i.test(text) ? 28 : 56;",
        "}",
        "fetch(url, {",
        '  method: "POST",',
        '  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization },',
        "  body,",
        '  redirect: "manual",',
        "  signal: AbortSignal.timeout(timeoutMs),",
        "}).then(async (res) => {",
        '  process.stdout.write("\\n" + httpMarker + String(res.status) + "\\n");',
        "  try { await res.body?.cancel(); } catch {}",
        "  process.exitCode = 0;",
        "}, fail);",
      ].join("\n");
    case "hermes-config":
    case "deepagents-config":
      return [
        "import sys, urllib.error, urllib.request",
        `url = ${JSON.stringify(request.url)}`,
        `authorization = ${JSON.stringify(request.authorization)}`,
        `http_marker = ${JSON.stringify(request.httpMarker)}`,
        `body = ${JSON.stringify(request.body)}`,
        `timeout = ${String(request.timeoutSeconds)}`,
        "class NoRedirect(urllib.request.HTTPRedirectHandler):",
        "    def redirect_request(self, *args):",
        "        return None",
        "opener = urllib.request.build_opener(NoRedirect)",
        "req = urllib.request.Request(url, data=body.encode('utf-8'), method='POST', headers={'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': authorization})",
        "try:",
        "    with opener.open(req, timeout=timeout) as resp:",
        "        sys.stdout.write('\\n%s%s\\n' % (http_marker, resp.status))",
        "        resp.close()",
        "        raise SystemExit(0)",
        "except urllib.error.HTTPError as err:",
        "    try:",
        "        sys.stdout.write('\\n%s%s\\n' % (http_marker, err.code))",
        "    finally:",
        "        try:",
        "            err.close()",
        "        except Exception:",
        "            pass",
        "    raise SystemExit(0)",
        "except Exception as err:",
        "    reason = getattr(err, 'reason', err)",
        "    text = '%s %s' % (err, reason)",
        "    sys.stderr.write(text + '\\n')",
        "    raise SystemExit(28 if 'timed out' in text.lower() or 'timeout' in text.lower() else 56)",
      ].join("\n");
    default:
      return unsupportedAdapter(adapter);
  }
}

/**
 * Launch the selected adapter runtime as the HTTP client. The returned command
 * does not spawn curl; OpenShell therefore attributes the CONNECT socket to
 * the same executable the generated MCP policy already allows.
 */
export function buildMcpAdapterHttpProbeCommand(
  adapter: AgentMcpAdapter,
  request: McpAdapterHttpProbeRequest,
): string {
  const source = mcpAdapterHttpProbeSource(adapter, request);
  switch (adapter) {
    case "openclaw-config":
      return `nemoclaw-start node -e ${shellQuote(source)}`;
    case "hermes-config":
      return `/opt/hermes/.venv/bin/python -I -c ${shellQuote(source)}`;
    case "deepagents-config":
      return `/opt/venv/bin/python3 -I -c ${shellQuote(source)}`;
    default:
      return unsupportedAdapter(adapter);
  }
}

/**
 * OpenShell binds generated MCP policies to the configured adapter executable
 * and its process ancestry. Keep that runtime as the parent of a shared child
 * command instead of implementing the wire operation separately per adapter.
 */
export function wrapMcpRuntimeCommand(
  adapter: AgentMcpAdapter,
  command: readonly string[],
): string {
  const quotedCommand = command.map(shellQuote).join(" ");
  switch (adapter) {
    case "openclaw-config": {
      const runner =
        'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1);';
      return `nemoclaw-start node -e ${shellQuote(runner)} ${quotedCommand}`;
    }
    case "hermes-config": {
      const runner =
        "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
      return `/opt/hermes/.venv/bin/python -I -c ${shellQuote(runner)} ${quotedCommand}`;
    }
    case "deepagents-config": {
      const runner =
        "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
      return `/opt/venv/bin/python3 -I -c ${shellQuote(runner)} ${quotedCommand}`;
    }
    default:
      return unsupportedAdapter(adapter);
  }
}
