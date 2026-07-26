// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const GATEWAY_PORT = "18080";

describe("onboard gateway port conflict fast-fail (#6752)", () => {
  let home: string;
  let binDir: string;
  let openshellCallLog: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-6752-"));
    binDir = path.join(home, "bin");
    openshellCallLog = path.join(home, "openshell-calls.log");
    fs.mkdirSync(binDir, { recursive: true });

    for (const component of ["openshell", "openshell-gateway", "openshell-sandbox"]) {
      fs.writeFileSync(
        path.join(binDir, component),
        [
          "#!/usr/bin/env bash",
          "# openshell capabilities: request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods",
          `printf '%s\\n' "$*" >> ${JSON.stringify(openshellCallLog)}`,
          'case "$*" in',
          '  --version|-V) printf "%s 0.0.85\\n" "${0##*/}"; exit 0;;',
          '  status|"gateway info"|"gateway info -g nemoclaw"*) sleep 20; exit 0;;',
          "esac",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );
    }

    fs.writeFileSync(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = info ]; then echo "Server Version: 24.0.0"; exit 0; fi',
        'if [ "$1" = ps ]; then exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    fs.writeFileSync(
      path.join(binDir, "lsof"),
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
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it(
    "reports a foreign listener before OpenShell gateway inspection can hang",
    testTimeoutOptions(10_000),
    () => {
      const result = spawnSync(
        process.execPath,
        [CLI, "onboard", "--name", "foreign-port", "--no-gpu", "--non-interactive"],
        {
          encoding: "utf-8",
          timeout: 5_000,
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binDir}:${process.env.PATH || ""}`,
            NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
            NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT,
            NEMOCLAW_OPENSHELL_BIN: path.join(binDir, "openshell"),
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_OPENSHELL_GATEWAY_BIN: path.join(binDir, "openshell-gateway"),
            NEMOCLAW_OPENSHELL_SANDBOX_BIN: path.join(binDir, "openshell-sandbox"),
            NEMOCLAW_TEST_NO_SLEEP: "1",
          },
        },
      );

      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
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
