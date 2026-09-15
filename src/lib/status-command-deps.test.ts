// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as receiptAuthority from "./onboard/experimental/hermes-portable-receipt";
import * as registry from "./state/registry";
import { buildStatusCommandDeps } from "./status-command-deps";

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
    vi.restoreAllMocks();
    if (previousOverride === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = previousOverride;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies copied Hermes authority for status before probe migration (#10423)", () => {
    const classify = vi
      .spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthorityForClassification")
      .mockReturnValue({
        kind: "hermes",
        snapshot: {
          receipt: {
            phase: "active",
            sandboxName: "alpha",
            gatewayName: "nemoclaw",
            lifecycleGeneration: "generation-1",
            openshellExecutableAuthority: { version: "0.0.106" },
          },
        } as never,
      });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      openshellDriver: "docker",
      openshellVersion: "0.0.106",
    } as never);

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.getHermesPortablePhase?.("alpha")).toBe("active");
    expect(classify).toHaveBeenCalledOnce();
  });

  it("detects Telegram conflict signatures from the gateway log", () => {
    writeExecutable(
      openshell,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then
  printf 'getUpdates conflict\\n409 Conflict\\n409: Conflict\\n'
  exit 0
fi
exit 0
`,
    );

    const deps = buildStatusCommandDeps(tmp);

    expect(deps.checkMessagingBridgeHealth!("alpha", ["telegram"])).toEqual([
      { channel: "telegram", conflicts: 3 },
    ]);
    expect(fs.readFileSync(callsFile, "utf-8")).toContain(
      "sandbox exec -n alpha -- sh -c tail -n 200 /tmp/gateway.log",
    );
    expect(fs.readFileSync(callsFile, "utf-8")).not.toContain("grep -cE");
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
