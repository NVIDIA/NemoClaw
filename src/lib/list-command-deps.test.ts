// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_PORT } from "./core/ports";
import { resolveGatewayName } from "./onboard/gateway-binding";
import * as registry from "./state/registry";
import { buildListCommandDeps } from "./list-command-deps";

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

describe("buildListCommandDeps active-session count", () => {
  let tmp: string;
  let openshell: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-list-deps-"));
    openshell = path.join(tmp, "openshell");
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", openshell);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== "linux")(
    "uses each recovered row's gateway instead of the selected registry root",
    () => {
      writeExecutable(openshell, "#!/usr/bin/env bash\nexit 0\n");
      const sandboxName = `list-count-${process.pid}`;
      const lookup = vi.spyOn(registry, "getSandbox").mockReturnValue(null);
      const command = `openshell sandbox exec --name ${sandboxName} --tty -- /bin/bash -i`;
      const selectedGateway = resolveGatewayName(GATEWAY_PORT);
      const siblingGatewayPort = GATEWAY_PORT === 9090 ? 9091 : 9090;
      const siblingGateway = resolveGatewayName(siblingGatewayPort);
      const startSession = (gateway: string) =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          argv0: command,
          env: { ...process.env, OPENSHELL_GATEWAY: gateway },
          stdio: "ignore",
        });
      const selected = startSession(selectedGateway);
      const sibling = startSession(siblingGateway);
      const sibling2 = startSession(siblingGateway);
      try {
        const deps = buildListCommandDeps();
        expect(
          deps.getActiveSessionCount?.({ name: sandboxName, gatewayPort: siblingGatewayPort }),
        ).toBe(2);
        expect(deps.getActiveSessionCount?.({ name: sandboxName })).toBe(1);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        selected.kill();
        sibling.kill();
        sibling2.kill();
      }
    },
  );
});
