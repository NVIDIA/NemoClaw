// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { buildStatusCommandDeps } =
  require("../../dist/lib/status-command-deps.js") as typeof import("../../dist/lib/status-command-deps");

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

describe("buildStatusCommandDeps", () => {
  let previousOverride: string | undefined;
  let tmp: string;
  let callsFile: string;
  let openshell: string;

  beforeEach(() => {
    previousOverride = process.env.NEMOCLAW_OPENSHELL_BIN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-status-deps-"));
    callsFile = path.join(tmp, "openshell.calls");
    openshell = path.join(tmp, "openshell");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
  });

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = previousOverride;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects Telegram conflict signatures from the gateway log", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  printf '7\n'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["telegram"])).toEqual([
      { channel: "telegram", conflicts: 7 },
    ]);
    expect(fs.readFileSync(callsFile, "utf-8")).toContain(
      "sandbox exec -n alpha -- sh -c tail -n 200 /tmp/gateway.log",
    );
  });

  it("skips gateway-log probes for non-Telegram channel sets", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["slack", "discord"])).toEqual([]);
    expect(fs.existsSync(callsFile)).toBe(false);
  });

  it("returns null for empty gateway log tails and the log text otherwise", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  case "$*" in
    *"tail -n 10"*) printf 'line one\nline two\n'; exit 0 ;;
  esac
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);
    expect(deps.readGatewayLog?.("alpha")).toBe("line one\nline two");

    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
exit 0
`,
    );
    expect(deps.readGatewayLog?.("alpha")).toBeNull();
  });

  it("parses live gateway inference through the OpenShell override", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  echo 'Gateway inference:'
  echo '  Provider: nvidia-prod'
  echo '  Model: nvidia/nemotron'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.getLiveInference()).toEqual({ provider: "nvidia-prod", model: "nvidia/nemotron" });
    expect(fs.readFileSync(callsFile, "utf-8")).toContain("inference get");
  });
});
