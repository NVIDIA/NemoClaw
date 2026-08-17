// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
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
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function withManagedGatewayAuthority(deps: UninstallRunDeps): UninstallRunDeps {
  return withProvenManagedGatewayProcess({
    isPortFree: () => true,
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

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, withManagedGatewayAuthority(deps));
}

function okWithKnownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

function okWithSiblingGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9123" }]))
    : ok();
}

const SCOPED_RETENTION_LOG =
  "Sibling gateways remain; kept the shared NemoClaw CLI and shell shims.";
const SCOPED_PACKAGE_RETENTION_LOG =
  "Sibling gateways remain; kept the shared NemoClaw CLI package.";
const DESTROY_SHIM_CLEANUP_LOG =
  "Removed managed user-local CLI shims because --destroy-user-data was set.";

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

function writeScopedGatewayState(home: string, port = 8080): void {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(port));
  const configPath = path.join(stateDir, "openshell-gateway.toml");
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    configPath,
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
  fs.chmodSync(configPath, 0o600);
  writeManagedGatewayRuntimeProof(stateDir, port);
}

/**
 * Runs the plan and reports which shims are still on disk afterwards. Removal
 * goes through the real filesystem, restricted to the temporary home, so the
 * assertions read the outcome rather than the calls a test double recorded.
 * Captures both `log` and `error` (runtime warnings) for assertion.
 */
function uninstall(
  home: string,
  shims: readonly string[],
  options: Pick<UninstallRunOptions, "destroyUserData"> & {
    run?: (command: string, args: readonly string[]) => RunResult;
  } = {},
) {
  const logs: string[] = [];
  const result = runUninstallPlan(
    {
      assumeYes: true,
      deleteModels: false,
      destroyUserData: options.destroyUserData ?? false,
      keepOpenShell: true,
    },
    {
      commandExists: (command) => command === "openshell",
      env: { HOME: home, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
      existsSync: (target) => String(target).startsWith(home) && fs.existsSync(target),
      hasPortableRuntimeCleanup: () => false,
      isTty: false,
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
      rmSync: vi.fn((target: fs.PathLike, rmOptions?: fs.RmOptions) => {
        String(target).startsWith(home) ? fs.rmSync(target, rmOptions) : undefined;
      }),
      run: vi.fn(options.run ?? okWithKnownGatewayList),
      runDocker: () => ok(""),
    },
  );
  return { result, logs, survivors: shims.filter((shim) => fs.existsSync(shim)) };
}

function writeForeignCliShims(shims: readonly string[]): void {
  for (const shim of shims) {
    fs.writeFileSync(shim, "#!/usr/bin/env node\nconsole.log('foreign')\n", { mode: 0o755 });
  }
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

  it.skipIf(process.platform === "win32")(
    "keeps the CLI shims for a desktop-metadata symlink (#7905)",
    () => {
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
    },
  );

  it.each([
    ["not-a-port"],
    ["._"],
    [".DS_Store/"],
  ])(
    "removes managed CLI shims with --destroy-user-data when the gateways directory holds %s (#9277)",
    (entry) => {
      const { home, shims } = makeHome("nemoclaw-uninstall-destroy-shim-", [entry]);
      writeScopedGatewayState(home);

      try {
        const { result, logs, survivors } = uninstall(home, shims, { destroyUserData: true });

        expect(result.exitCode).toBe(0);
        expect(logs).toContain(SCOPED_PACKAGE_RETENTION_LOG);
        expect(logs).toContain(DESTROY_SHIM_CLEANUP_LOG);
        expect(logs).not.toContain(SCOPED_RETENTION_LOG);
        expect(survivors).toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("preserves foreign CLI files under --destroy-user-data without claiming removal (#9277)", () => {
    const { home, shims } = makeHome("nemoclaw-uninstall-destroy-foreign-", ["not-a-port"]);
    writeScopedGatewayState(home);
    writeForeignCliShims(shims);

    try {
      const { result, logs, survivors } = uninstall(home, shims, { destroyUserData: true });

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(SCOPED_PACKAGE_RETENTION_LOG);
      expect(logs).not.toContain(DESTROY_SHIM_CLEANUP_LOG);
      expect(logs).not.toContain(SCOPED_RETENTION_LOG);
      expect(logs.some((line) => line.includes("not an installer-managed shim"))).toBe(true);
      expect(survivors).toEqual(shims);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps managed CLI shims with --destroy-user-data when a confirmed sibling gateway remains (#9277)", () => {
    const { home, shims } = makeHome("nemoclaw-uninstall-destroy-sibling-", []);
    writeScopedGatewayState(home);

    try {
      const { result, logs, survivors } = uninstall(home, shims, {
        destroyUserData: true,
        run: okWithSiblingGatewayList,
      });

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(SCOPED_RETENTION_LOG);
      expect(logs).not.toContain(DESTROY_SHIM_CLEANUP_LOG);
      expect(logs).not.toContain(SCOPED_PACKAGE_RETENTION_LOG);
      expect(survivors).toEqual(shims);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
