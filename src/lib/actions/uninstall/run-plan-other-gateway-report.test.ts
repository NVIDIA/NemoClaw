// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan, type UninstallRunDeps } from "./run-plan";

const SIBLING_REGISTRY = JSON.stringify({
  defaultSandbox: "alpha",
  sandboxes: {
    alpha: { name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
    beta: { name: "beta", gatewayName: "nemoclaw-9000", gatewayPort: 9000 },
  },
});

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function managedAuthority(): Pick<UninstallRunDeps, "resolveGatewayTeardownAuthority"> {
  return {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
}

function uninstallLogsFor(
  registry: string | null,
  liveGatewayNames: readonly string[],
  retainedGatewayPorts: readonly number[] = [],
): string[] {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-report-"));
  const logs: string[] = [];
  try {
    const stateDir = path.join(tmpHome, ".nemoclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const writeRegistry = {
      absent: () => undefined,
      present: () =>
        fs.writeFileSync(path.join(stateDir, "sandboxes.json"), String(registry), "utf-8"),
    } as const;
    writeRegistry[registry === null ? "absent" : "present"]();
    const gatewayList = JSON.stringify(liveGatewayNames.map((name) => ({ name })));

    runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        ...managedAuthority(),
        commandExists: () => true,
        env: { HOME: tmpHome, LOGNAME: "tester" } as NodeJS.ProcessEnv,
        existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
        isTty: false,
        kill: vi.fn(() => true),
        log: (message: string) => logs.push(message),
        retainedGatewayPorts,
        rmSync: fs.rmSync,
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? ok(gatewayList)
            : ok(),
        runDocker: () => ok(),
      },
    );
    return logs;
  } finally {
    fs.rmSync(tmpHome, { force: true, recursive: true });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("uninstall reporting for other gateway-port environments (#7791)", () => {
  it.each([
    ["a live sibling gateway with a shared registry row", SIBLING_REGISTRY],
    ["a live sibling gateway with no registry row", null],
  ] as const)("names the gateway port left behind by %s", (_scenario, registry) => {
    const logs = uninstallLogsFor(registry, ["nemoclaw", "nemoclaw-9000"]);

    expect(logs).toContainEqual(
      expect.stringContaining("gateway-port environments remain on this host"),
    );
    expect(logs).toContainEqual("  · gateway 'nemoclaw-9000' on port 9000");
    expect(logs).toContainEqual(
      expect.stringContaining("NEMOCLAW_GATEWAY_PORT=9000 nemoclaw uninstall"),
    );
    expect(logs).toContainEqual(expect.stringContaining("uninstall --all-gateway-ports"));
  });

  it("stays silent about other gateway ports when this host has none", () => {
    const logs = uninstallLogsFor(null, ["nemoclaw"]);

    expect(logs).not.toContainEqual(
      expect.stringContaining("gateway-port environments remain on this host"),
    );
    expect(logs).not.toContainEqual(expect.stringContaining("--all-gateway-ports"));
  });

  it("keeps shared host resources for a failed sweep port whose gateway is already gone (#7791)", () => {
    const logs = uninstallLogsFor(null, ["nemoclaw"], [9000]);

    expect(logs).toContainEqual("  · gateway 'nemoclaw-9000' on port 9000");
    expect(logs).toContainEqual(
      "Sibling gateways remain; kept shared runtime files and OpenShell binaries.",
    );
    expect(logs).toContainEqual(
      "Sibling gateways remain; kept shared OpenShell and NemoClaw config.",
    );
  });

  it("returns nonzero when the orphan gateway-process scan cannot run", () => {
    const errors: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        commandExists: (command) => command !== "pgrep",
        env: { HOME: "/tmp/nemoclaw-uninstall-test-scan" } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: () => false,
        isTty: false,
        kill: vi.fn(() => true),
        log: vi.fn(),
        requireCompleteGatewayProcessCleanup: true,
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json" ? ok("[]") : ok(),
        runDocker: () => ok(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(errors).toContain(
      "Cannot continue uninstall because host gateway process cleanup did not complete.",
    );
  });
});
