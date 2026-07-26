// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { buildOpenShellGatewayUserServiceRestartScript } from "../fixtures/phases/lifecycle.ts";

describe("managed OpenShell gateway user-service restart", () => {
  it("selects a marked unit from an absolute custom XDG config root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-service-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unitDir = path.join(configHome, "systemd", "user");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, "nemoclaw-openshell-gateway.service"),
      "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n",
    );
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user cat openshell-gateway" ]; then exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      execFileSync("sh", ["-lc", buildOpenShellGatewayUserServiceRestartScript()], { env });

      expect(env.XDG_CONFIG_HOME).toBe(configHome);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user cat openshell-gateway",
        "--user is-enabled nemoclaw-openshell-gateway",
        "--user daemon-reload",
        "--user restart nemoclaw-openshell-gateway",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
