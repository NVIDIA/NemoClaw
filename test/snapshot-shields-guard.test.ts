// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #4493: `snapshot create` while shields are up must
// surface a shields/audit/lock keyword and a recovery command (spec T5999692),
// not the generic "Snapshot failed. Failed directories: ..." wording.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execTimeout } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

type CliRunResult = { code: number; out: string };

function runCli(args: string[], env: Record<string, string | undefined> = {}): CliRunResult {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "status" in err) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      const out = [e.stdout, e.stderr]
        .map((b) => (typeof b === "string" ? b : b ? b.toString("utf-8") : ""))
        .join("");
      return { code: typeof e.status === "number" ? e.status : 1, out };
    }
    return { code: 1, out: String(err) };
  }
}

function writeExecutable(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, ["#!/bin/sh", ...lines].join("\n"), { mode: 0o755 });
}

function writeSandboxRegistry(home: string, sandboxName: string): void {
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: sandboxName,
    }),
    { mode: 0o600 },
  );
}

/**
 * shieldsDown: false + an updatedAt timestamp + an existing state file is the
 * "locked" mode per deriveShieldsMode in src/lib/shields/index.ts.
 */
function writeShieldsLocked(home: string, sandboxName: string): void {
  const stateDir = path.join(home, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsDownTimeout: null,
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
}

/**
 * Healthy-gateway env: openshell `sandbox list` reports alpha as Ready, docker
 * `inspect` reports the gateway container as Running. The shields state file
 * is left unset so the caller can opt into "locked" via writeShieldsLocked.
 */
function makeHealthyGatewayEnv(prefix: string): { home: string; env: Record<string, string> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home, "alpha");

  writeExecutable(path.join(localBin, "openshell"), [
    'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
    '  printf "NAME STATUS\\nalpha Ready\\n"',
    "  exit 0",
    "fi",
    "exit 0",
  ]);
  writeExecutable(path.join(localBin, "docker"), [
    'if [ "$1" = "inspect" ]; then echo "true"; exit 0; fi',
    "exit 0",
  ]);

  return {
    home,
    env: {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH ?? ""}`,
    },
  };
}

describe("snapshot create — shields-up guard (#4493)", () => {
  it("rejects snapshot create when shields are up with a shields-aware error", () => {
    const { home, env } = makeHealthyGatewayEnv("nemoclaw-snap-shields-up-");
    writeShieldsLocked(home, "alpha");

    const r = runCli(["alpha", "snapshot", "create"], env);

    expect(r.code).toBe(1);
    expect(r.out).toContain("shields are up");
    expect(r.out).toContain("shields down");
    expect(r.out).not.toContain("Failed directories:");
  });

  it("does not block snapshot create when shields are not configured (mutable default)", () => {
    const { env } = makeHealthyGatewayEnv("nemoclaw-snap-shields-default-");

    const r = runCli(["alpha", "snapshot", "create"], env);

    expect(r.out).not.toContain("shields are up");
  });
});
