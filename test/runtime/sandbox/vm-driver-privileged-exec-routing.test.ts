// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const helperPath = require.resolve("../src/lib/sandbox/privileged-exec");
const dockerRunPath = require.resolve("../src/lib/adapters/docker/run");
const registryPath = require.resolve("../src/lib/state/registry");

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"\${XDG_NEMOCLAW_FAKE_DOCKER_LOG:?}"
if [ "\${1:-}" = "ps" ]; then
  cat "\${XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE:?}"
  exit 0
fi
echo "unexpected fake docker invocation: $*" >&2
exit 64
`;

type PrivilegedExecHelper = typeof import("../src/lib/sandbox/privileged-exec");

const restoredEnvKeys = new Set([
  "HOME",
  "PATH",
  "XDG_NEMOCLAW_FAKE_DOCKER_LOG",
  "XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE",
]);
const originalEnv = new Map<string, string | undefined>();

function rememberEnv(): void {
  for (const key of restoredEnvKeys) {
    if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
  }
}

function restoreEnv(): void {
  for (const [key, value] of originalEnv.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
}

function clearDistModuleCache(): void {
  for (const modulePath of [helperPath, dockerRunPath, registryPath]) {
    delete require.cache[modulePath];
  }
}

function writeRegistry(
  home: string,
  entries: Array<{ name: string; openshellDriver: string | null }>,
): void {
  const sandboxes = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "sandboxes.json"),
    `${JSON.stringify({ defaultSandbox: entries[0]?.name ?? null, sandboxes }, null, 2)}\n`,
  );
}

function writeDockerPs(psFile: string, rows: Array<[string, string]>): void {
  fs.writeFileSync(psFile, `${rows.map((row) => row.join("\t")).join("\n")}\n`);
}

function assertDirect(args: string[], expectedContainer: string, label: string): void {
  expect(args, `${label} should route to the direct sandbox container`).toEqual([
    "exec",
    "--user",
    "root",
    expectedContainer,
    "stat",
    "-c",
    "%a",
    "/sandbox/.openclaw/openclaw.json",
  ]);
  expect(args, `${label} must not route through the gateway container`).not.toContain(
    "openshell-gateway-nemoclaw",
  );
}

function loadHelperWithFakeHome(
  home: string,
  fakeBin: string,
  dockerPsFile: string,
  dockerLog: string,
): PrivilegedExecHelper {
  rememberEnv();
  process.env.HOME = home;
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
  process.env.XDG_NEMOCLAW_FAKE_DOCKER_LOG = dockerLog;
  process.env.XDG_NEMOCLAW_FAKE_DOCKER_PS_FILE = dockerPsFile;
  clearDistModuleCache();
  return require(helperPath) as PrivilegedExecHelper;
}

afterEach(() => {
  clearDistModuleCache();
  restoreEnv();
});

describe("VM/Docker privileged-exec routing regression (#4245)", () => {
  it("uses direct sandbox containers instead of gateway containers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vm-driver-privexec-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const fakeHome = path.join(tmp, "home");
      const dockerPsFile = path.join(tmp, "docker-ps.txt");
      const dockerLog = path.join(tmp, "docker.log");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(fakeHome, { recursive: true });
      fs.writeFileSync(dockerPsFile, "");
      fs.writeFileSync(dockerLog, "");
      fs.writeFileSync(path.join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
      writeRegistry(fakeHome, [
        { name: "alpha", openshellDriver: "vm" },
        { name: "alpha-child", openshellDriver: "vm" },
        { name: "dockerbox", openshellDriver: "docker" },
        { name: "unknown-driver", openshellDriver: null },
      ]);

      const helper = loadHelperWithFakeHome(fakeHome, fakeBin, dockerPsFile, dockerLog);
      const cmd = ["stat", "-c", "%a", "/sandbox/.openclaw/openclaw.json"];

      writeDockerPs(dockerPsFile, [["alpha-id", "openshell-alpha-abc123"]]);
      assertDirect(helper.privilegedSandboxExecArgv("alpha", cmd), "alpha-id", "VM driver");
      writeDockerPs(dockerPsFile, [["alpha-child-id", "openshell-alpha-child-2026"]]);
      assertDirect(
        helper.privilegedSandboxExecArgv("alpha-child", cmd),
        "alpha-child-id",
        "VM driver child",
      );
      writeDockerPs(dockerPsFile, [["dockerbox-id", "openshell-dockerbox-987"]]);
      assertDirect(
        helper.privilegedSandboxExecArgv("dockerbox", cmd),
        "dockerbox-id",
        "Docker driver",
      );
      writeDockerPs(dockerPsFile, [["unknown-id", "openshell-unknown-driver"]]);
      assertDirect(
        helper.privilegedSandboxExecArgv("unknown-driver", cmd),
        "unknown-id",
        "registry entry without a recorded driver",
      );

      writeDockerPs(dockerPsFile, []);
      expect(() => helper.privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
        /No running direct OpenShell sandbox container found for 'alpha'.*driver: vm/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
