// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Exercise the supplied reload policy against the pinned gateway, without inference. */
export async function runRealOpenClawAgentReloadProof(options: {
  dist: string;
  nodeExecutable: string;
  gatewayConfig: Record<string, unknown>;
}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-reload-"));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        ...options.gatewayConfig,
        port,
        bind: "loopback",
        auth: { mode: "token", token: "agent-reload-test-token" },
      },
      agents: { defaults: { workspace: path.join(root, "main") }, entries: { main: {} } },
      plugins: { enabled: false },
      cron: { enabled: false },
      update: { checkOnStart: false },
      logging: { file: path.join(root, "gateway.log") },
    }),
  );
  const env = {
    PATH: `${path.dirname(options.nodeExecutable)}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENSHELL_SANDBOX: "1",
  };
  const entry = path.join(options.dist, "..", "openclaw.mjs");
  const gateway = spawn(options.nodeExecutable, [entry, "gateway", "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const captureDiagnosticTail = (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-64 * 1024);
  };
  gateway.stdout.on("data", captureDiagnosticTail);
  gateway.stderr.on("data", captureDiagnosticTail);
  const cli = (...args: string[]): string => {
    const result = spawnSync(options.nodeExecutable, [entry, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}\n${logs}`);
    return result.stdout;
  };
  try {
    const startupDeadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < startupDeadline && gateway.exitCode === null) {
      healthy = await fetch(`http://127.0.0.1:${port}/startupz`)
        .then((r) => r.ok)
        .catch(() => false);
      if (healthy) break;
      await delay(250);
    }
    assert(healthy, `gateway did not start: ${logs}`);
    cli(
      "agents",
      "add",
      "chilli-crab",
      "--non-interactive",
      "--workspace",
      path.join(root, "chilli-crab"),
      "--json",
    );
    const deadline = Date.now() + 20_000;
    let discovered = false;
    while (Date.now() < deadline) {
      const response = JSON.parse(cli("gateway", "call", "agents.list", "--json")) as {
        agents: { id: string }[];
      };
      discovered = response.agents.some((agent) => agent.id === "chilli-crab");
      if (discovered) break;
      await delay(300);
    }
    assert(discovered, `saved agent never appeared in the live gateway: ${logs}`);
    assert.equal(gateway.exitCode, null, logs);
    assert((await fetch(`http://127.0.0.1:${port}/startupz`)).ok, logs);
    if (process.platform === "linux") {
      // Force a restart-class change to fail at bind. The patched container
      // must exit, so its supervisor can observe failure instead of a live PID
      // with no listener (#4710).
      const nextConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      nextConfig.gateway.bind = "custom";
      nextConfig.gateway.customBindHost = "192.0.2.1";
      fs.writeFileSync(configPath, JSON.stringify(nextConfig));
      const exitDeadline = Date.now() + 60_000;
      while (gateway.exitCode === null && Date.now() < exitDeadline) await delay(250);
      assert.notEqual(gateway.exitCode, null, `failed restart left the gateway alive: ${logs}`);
      assert.notEqual(gateway.exitCode, 0, `failed restart reported success: ${logs}`);
      assert.match(
        logs,
        /gateway bind=custom requested 192\.0\.2\.1 but resolved .*; refusing fallback/,
        `restart failed for a reason other than the requested invalid bind: ${logs}`,
      );
    }
  } finally {
    if (gateway.exitCode === null) {
      const exited = once(gateway, "exit");
      gateway.kill("SIGTERM");
      const killTimer = setTimeout(() => gateway.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killTimer);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
