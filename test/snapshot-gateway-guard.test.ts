// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #2673: snapshot restore/create must reject when
// the openshell-cluster gateway container is stopped, even when
// `openshell sandbox list` lies and returns exit 0 with stale data.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

type CliRunResult = { code: number; out: string };

function runCli(
  args: string,
  env: Record<string, string | undefined> = {},
): CliRunResult {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
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

/**
 * Creates a temp HOME with:
 *  - registry containing sandbox "alpha"
 *  - fake openshell: `sandbox list` exits 0 with "alpha" in output (stale cache)
 *  - fake docker: `inspect` exits 0 but prints "false" (container stopped)
 *
 * This setup reproduces the exact failure mode from #2673: openshell returns
 * exit 0 with stale data, so the old isLive.status guard never fires.
 */
function makeStoppedGatewayEnv(prefix: string): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });

  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        alpha: {
          name: "alpha",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: "alpha",
    }),
    { mode: 0o600 },
  );

  // openshell lies: sandbox list exits 0 and lists alpha as Ready even though
  // the gateway container is down (reads stale local registry/cache).
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/bin/sh",
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      '  printf "NAME STATUS\\nalpha Ready\\n"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  // docker inspect: returns "false" for State.Running (gateway stopped).
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/bin/sh",
      'if [ "$1" = "inspect" ]; then',
      '  echo "false"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    HOME: home,
    PATH: `${localBin}:${process.env.PATH ?? ""}`,
  };
}

describe("snapshot gateway guard (#2673)", () => {
  it("snapshot restore rejects when gateway container is stopped", () => {
    const env = makeStoppedGatewayEnv("nemoclaw-snap-gw-restore-");
    const r = runCli("alpha snapshot restore s1", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Failed to query live sandbox state");
  });

  it("snapshot create rejects when gateway container is stopped", () => {
    const env = makeStoppedGatewayEnv("nemoclaw-snap-gw-create-");
    const r = runCli("alpha snapshot create", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Failed to query live sandbox state");
  });
});
