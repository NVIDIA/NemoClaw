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
