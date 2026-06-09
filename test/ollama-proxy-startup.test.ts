// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

/** Parse JSON from the last stdout line, stripping any non-JSON prefix. */
function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  if (!line) {
    throw new Error("Expected JSON payload on the last stdout line");
  }
  return JSON.parse(line);
}

interface StartupResult {
  returned: boolean;
  spawnCount: number;
  ncCalls: number;
  authedProbes: number;
  unauthProbes: number;
  killCommands: string[][];
}

/**
 * Run a child process that mocks the runner/child_process boundary and calls
 * startOllamaAuthProxy() against the compiled proxy module. `setup` is inlined
 * verbatim into the child and defines the runCapture / spawnSync behavior for
 * the scenario under test.
 */
function runStartupScenario(setup: string): {
  status: number | null;
  stderr: string;
  payload: StartupResult;
} {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-startup-"));
  const scriptPath = path.join(tmpDir, "startup-check.js");
  const proxyPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "inference", "ollama", "proxy.js"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

  const script = String.raw`
const childProcess = require("child_process");
const runner = require(${runnerPath});

let spawnCount = 0;
let ncCalls = 0;
let authedProbes = 0;
let unauthProbes = 0;
const killCommands = [];

${setup}

// Default runner.run is a no-op success (used for kill in killStaleProxy).
if (!runner.run.__mocked) {
  runner.run = () => ({ status: 0, stdout: "", stderr: "" });
}

const proxy = require(${proxyPath});
const returned = proxy.startOllamaAuthProxy();
console.log(JSON.stringify({ returned, spawnCount, ncCalls, authedProbes, unauthProbes, killCommands }));
`;
  fs.writeFileSync(scriptPath, script);

  // The mocks and assertions hard-code the default ports (proxy :11435,
  // backend :11434), so strip any inherited overrides to keep the child
  // deterministic regardless of the caller's environment.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: tmpDir };
  delete childEnv.NEMOCLAW_OLLAMA_PROXY_PORT;
  delete childEnv.NEMOCLAW_OLLAMA_PORT;

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: childEnv,
  });

  return {
    status: result.status,
    stderr: result.stderr,
    payload: parseStdoutJson<StartupResult>(result.stdout),
  };
}

describe("startOllamaAuthProxy", () => {
  it("reports the owning process and remediation when a foreign process holds the port", () => {
    const { payload, stderr } = runStartupScenario(String.raw`
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("11435")) return "2222";
  if (text.includes("ps -p 2222")) return "/usr/bin/python3 -m http.server 11435";
  return "";
};
childProcess.spawn = () => { spawnCount += 1; return { pid: 7777, unref() {} }; };
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") { ncCalls += 1; return { error: null, status: 0, stdout: "", stderr: "" }; }
  if (args[0] === "curl") {
    // proxyOwnsPortWithToken: authenticated probe (--config) → 200 (accepted);
    // unauthenticated probe → 401 (rejected). Together they mark the listener
    // as our auth proxy holding the token. Count each so tests can assert BOTH
    // halves of the readiness proof actually ran.
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const authed = argv.includes("--config");
    if (authed) { authedProbes += 1; } else { unauthProbes += 1; }
    return { status: 0, stdout: authed ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};
`);

    assert.equal(payload.returned, false);
    // Conflict is detected before any proxy is spawned.
    assert.equal(payload.spawnCount, 0);
    assert.match(stderr, /port 11435 is already in use/);
    assert.match(stderr, /PID 2222: \/usr\/bin\/python3 -m http\.server 11435/);
    assert.match(stderr, /kill 2222/);
    assert.match(stderr, /NEMOCLAW_OLLAMA_PROXY_PORT=<port>/);
  });

  it("starts the proxy when the port is free and the process binds it", () => {
    const { payload } = runStartupScenario(String.raw`
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("11435")) return "";
  if (text.includes("ps -p 7777")) return "node /repo/scripts/ollama-auth-proxy.js";
  return "";
};
childProcess.spawn = () => { spawnCount += 1; return { pid: 7777, unref() {} }; };
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") { ncCalls += 1; return { error: null, status: 0, stdout: "", stderr: "" }; }
  if (args[0] === "curl") {
    // proxyOwnsPortWithToken: authenticated probe (--config) → 200 (accepted);
    // unauthenticated probe → 401 (rejected). Together they mark the listener
    // as our auth proxy holding the token. Count each so tests can assert BOTH
    // halves of the readiness proof actually ran.
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const authed = argv.includes("--config");
    if (authed) { authedProbes += 1; } else { unauthProbes += 1; }
    return { status: 0, stdout: authed ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};
`);

    assert.equal(payload.returned, true);
    assert.equal(payload.spawnCount, 1);
    // The readiness proof must run BOTH probes: a regression that accepted only
    // the authenticated 200 (dropping the unauthenticated-401 check) would fail.
    assert.ok(payload.authedProbes >= 1, "expected an authenticated token probe");
    assert.ok(payload.unauthProbes >= 1, "expected an unauthenticated 401 probe");
  });

  it("starts despite an IPv6-only listener the IPv4-scoped preflight ignores", () => {
    // Pins the address-family contract: the pre-start conflict check must use an
    // IPv4-scoped lsof (-ti4TCP), since the proxy binds IPv4 0.0.0.0. An IPv6-only
    // listener does not block that bind, so startup must still succeed. The stub
    // returns a foreign owner ONLY for a broad (-tiTCP) query — if the preflight
    // regressed to the broad probe it would see the owner and falsely abort,
    // failing this test.
    const { payload } = runStartupScenario(String.raw`
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("11435")) {
    // IPv4-scoped query: the IPv6-only listener is invisible → no conflict.
    if (text.includes("-ti4TCP") || text.includes("-i4")) return "";
    // Broad query would surface the IPv6-only owner (PID 9999).
    return "9999";
  }
  if (text.includes("ps -p 9999")) return "/usr/sbin/foreign-ipv6-service --listen [::1]:11435";
  if (text.includes("ps -p 7777")) return "node /repo/scripts/ollama-auth-proxy.js";
  return "";
};
childProcess.spawn = () => { spawnCount += 1; return { pid: 7777, unref() {} }; };
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") { ncCalls += 1; return { error: null, status: 0, stdout: "", stderr: "" }; }
  if (args[0] === "curl") {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const authed = argv.includes("--config");
    if (authed) { authedProbes += 1; } else { unauthProbes += 1; }
    return { status: 0, stdout: authed ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};
`);

    assert.equal(
      payload.returned,
      true,
      "IPv6-only listener must not abort the IPv4 proxy startup",
    );
    assert.equal(payload.spawnCount, 1);
    assert.ok(payload.authedProbes >= 1 && payload.unauthProbes >= 1);
  });

  it("recovers when a slow host binds the port only after a retry", () => {
    const { payload } = runStartupScenario(String.raw`
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("11435")) return "";
  if (text.includes("ps -p 7777")) return "node /repo/scripts/ollama-auth-proxy.js";
  return "";
};
childProcess.spawn = () => { spawnCount += 1; return { pid: 7777, unref() {} }; };
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") {
    ncCalls += 1;
    // Not listening for the first attempt's polling window, then ready.
    return { error: null, status: ncCalls < 8 ? 1 : 0, stdout: "", stderr: "" };
  }
  if (args[0] === "curl") {
    // proxyOwnsPortWithToken: authenticated probe (--config) → 200 (accepted);
    // unauthenticated probe → 401 (rejected). Together they mark the listener
    // as our auth proxy holding the token. Count each so tests can assert BOTH
    // halves of the readiness proof actually ran.
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const authed = argv.includes("--config");
    if (authed) { authedProbes += 1; } else { unauthProbes += 1; }
    return { status: 0, stdout: authed ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};
`);

    assert.equal(payload.returned, true);
    assert.equal(payload.spawnCount, 1);
    // Proves the outer retry loop crossed at least one full waitForPort window.
    assert.ok(payload.ncCalls >= 6, "expected the proxy port to be polled across retries");
    // Both halves of the readiness proof still run on the successful retry.
    assert.ok(payload.authedProbes >= 1, "expected an authenticated token probe");
    assert.ok(payload.unauthProbes >= 1, "expected an unauthenticated 401 probe");
  });

  it("reports a spawn failure distinctly from a port conflict", () => {
    const { payload, stderr } = runStartupScenario(String.raw`
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  // Port stays free: the spawned proxy exited without anyone owning the port.
  if (text.includes("lsof") && text.includes("11435")) return "";
  if (text.includes("ps -p 8888")) return "";
  return "";
};
childProcess.spawn = () => { spawnCount += 1; return { pid: 8888, unref() {} }; };
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") { ncCalls += 1; return { error: null, status: 0, stdout: "", stderr: "" }; }
  if (args[0] === "curl") {
    // proxyOwnsPortWithToken: authenticated probe (--config) → 200 (accepted);
    // unauthenticated probe → 401 (rejected). Together they mark the listener
    // as our auth proxy holding the token. Count each so tests can assert BOTH
    // halves of the readiness proof actually ran.
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const authed = argv.includes("--config");
    if (authed) { authedProbes += 1; } else { unauthProbes += 1; }
    return { status: 0, stdout: authed ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};
`);

    assert.equal(payload.returned, false);
    assert.equal(payload.spawnCount, 1);
    assert.match(stderr, /exited during startup/);
    assert.doesNotMatch(stderr, /already in use/);
  });

  it("reclaims a prior NemoClaw proxy on the port instead of reporting a conflict", () => {
    const { payload, stderr } = runStartupScenario(String.raw`
// Reclaim is driven by the ACTUAL kill of pid 4242: the port/process only frees
// up once killStaleProxy issues \`kill 4242\`. A regression that skips reclaiming
// it leaves reclaimed=false, so lsof keeps reporting 4242 and startup cannot
// succeed — the killCommands assertion below then fails.
let reclaimed = false;
runner.run = (command) => {
  killCommands.push(command);
  if (Array.isArray(command) && command[0] === "kill" && command[1] === "4242") {
    reclaimed = true;
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.run.__mocked = true;
// The persisted pid 4242 is a live NemoClaw proxy that currently owns the port.
// After killStaleProxy reclaims it, the freshly spawned pid 7777 binds the port.
const fs2 = require("node:fs");
const path2 = require("node:path");
const stateDir = path2.join(process.env.HOME, ".nemoclaw");
fs2.mkdirSync(stateDir, { recursive: true });
fs2.writeFileSync(path2.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("11435")) return reclaimed ? "" : "4242";
  if (text.includes("ps -p 4242")) return reclaimed ? "" : "node /repo/scripts/ollama-auth-proxy.js";
  if (text.includes("ps -p 7777")) return "node /repo/scripts/ollama-auth-proxy.js";
  return "";
};
childProcess.spawn = () => { spawnCount += 1; return { pid: 7777, unref() {} }; };
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") { return { status: 0, stdout: "", stderr: "" }; }
  if (args[0] === "nc") { ncCalls += 1; return { error: null, status: 0, stdout: "", stderr: "" }; }
  if (args[0] === "curl") {
    // proxyOwnsPortWithToken: authenticated probe (--config) → 200 (accepted);
    // unauthenticated probe → 401 (rejected). Together they mark the listener
    // as our auth proxy holding the token. Count each so tests can assert BOTH
    // halves of the readiness proof actually ran.
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const authed = argv.includes("--config");
    if (authed) { authedProbes += 1; } else { unauthProbes += 1; }
    return { status: 0, stdout: authed ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};
`);

    assert.equal(payload.returned, true);
    assert.equal(payload.spawnCount, 1);
    assert.doesNotMatch(stderr, /already in use/);
    // The stale proxy must actually be reclaimed: assert `kill 4242` was issued.
    assert.ok(
      payload.killCommands.some(
        (cmd) => Array.isArray(cmd) && cmd[0] === "kill" && cmd[1] === "4242",
      ),
      "expected killStaleProxy to issue `kill 4242`",
    );
  });
});
