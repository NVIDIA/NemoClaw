// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import { resolveGatewayStateDirName } from "../../onboard/gateway-binding";

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

function writeScopedGatewayState(home: string, port = 8080): void {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(port));
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    path.join(stateDir, "openshell-gateway.toml"),
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: `https://127.0.0.1:${String(port)}`,
        OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      },
      "/usr/bin/openshell-sandbox",
      jwtBundle,
      gatewayIdForStateDir(stateDir),
    ),
    { mode: 0o600 },
  );
  writeManagedGatewayRuntimeProof(stateDir, port);
}

function withManagedAuthority(deps: UninstallRunDeps): UninstallRunDeps {
  return withProvenManagedGatewayProcess({
    isPortFree: () => true,
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
    ...deps,
  });
}

function uninstallOutputFor(
  registry: string | null,
  liveGatewayNames: readonly string[],
  retainedGatewayPorts: readonly number[] = [],
  env: NodeJS.ProcessEnv = { NO_COLOR: "1" },
  stderrIsTty = false,
  stderrHasColors = stderrIsTty,
): { logs: string[]; warnings: string[] } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-report-"));
  const logs: string[] = [];
  const warnings: string[] = [];
  try {
    const stateDir = path.join(tmpHome, ".nemoclaw");
    writeScopedGatewayState(tmpHome);
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
      withManagedAuthority({
        commandExists: () => true,
        env: { HOME: tmpHome, LOGNAME: "tester", ...env } as NodeJS.ProcessEnv,
        error: (message: string) => warnings.push(message),
        existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
        isTty: false,
        kill: vi.fn(() => true),
        log: (message: string) => logs.push(message),
        retainedGatewayPorts,
        rmSync: fs.rmSync,
        stderrHasColors,
        stderrIsTty,
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? ok(gatewayList)
            : ok(),
        runDocker: () => ok(),
      }),
    );
    return { logs, warnings };
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
  ] as const)(
    "warns that %s remains after the selected-port uninstall (#8797)",
    (_scenario, registry) => {
      const { logs, warnings } = uninstallOutputFor(registry, ["nemoclaw", "nemoclaw-9000"]);

      expect(warnings).toContainEqual(
        expect.stringContaining("⚠ Other NemoClaw gateway-port environments remain on this host"),
      );
      expect(warnings).toContainEqual("  · gateway 'nemoclaw-9000' on port 9000");
      expect(warnings).toContainEqual(
        expect.stringContaining("NEMOCLAW_GATEWAY_PORT=9000 nemoclaw uninstall"),
      );
      expect(warnings).toContainEqual(expect.stringContaining("uninstall --all-gateway-ports"));
      expect(logs).not.toContainEqual(
        expect.stringContaining("gateway-port environments remain on this host"),
      );
    },
  );

  it("colors the retained gateway warning only for interactive stderr without NO_COLOR (#8797)", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const { warnings } = uninstallOutputFor(null, ["nemoclaw", "nemoclaw-9000"], [], {}, true);
    const { warnings: redirectedWarnings } = uninstallOutputFor(
      null,
      ["nemoclaw", "nemoclaw-9000"],
      [],
      {},
    );
    const { warnings: noColorWarnings } = uninstallOutputFor(
      null,
      ["nemoclaw", "nemoclaw-9000"],
      [],
      { NO_COLOR: "" },
      true,
    );
    const { warnings: unsupportedColorWarnings } = uninstallOutputFor(
      null,
      ["nemoclaw", "nemoclaw-9000"],
      [],
      {},
      true,
      false,
    );

    expect(warnings).toContainEqual(
      "\x1b[33m  ⚠ Other NemoClaw gateway-port environments remain on this host and are outside this uninstall:\x1b[39m",
    );
    expect(warnings).toContainEqual(
      "\x1b[33m  Remove every gateway port: nemoclaw uninstall --all-gateway-ports\x1b[39m",
    );
    expect(redirectedWarnings).not.toContainEqual(expect.stringContaining("\x1b[33m"));
    expect(noColorWarnings).toContainEqual(
      "  ⚠ Other NemoClaw gateway-port environments remain on this host and are outside this uninstall:",
    );
    expect(noColorWarnings).not.toContainEqual(expect.stringContaining("\x1b[33m"));
    expect(unsupportedColorWarnings).toContainEqual(
      "  ⚠ Other NemoClaw gateway-port environments remain on this host and are outside this uninstall:",
    );
    expect(unsupportedColorWarnings).not.toContainEqual(expect.stringContaining("\x1b[33m"));
  });

  it("stays silent about other gateway ports when this host has none", () => {
    const { logs, warnings } = uninstallOutputFor(null, ["nemoclaw"]);

    expect(logs).not.toContainEqual(
      expect.stringContaining("gateway-port environments remain on this host"),
    );
    expect(logs).not.toContainEqual(expect.stringContaining("--all-gateway-ports"));
    expect(warnings).not.toContainEqual(
      expect.stringContaining("gateway-port environments remain on this host"),
    );
    expect(warnings).not.toContainEqual(expect.stringContaining("--all-gateway-ports"));
  });

  it("keeps shared host resources for a failed sweep port whose gateway is already gone (#7791)", () => {
    const { logs, warnings } = uninstallOutputFor(null, ["nemoclaw"], [9000]);

    expect(warnings).toContainEqual("  · gateway 'nemoclaw-9000' on port 9000");
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
      { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
      withManagedAuthority({
        commandExists: (command) => command === "openshell",
        env: { HOME: "/tmp/nemoclaw-uninstall-test-scan" } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: vi.fn(() => true),
        log: vi.fn(),
        requireCompleteGatewayProcessCleanup: true,
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json" ? ok("[]") : ok(),
        runDocker: () => ok(),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(errors).toContain(
      "Cannot continue uninstall because host gateway process cleanup did not complete.",
    );
  });
});
