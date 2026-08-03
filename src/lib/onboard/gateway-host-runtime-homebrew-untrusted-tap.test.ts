// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatewayHostRuntime, type GatewayHostRuntimeDeps } from "./gateway-host-runtime";
import type { PortProbeResult } from "./preflight";

const commandState = vi.hoisted(() => ({
  brewInfo: {
    status: 1 as number | null,
    stderr:
      "Error: Refusing to load formula nvidia/openshell/openshell from untrusted tap nvidia/openshell.",
    stdout: "",
  },
  calls: [] as string[][],
  launchctl: {
    status: 113 as number | null,
    stderr:
      'Bad request.\nCould not find service "homebrew.mxcl.openshell" in domain for user gui: 501',
    stdout: "",
  },
}));

// Homebrew 6.x can refuse the pinned formula during brew info.
// This mock keeps the production spawnSync boundary in the owner resolution.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[]) => {
      commandState.calls.push([command, ...args]);
      return command === "brew" && args[0] === "info"
        ? { ...commandState.brewInfo }
        : command === "launchctl"
          ? { ...commandState.launchctl }
          : { status: 0, stderr: "", stdout: "" };
    }),
  };
});

const ORIGINAL_ENV = { ...process.env };
const HOMEBREW_PINNED_TAP_LOAD_REFUSAL =
  "Error: Refusing to load formula nvidia/openshell/openshell from untrusted tap nvidia/openshell.";
const LAUNCHCTL_MISSING_OPENSHELL_SERVICE =
  'Bad request.\nCould not find service "homebrew.mxcl.openshell" in domain for user gui: 501';
const HOMEBREW_IDENTITY_PROBES = [
  ["sh", "-c", 'command -v "$1" >/dev/null 2>&1', "sh", "brew"],
  ["brew", "list", "--formula", "openshell"],
  ["brew", "info", "--json=v2", "openshell"],
];
const HOMEBREW_AND_LAUNCHCTL_PROBES = [
  ...HOMEBREW_IDENTITY_PROBES,
  ["launchctl", "print", "gui/501/homebrew.mxcl.openshell"],
];

beforeEach(() => {
  commandState.calls.length = 0;
  Object.assign(commandState.brewInfo, {
    status: 1,
    stderr: HOMEBREW_PINNED_TAP_LOAD_REFUSAL,
    stdout: "",
  });
  Object.assign(commandState.launchctl, {
    status: 113,
    stderr: LAUNCHCTL_MISSING_OPENSHELL_SERVICE,
    stdout: "",
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "getuid").mockReturnValue(501);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function createDeps(): GatewayHostRuntimeDeps {
  return {
    applyOverlayfsAutoFix: () => null,
    checkGatewayPortAvailable: async () => ({ ok: true }) as PortProbeResult,
    gatewayName: () => "nemoclaw",
    gatewayPort: () => 8080,
    getGatewayPortListenerRawScan: () => ({ pids: [], complete: true }),
    getInstalledOpenshellVersion: () => "0.0.85",
    runCaptureOpenshell: () => "healthy",
    runOpenshell: () => ({ status: 0 }),
    resolveOpenShellGatewayBinary: () => null,
    waitForGatewayHttpReady: async () => true,
  };
}

describe("gateway host runtime on Homebrew 6.x untrusted tap", () => {
  it("selects standalone ownership after the exact refusal and missing-unit result (#7707)", () => {
    const runtime = createGatewayHostRuntime(createDeps());

    expect(runtime.getGatewayOwner()).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
    });
    expect(runtime.getGatewayOwner()).toMatchObject({ source: "standalone" });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["leading whitespace", ` ${HOMEBREW_PINNED_TAP_LOAD_REFUSAL}`, ""],
    ["trailing whitespace", `${HOMEBREW_PINNED_TAP_LOAD_REFUSAL}\n`, ""],
    [
      "repeated whitespace",
      HOMEBREW_PINNED_TAP_LOAD_REFUSAL.replace("load formula", "load  formula"),
      "",
    ],
    ["a tab", HOMEBREW_PINNED_TAP_LOAD_REFUSAL.replace("load formula", "load\tformula"), ""],
    [
      "an inserted line break",
      HOMEBREW_PINNED_TAP_LOAD_REFUSAL.replace("load formula", "load\nformula"),
      "",
    ],
    ["CRLF", HOMEBREW_PINNED_TAP_LOAD_REFUSAL.replace("load formula", "load\r\nformula"), ""],
    ["unexpected stdout", HOMEBREW_PINNED_TAP_LOAD_REFUSAL, "unexpected stdout"],
  ])("rejects Homebrew diagnostic variation %s before owner selection (#7707)", (_case, stderr, stdout) => {
    Object.assign(commandState.brewInfo, { stderr, stdout });
    const runtime = createGatewayHostRuntime(createDeps());

    expect(() => runtime.getGatewayOwner()).toThrow(
      "OpenShell Homebrew formula identity check failed; " +
        "the unrecognized Homebrew diagnostic was omitted.",
    );
    expect(commandState.calls).toEqual(HOMEBREW_IDENTITY_PROBES);
  });

  it.each([
    ["leading whitespace", ` ${LAUNCHCTL_MISSING_OPENSHELL_SERVICE}`, ""],
    ["trailing whitespace", `${LAUNCHCTL_MISSING_OPENSHELL_SERVICE}\n`, ""],
    [
      "repeated whitespace",
      LAUNCHCTL_MISSING_OPENSHELL_SERVICE.replace("Bad request.", "Bad  request."),
      "",
    ],
    ["a tab", LAUNCHCTL_MISSING_OPENSHELL_SERVICE.replace("Could not find", "Could not\tfind"), ""],
    [
      "an inserted line break",
      LAUNCHCTL_MISSING_OPENSHELL_SERVICE.replace("Could not find", "Could not\nfind"),
      "",
    ],
    ["CRLF", LAUNCHCTL_MISSING_OPENSHELL_SERVICE.replace("\n", "\r\n"), ""],
    ["whitespace-only stdout", LAUNCHCTL_MISSING_OPENSHELL_SERVICE, " \n"],
  ])("rejects launchctl diagnostic variation %s before owner selection (#7707)", (_case, stderr, stdout) => {
    Object.assign(commandState.launchctl, { stderr, stdout });
    const runtime = createGatewayHostRuntime(createDeps());

    expect(() => runtime.getGatewayOwner()).toThrow(
      "could not determine whether its launchd service homebrew.mxcl.openshell is loaded",
    );
    expect(commandState.calls).toEqual(HOMEBREW_AND_LAUNCHCTL_PROBES);
  });
});
