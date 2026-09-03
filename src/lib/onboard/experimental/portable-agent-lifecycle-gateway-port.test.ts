// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testTimeout } from "../../../../test/helpers/timeouts";

const SANDBOX = "conn-iso";
const NON_DEFAULT_GATEWAY_PORT = "18224";
const DEFAULT_GATEWAY_PORT = "8080";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-gateway-port-"));
  homes.push(home);
  return home;
}

/**
 * Load the lifecycle modules against a chosen gateway port. GATEWAY_PORT is a
 * module-load constant, and both state-root resolvers keep a test escape hatch
 * that fires when HOME equals NEMOCLAW_TEST_BASE_HOME, so the port only moves
 * the resolved paths once those are stubbed away and the modules are reloaded.
 */
async function loadLifecycleForGatewayPort(gatewayPort: string, home: string) {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", "");
  vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", "");
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", gatewayPort);
  const lock = await import("../../state/mcp-lifecycle-lock-acquisition");
  const lifecycle = await import("./portable-agent-lifecycle");
  const receipt = await import("./hermes-portable-receipt");
  const portable = await import("../../state/portable-uninstall-retirement");
  return { lock, lifecycle, receipt, portable };
}

async function requalifyUnderLifecycleLock(gatewayPort: string, home: string) {
  const { lock, lifecycle } = await loadLifecycleForGatewayPort(gatewayPort, home);
  return lock.withMcpLifecycleLockSync(SANDBOX, () =>
    lifecycle.requalifyPortableAgentSandboxAuthority(SANDBOX, { readRegistry: () => null }),
  );
}

describe("portable agent requalification across gateway ports", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  });

  it(
    "requalifies a sandbox that has no portable receipt on a non-default gateway port",
    async () => {
      const outcome = await requalifyUnderLifecycleLock(NON_DEFAULT_GATEWAY_PORT, makeHome());

      expect(outcome).toEqual({ kind: "not-hermes" });
    },
    testTimeout(15_000),
  );

  it("reports the default gateway outcome for the same sandbox and state", async () => {
    const outcome = await requalifyUnderLifecycleLock(DEFAULT_GATEWAY_PORT, makeHome());

    expect(outcome).toEqual({ kind: "not-hermes" });
  });

  it("requires the lifecycle lock when a sandbox has a portable receipt", async () => {
    const home = makeHome();
    const { lifecycle, receipt, portable } = await loadLifecycleForGatewayPort(
      NON_DEFAULT_GATEWAY_PORT,
      home,
    );
    const stateDir = portable.defaultPortableStateDir(process.env);
    fs.mkdirSync(receipt.hermesPortableReceiptDirectory(SANDBOX, stateDir), { recursive: true });

    expect(() =>
      lifecycle.requalifyPortableAgentSandboxAuthority(SANDBOX, { readRegistry: () => null }),
    ).toThrow(/requalification requires the sandbox lifecycle lock/u);
  });
});
