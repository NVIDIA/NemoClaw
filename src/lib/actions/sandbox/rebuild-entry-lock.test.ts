// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { expect, test } from "../../../../test/helpers/owned-test-resources";

test.for(["registered", "missing"] as const)(
  "frames the %s rebuild target's live host-lock stop without changing state (#13808)",
  { timeout: 30000 },
  async (target, { resources, testHome }) => {
    const stateDir = path.join(testHome.home, ".nemoclaw", "gateways", "9000");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const registryFile = path.join(stateDir, "sandboxes.json");
    const registryBytes = JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "openclaw",
          gatewayPort: 9000,
          gatewayName: "nemoclaw-9000",
          provider: "nvidia",
          model: "nvidia/test",
        },
      },
    });
    fs.writeFileSync(registryFile, registryBytes, { mode: 0o600 });
    const env = testHome.environment({ NEMOCLAW_GATEWAY_PORT: "9000" });
    const hostLock = path.join(testHome.home, ".nemoclaw-portable-host.lock");
    const holder = resources.ownChild(
      spawn(
        process.execPath,
        [
          "--require",
          "tsx/cjs",
          "-e",
          `
    const session = require(process.argv[1]);
    const { acquireProcessBoundLockAt } = require(process.argv[2]);
    acquireProcessBoundLockAt(process.argv[3]);
    if (!session.acquireOnboardLock("nemoclaw onboard").acquired) throw new Error("onboarding lock unavailable");
    process.stdout.write("locked\\n");
    setInterval(() => {}, 1000);
  `,
          fileURLToPath(new URL("../../state/onboard-session.ts", import.meta.url)),
          fileURLToPath(new URL("../../state/registry/lock.ts", import.meta.url)),
          hostLock,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    await Promise.race([
      once(holder.stdout!, "data"),
      once(holder, "exit").then(() => {
        throw new Error("lock holder exited before acquisition");
      }),
    ]);
    const onboardLock = path.join(stateDir, "onboard.lock");
    const onboardBytes = fs.readFileSync(onboardLock, "utf8");
    const ownerBytes = fs.readFileSync(path.join(hostLock, "owner"), "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        "tsx/cjs",
        "-e",
        `
      const operation = process.argv[2] === "registered"
        ? require(process.argv[1]).rebuildSandbox("alpha", ["--yes"], { throwOnError: true })
        : require(process.argv[1]).dispatchCli(["missing", "rebuild", "--yes"]);
      operation.catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  `,
        target === "registered"
          ? fileURLToPath(new URL("./rebuild.ts", import.meta.url))
          : fileURLToPath(new URL("../../cli/public-dispatch.ts", import.meta.url)),
        target,
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Rebuild preflight failed:");
    expect(result.stderr).toContain("onboarding");
    expect(result.stderr).toContain(String(holder.pid));
    expect(result.stderr).toContain("Wait");
    expect(result.stderr).toContain("Do not delete the lock manually");
    expect(result.stderr).toContain("Aborting rebuild");
    expect(result.stderr).toContain("sandbox is untouched, no data was lost.");
    expect(fs.readFileSync(registryFile, "utf8")).toBe(registryBytes);
    expect(fs.readFileSync(onboardLock, "utf8")).toBe(onboardBytes);
    expect(fs.readFileSync(path.join(hostLock, "owner"), "utf8")).toBe(ownerBytes);
    expect(holder.exitCode).toBeNull();
  },
);
