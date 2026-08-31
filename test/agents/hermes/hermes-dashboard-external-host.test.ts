// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCH = path.join(ROOT, "agents", "hermes", "dashboard-external-host.patch");
const EXTERNAL_HOST_HELPER = path.join(ROOT, "agents", "hermes", "dashboard-external-host.sh");
const EXTERNAL_HOST_ENV = "_NEMOCLAW_HERMES_DASHBOARD_EXTERNAL_HOST";

const UPSTREAM_HOST_GUARD = `import os
${"\n".repeat(393)}\
_LOOPBACK_HOST_VALUES: frozenset = frozenset({
    "localhost", "127.0.0.1", "::1",
})


def should_require_auth(host: str, allow_public: bool = False) -> bool:
    """Return True iff the dashboard auth gate must be active.

    Truth table:
      host == loopback        → False (no auth — local-only, trusted operator)
      host != loopback        → True  (gate engages — OAuth or password required)

    "Loopback" is 127.0.0.1, localhost, ::1. RFC1918 / CGNAT / link-local are
    deliberately treated as PUBLIC — a hostile device on the same LAN is exactly
    the threat model the gate is designed for.

    \`\`allow_public\`\` (the legacy \`\`--insecure\`\` escape hatch) NO LONGER disables
    the gate. It is accepted for backward-compat with old launch scripts and
    desktop shells but is ignored: a non-loopback bind ALWAYS requires an auth
    provider (OAuth or the bundled password provider). This closes the
    unauthenticated-public-dashboard hole behind the June 2026 \`\`hermes-0day\`\`
    MCP-persistence campaign, where \`\`--insecure --host 0.0.0.0\`\` left the
    config/MCP/agent surface open to internet scanners.
    """
    return host not in _LOOPBACK_HOST_VALUES


def _is_accepted_host(host_header: str, bound_host: str) -> bool:
    """True if the Host header targets the interface we bound to.

    Accepts:
    - Exact bound host (with or without port suffix)
    - Loopback aliases when bound to loopback
    - Any host when bound to 0.0.0.0 (explicit opt-in to non-loopback,
      no protection possible at this layer)
    """
    if not host_header:
        return False
    # Strip port suffix. IPv6 addresses use bracket notation:
    #   [::1]         — no port
    #   [::1]:9119    — with port
    # Plain hosts/v4:
    #   localhost:9119
    #   127.0.0.1:9119
    h = host_header.strip()
    if h.startswith("["):
        # IPv6 bracketed — port (if any) follows "]:"
        close = h.find("]")
        if close != -1:
            host_only = h[1:close]  # strip brackets
        else:
            host_only = h.strip("[]")
    else:
        host_only = h.rsplit(":", 1)[0] if ":" in h else h
    host_only = host_only.lower()

    # 0.0.0.0 bind means operator explicitly opted into all-interfaces
    # (requires --insecure per web_server.start_server). No Host-layer
    # defence can protect that mode; rely on operator network controls.
    if bound_host in {"0.0.0.0", "::"}:
        return True

    # Loopback bind: accept the loopback names
    bound_lc = bound_host.lower()
    if bound_lc in _LOOPBACK_HOST_VALUES:
        return host_only in _LOOPBACK_HOST_VALUES

    # Explicit non-loopback bind: require exact host match
    return host_only == bound_lc
`;

function withPatchedHostGuard(run: (source: string, directory: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-host-"));
  const source = path.join(tmp, "hermes_cli", "web_server.py");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, UPSTREAM_HOST_GUARD);

  try {
    const applied = spawnSync("git", ["apply", "--include=hermes_cli/web_server.py", PATCH], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(applied.status, applied.stderr).toBe(0);
    run(source, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function evaluateHostGuard(
  source: string,
  directory: string,
  env: NodeJS.ProcessEnv,
): Record<string, boolean> {
  const program = `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("web_server", ${JSON.stringify(source)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
accepted = module._is_accepted_host
print(json.dumps({
    "external": accepted("nemoclaw0-abc123.brevlab.com", "127.0.0.1"),
    "external_port": accepted("nemoclaw0-abc123.brevlab.com:443", "127.0.0.1"),
    "external_upper": accepted("NEMOCLAW0-ABC123.BREVLAB.COM", "127.0.0.1"),
    "loopback": accepted("localhost:18789", "127.0.0.1"),
    "lookalike": accepted("nemoclaw0-abc123.brevlab.com.attacker.test", "127.0.0.1"),
    "other": accepted("attacker.test", "127.0.0.1"),
}))
`;
  const evaluated = spawnSync("python3", ["-c", program], {
    cwd: directory,
    env,
    encoding: "utf8",
  });
  expect(evaluated.status, evaluated.stderr).toBe(0);
  return JSON.parse(evaluated.stdout) as Record<string, boolean>;
}

function environmentWithoutExternalHost(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[EXTERNAL_HOST_ENV];
  return env;
}

function resolveExternalHost(url: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      'set -eo pipefail; source "$1"; nemoclaw_hermes_dashboard_external_host "$2"',
      "bash",
      EXTERNAL_HOST_HELPER,
      url,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}

it("accepts only the configured proxy host on the loopback Hermes dashboard (#10651)", () => {
  withPatchedHostGuard((source, directory) => {
    expect(
      evaluateHostGuard(source, directory, {
        ...process.env,
        [EXTERNAL_HOST_ENV]: "nemoclaw0-abc123.brevlab.com",
      }),
    ).toEqual({
      external: true,
      external_port: true,
      external_upper: true,
      loopback: true,
      lookalike: false,
      other: false,
    });
  });
});

it("keeps non-loopback proxy hosts denied when none is configured (#10651)", () => {
  withPatchedHostGuard((source, directory) => {
    expect(evaluateHostGuard(source, directory, environmentWithoutExternalHost())).toMatchObject({
      external: false,
      external_port: false,
      external_upper: false,
      loopback: true,
      lookalike: false,
      other: false,
    });
  });
});

it("derives the lowercase hostname from an HTTPS CHAT_UI_URL with a port and path (#10651)", () => {
  const run = resolveExternalHost("https://NEMOCLAW0-ABC123.BREVLAB.COM:29443/dashboard");

  expect(run.status).toBe(0);
  expect(run.stdout).toBe("nemoclaw0-abc123.brevlab.com\n");
});

it.each([
  { condition: "the scheme is not HTTPS", url: "http://dashboard.example.test:29443" },
  { condition: "the host is an IPv4 loopback address", url: "https://127.0.0.1:29443" },
  { condition: "the host is localhost", url: "https://localhost:29443" },
  { condition: "the URL includes user information", url: "https://user@dashboard.example.test" },
  { condition: "the port is malformed", url: "https://dashboard.example.test:invalid" },
])("rejects CHAT_UI_URL when $condition (#10651)", ({ url }) => {
  const run = resolveExternalHost(url);

  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe("");
});
