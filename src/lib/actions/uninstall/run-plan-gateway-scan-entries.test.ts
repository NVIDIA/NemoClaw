// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: gatewayPort === 8080 ? "packaged-service" : "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
  });
}

function okWithKnownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

const SCOPED_RETENTION_LOG =
  "Sibling gateways remain; kept the shared NemoClaw CLI and shell shims.";

function managedWrapper(binName: string): string {
  return [
    "#!/usr/bin/env bash",
    'export PATH="/tmp/node-bin:$PATH"',
    `exec "/tmp/prefix/bin/${binName}" "$@"`,
    "",
  ].join("\n");
}

/**
 * Builds a home whose gateways directory holds only the named entries, plus a
 * managed wrapper shim for every CLI alias. An entry ending in "/" is created
 * as a directory. Returns the shim paths so a test can assert on removal.
 */
function makeHome(prefix: string, entries: readonly string[]): { home: string; shims: string[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const gatewaysDir = path.join(home, ".nemoclaw", "gateways");
  fs.mkdirSync(gatewaysDir, { recursive: true });
  for (const entry of entries) {
    const target = path.join(gatewaysDir, entry.replace(/\/$/, ""));
    entry.endsWith("/") ? fs.mkdirSync(target) : fs.writeFileSync(target, "");
  }
  const userBin = path.join(home, ".local", "bin");
  fs.mkdirSync(userBin, { recursive: true });
  const shims = ["nemoclaw", "nemohermes", "nemo-deepagents"].map((binName) => {
    const shimPath = path.join(userBin, binName);
    fs.writeFileSync(shimPath, managedWrapper(binName), { mode: 0o755 });
    return shimPath;
  });
  return { home, shims };
}

function writeScopedGatewayState(home: string): void {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", "openshell-docker-gateway");
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    path.join(stateDir, "openshell-gateway.toml"),
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
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
}

/**
 * Runs the plan and reports which shims are still on disk afterwards. Removal
 * goes through the real filesystem, restricted to the temporary home, so the
 * assertions read the outcome rather than the calls a test double recorded.
 */
function uninstall(home: string, shims: readonly string[]) {
  const logs: string[] = [];
  const result = runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell: true },
    {
      commandExists: (command) => command !== "docker" && command !== "lsof" && command !== "pgrep",
      env: { HOME: home } as NodeJS.ProcessEnv,
      existsSync: (target) => shims.includes(target) && fs.existsSync(target),
      isTty: false,
      log: (line) => logs.push(line),
      rmSync: vi.fn((target: fs.PathLike, options?: fs.RmOptions) => {
        String(target).startsWith(home) ? fs.rmSync(target, options) : undefined;
      }),
      run: vi.fn(okWithKnownGatewayList),
      runDocker: () => ok(""),
    },
  );
  return { result, logs, survivors: shims.filter((shim) => fs.existsSync(shim)) };
}

describe("uninstall gateway-directory scan", () => {
  it.each([
    [".DS_Store"],
    [".localized"],
    ["._sandboxes.json"],
  ])("removes the CLI shims when the gateways directory holds only %s (#7905)", (entry) => {
    const { home, shims } = makeHome("nemoclaw-uninstall-metadata-", [entry]);

    try {
      const { result, logs, survivors } = uninstall(home, shims);

      expect(result.exitCode).toBe(0);
      expect(logs).not.toContain(SCOPED_RETENTION_LOG);
      expect(survivors).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // "._" carries no name, and a directory or symlink is a shape that may hide
  // live gateway state, so each of these keeps the conservative treatment.
  it.each([
    ["not-a-port"],
    ["._"],
    [".DS_Store/"],
  ])("keeps the CLI shims when the gateways directory holds %s (#7905)", (entry) => {
    const { home, shims } = makeHome("nemoclaw-uninstall-conservative-", [entry]);
    writeScopedGatewayState(home);

    try {
      const { result, logs, survivors } = uninstall(home, shims);

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(SCOPED_RETENTION_LOG);
      expect(survivors).toEqual(shims);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the CLI shims for a desktop-metadata symlink (#7905)", () => {
    const { home, shims } = makeHome("nemoclaw-uninstall-conservative-", []);
    writeScopedGatewayState(home);
    fs.symlinkSync(
      "concealed-gateway-state",
      path.join(home, ".nemoclaw", "gateways", ".DS_Store"),
    );

    try {
      const { result, logs, survivors } = uninstall(home, shims);

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(SCOPED_RETENTION_LOG);
      expect(survivors).toEqual(shims);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
