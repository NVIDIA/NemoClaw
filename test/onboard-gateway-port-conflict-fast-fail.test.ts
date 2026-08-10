// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOnboardProcessWorkspace,
  type OnboardProcessWorkspace,
  runOnboardProcess,
  workspaceEnv,
} from "./helpers/onboard-child-process-harness";
import { testTimeoutOptions } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

describe("onboard gateway port conflict readiness (#6752)", () => {
  let workspace: OnboardProcessWorkspace;
  let gatewayPort: number;
  let gatewayServer: net.Server;

  beforeEach(async () => {
    workspace = createOnboardProcessWorkspace("nemoclaw-6752-");
    gatewayServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      gatewayServer.once("error", reject);
      gatewayServer.listen(0, "127.0.0.1", resolve);
    });
    gatewayPort = (gatewayServer.address() as AddressInfo).port;

    for (const component of ["openshell", "openshell-gateway", "openshell-sandbox"]) {
      workspace.writeExecutable(
        component,
        [
          "#!/usr/bin/env bash",
          "# openshell capabilities: request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods",
          'case "$*" in',
          '  --version|-V) printf "%s 0.0.101\\n" "${0##*/}"; exit 0;;',
          '  status) printf "No active gateway\\n"; exit 1;;',
          '  "gateway info"|"gateway info -g nemoclaw"*) printf "No gateway metadata found\\n"; exit 1;;',
          "esac",
          "exit 1",
        ].join("\n"),
      );
    }

    workspace.writeExecutable("brew", "#!/usr/bin/env bash\nexit 1\n");

    workspace.writeExecutable(
      "docker",
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = info ]; then echo "Server Version: 24.0.0"; exit 0; fi',
        'if [ "$1" = ps ]; then exit 0; fi',
        "exit 0",
      ].join("\n"),
    );

    workspace.writeExecutable(
      "lsof",
      [
        "#!/usr/bin/env bash",
        'port=""',
        'for arg in "$@"; do',
        '  case "$arg" in :*) port="${arg#:}";; esac',
        "done",
        `if [ "$port" = ${JSON.stringify(String(gatewayPort))} ]; then`,
        '  if [ "$1" = -ti ]; then printf "%s\\n" "$PPID"; exit 0; fi',
        `  echo "python3 $PPID test 1u IPv4 TCP 127.0.0.1:${String(gatewayPort)} (LISTEN)"`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    workspace.remove();
  });

  it(
    "rejects a foreign listener without waiting on lifecycle inspection",
    testTimeoutOptions(15_000),
    () => {
      const result = runOnboardProcess(
        [CLI, "onboard", "--name", "foreign-port", "--no-gpu", "--non-interactive"],
        {
          timeoutMs: 10_000,
          env: workspaceEnv(workspace, {
            NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
            NEMOCLAW_GATEWAY_PORT: String(gatewayPort),
            NEMOCLAW_OPENSHELL_BIN: path.join(workspace.binDir, "openshell"),
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_OPENSHELL_GATEWAY_BIN: path.join(workspace.binDir, "openshell-gateway"),
            NEMOCLAW_OPENSHELL_SANDBOX_BIN: path.join(workspace.binDir, "openshell-sandbox"),
            NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT: "1",
            NEMOCLAW_TEST_NO_SLEEP: "1",
          }),
        },
      );

      const combined = result.output;
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBeGreaterThan(0);
      expect(combined).toMatch(
        new RegExp(`(?:Port|Gateway port) ${String(gatewayPort)} (?:is not available|is occupied)`),
      );
      expect(combined).toMatch(
        /The gateway port is held by an incompatible or ambiguous owner|OpenShell gateway needs this port/,
      );
    },
  );
});
