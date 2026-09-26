// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { it } from "vitest";

it("rechecks a compatible endpoint after a gateway claims its port", () => {
  const repoRoot = path.join(import.meta.dirname, "../../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proxy-port-recheck-"));
  const scriptPath = path.join(tmpDir, "proxy-port-recheck.js");
  const proxyPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
  );
  const routePath = JSON.stringify(
    path.join(
      repoRoot,
      "src",
      "lib",
      "onboard",
      "inference-providers",
      "compatible-endpoint-gateway-route.ts",
    ),
  );
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

let spawnCount = 0;
childProcess.spawn = () => {
  spawnCount += 1;
  return { pid: 7777, unref() {} };
};

const endpointUrl = "http://127.0.0.1:18080/v1";
const route = require(${routePath});
const acceptedBeforeGatewayState = route.isLoopbackNoAuthCompatibleEndpointUrl(
  "compatible-endpoint",
  endpointUrl,
);

fs.mkdirSync(path.join(process.env.HOME, ".nemoclaw", "gateways", "18080"), {
  recursive: true,
});

let errorMessage = null;
try {
  require(${proxyPath}).noAuthProxy(endpointUrl);
} catch (error) {
  errorMessage = error.message;
}

console.log(JSON.stringify({
  acceptedBeforeGatewayState,
  errorMessage,
  spawnCount,
  tokenPersisted: fs.existsSync(
    path.join(process.env.HOME, ".nemoclaw", "ollama-proxy-token"),
  ),
}));
`;
  fs.writeFileSync(scriptPath, script);

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpDir },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as {
      acceptedBeforeGatewayState: boolean;
      errorMessage: string | null;
      spawnCount: number;
      tokenPersisted: boolean;
    };
    assert.equal(payload.acceptedBeforeGatewayState, true);
    assert.equal(
      payload.errorMessage,
      "The no-authentication endpoint is no longer eligible for proxy routing.",
    );
    assert.equal(payload.spawnCount, 0);
    assert.equal(payload.tokenPersisted, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it("rebuilds an authorized legacy route through the moved proxy port", () => {
  const repoRoot = path.join(import.meta.dirname, "../../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proxy-legacy-rebuild-"));
  const scriptPath = path.join(tmpDir, "proxy-legacy-rebuild.js");
  const proxyPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
childProcess.spawn = (_cmd, _args, options = {}) => {
  proxySpawns.push({
    backendUrl: options.env && options.env.OLLAMA_BACKEND_URL,
    proxyPort: options.env && options.env.OLLAMA_PROXY_PORT,
  });
  return { pid: 7777, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("12435")) return "";
  if (text.includes("ps -p 7777")) return "node /repo/scripts/ollama-auth-proxy.mts";
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") return { error: null, status: 0, stdout: "", stderr: "" };
  if (args[0] === "curl") {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    return { status: 0, stdout: argv.includes("--config") ? "200" : "401", stderr: "" };
  }
  return originalSpawnSync(...args);
};
require("node:module").syncBuiltinESMExports();

const proxy = require(${proxyPath});
const prepared = proxy.noAuthProxy("http://127.0.0.1:11435/v1", {
  allowLegacyRecordedEndpoint: true,
});
prepared.persist();
const stateDir = path.join(process.env.HOME, ".nemoclaw");

console.log(JSON.stringify({
  baseUrl: prepared.baseUrl,
  proxySpawns,
  persistedBackend: fs.readFileSync(path.join(stateDir, "ollama-backend"), "utf8").trim(),
  descriptor: JSON.parse(fs.readFileSync(path.join(stateDir, "ollama-backend.json"), "utf8")),
}));
`;
  fs.writeFileSync(scriptPath, script);

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_OLLAMA_PROXY_PORT: "12435",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
    assert.equal(payload.baseUrl, "http://host.openshell.internal:12435/v1");
    assert.deepEqual(payload.proxySpawns, [
      { backendUrl: "http://127.0.0.1:11435", proxyPort: "12435" },
    ]);
    assert.equal(payload.persistedBackend, "http://127.0.0.1:11435");
    assert.deepEqual(payload.descriptor, {
      schemaVersion: 1,
      kind: "compatible-endpoint",
      url: "http://127.0.0.1:11435",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
