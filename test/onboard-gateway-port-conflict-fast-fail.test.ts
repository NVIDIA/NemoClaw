// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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
const GATEWAY_PORT = "18080";

describe("onboard gateway port conflict fast-fail (#6752)", () => {
  let workspace: OnboardProcessWorkspace;
  let openshellCallLog: string;

  beforeEach(() => {
    workspace = createOnboardProcessWorkspace("nemoclaw-6752-");
    openshellCallLog = workspace.path("openshell-calls.log");

    for (const component of ["openshell", "openshell-gateway", "openshell-sandbox"]) {
      workspace.writeExecutable(
        component,
        [
          "#!/usr/bin/env bash",
          "# openshell capabilities: request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods",
          `printf '%s\\n' "$*" >> ${JSON.stringify(openshellCallLog)}`,
          'case "$*" in',
          '  --version|-V) printf "%s 0.0.101\\n" "${0##*/}"; exit 0;;',
          '  status|"gateway info"|"gateway info -g nemoclaw"*) sleep 20; exit 0;;',
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
        `if [ "$port" = ${JSON.stringify(GATEWAY_PORT)} ]; then`,
        `  echo "python3 1234 test 1u IPv4 TCP 127.0.0.1:${GATEWAY_PORT} (LISTEN)"`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );
  });

  afterEach(() => {
    workspace.remove();
  });

  it(
    "reports a foreign listener before OpenShell gateway inspection can hang",
    testTimeoutOptions(10_000),
    () => {
      const result = runOnboardProcess(
        [CLI, "onboard", "--name", "foreign-port", "--no-gpu", "--non-interactive"],
        {
          timeoutMs: 5_000,
          env: workspaceEnv(workspace, {
            NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
            NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT,
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
      const calls = fs.existsSync(openshellCallLog)
        ? fs.readFileSync(openshellCallLog, "utf8")
        : "";
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBeGreaterThan(0);
      expect(combined).toContain(`Port ${GATEWAY_PORT} is not available.`);
      expect(combined).toContain("Blocked by: python3 (PID 1234)");
      expect(combined).toContain("NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard");
      expect(calls).not.toMatch(/^(status|gateway info(?: -g nemoclaw)?)$/m);
    },
  );
});
