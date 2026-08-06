// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

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

function uninstall(home: string, shims: readonly string[]) {
  const logs: string[] = [];
  const removed: string[] = [];
  const result = runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell: false },
    {
      commandExists: (command) => command !== "docker" && command !== "lsof" && command !== "pgrep",
      env: { HOME: home } as NodeJS.ProcessEnv,
      existsSync: (target) => shims.includes(target),
      isTty: false,
      log: (line) => logs.push(line),
      rmSync: vi.fn((target: fs.PathLike) => {
        removed.push(String(target));
      }),
      run: vi.fn(okWithKnownGatewayList),
      runDocker: () => ok(""),
    },
  );
  return { result, logs, removed };
}

describe("uninstall gateway-directory scan", () => {
  it("removes the CLI shims when the gateways directory holds only desktop metadata (#7905)", () => {
    const { home, shims } = makeHome("nemoclaw-uninstall-dsstore-", [".DS_Store"]);

    try {
      const { result, logs, removed } = uninstall(home, shims);

      expect(result.exitCode).toBe(0);
      expect(logs).not.toContain(SCOPED_RETENTION_LOG);
      expect(removed).toEqual(expect.arrayContaining(shims));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the CLI shims when the gateways directory holds an unidentified entry (#7905)", () => {
    const { home, shims } = makeHome("nemoclaw-uninstall-unknown-", ["not-a-port"]);

    try {
      const { result, logs, removed } = uninstall(home, shims);

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(SCOPED_RETENTION_LOG);
      expect(removed).not.toEqual(expect.arrayContaining(shims));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the CLI shims when a directory carries a desktop metadata name (#7905)", () => {
    const { home, shims } = makeHome("nemoclaw-uninstall-dsstore-dir-", [".DS_Store/"]);

    try {
      const { result, logs, removed } = uninstall(home, shims);

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(SCOPED_RETENTION_LOG);
      expect(removed).not.toEqual(expect.arrayContaining(shims));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
