// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { expect, test } from "../../../../test/helpers/owned-test-resources";
import { SOURCE_REQUIRE_HOOK } from "../../../../test/helpers/source-loader-options";

// Passing CI shards ran each case in 2.2-4.7 s, including lock-holder startup
// (#14689). This deadline allows slower runners and still reports the child's
// stderr before the 30 s test timeout.
const REBUILD_CHILD_TIMEOUT_MS = 20_000;

function firstOutput(child: ChildProcess, label: string, stderr: () => string): Promise<unknown> {
  return Promise.race([
    once(child.stdout!, "data"),
    once(child, "exit").then(() => {
      throw new Error(`${label} exited before it was ready: ${stderr()}`);
    }),
  ]);
}

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
    // Loading the CLI runner probes Docker with 3 s deadlines. A stalled host
    // daemon pushed this child past its deadline in CI (#14689), and the
    // preflight under test needs no Docker, so the probe sees none.
    fs.writeFileSync(path.join(testHome.bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = testHome.environment({ NEMOCLAW_GATEWAY_PORT: "9000" });
    const hostLock = path.join(testHome.home, ".nemoclaw-portable-host.lock");
    const holder = resources.ownChild(
      spawn(
        process.execPath,
        [
          "--require",
          SOURCE_REQUIRE_HOOK,
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
    // Load the rebuild entry while the holder starts, then run it once the locks are held.
    const rebuild = resources.ownChild(
      spawn(
        process.execPath,
        [
          "--require",
          SOURCE_REQUIRE_HOOK,
          "-e",
          `
      const entry = require(process.argv[1]);
      process.stdin.once("data", () => {
        process.stdin.destroy();
        const operation = process.argv[2] === "registered"
          ? entry.rebuildSandbox("alpha", ["--yes"], { throwOnError: true })
          : entry.dispatchCli(["missing", "rebuild", "--yes"]);
        operation.catch(error => {
          console.error(error.message);
          process.exitCode = 1;
        });
      });
      process.stdout.write("ready\\n");
  `,
          target === "registered"
            ? fileURLToPath(new URL("./rebuild.ts", import.meta.url))
            : fileURLToPath(new URL("../../cli/public-dispatch.ts", import.meta.url)),
          target,
        ],
        { env, stdio: ["pipe", "pipe", "pipe"], timeout: REBUILD_CHILD_TIMEOUT_MS },
      ),
    );
    let stderr = "";
    rebuild.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(rebuild, "close");
    await Promise.all([
      firstOutput(holder, "lock holder", () => ""),
      firstOutput(rebuild, "rebuild entry", () => stderr),
    ]);
    const onboardLock = path.join(stateDir, "onboard.lock");
    const onboardBytes = fs.readFileSync(onboardLock, "utf8");
    const ownerBytes = fs.readFileSync(path.join(hostLock, "owner"), "utf8");

    rebuild.stdin!.end("run\n");
    const [status, signal] = await closed;

    expect(signal, stderr).toBeNull();
    expect(status, stderr).toBe(1);
    expect(stderr).toContain("Rebuild preflight failed:");
    expect(stderr).toContain("onboarding");
    expect(stderr).toContain(String(holder.pid));
    expect(stderr).toContain("Wait");
    expect(stderr).toContain("Do not delete the lock manually");
    expect(stderr).toContain("Aborting rebuild");
    expect(stderr).toContain("sandbox is untouched, no data was lost.");
    expect(fs.readFileSync(registryFile, "utf8")).toBe(registryBytes);
    expect(fs.readFileSync(onboardLock, "utf8")).toBe(onboardBytes);
    expect(fs.readFileSync(path.join(hostLock, "owner"), "utf8")).toBe(ownerBytes);
    expect(holder.exitCode).toBeNull();
  },
);
