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
  "NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
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
    case "mcporter": {
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
