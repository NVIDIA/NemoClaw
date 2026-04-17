// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distLib = path.join(import.meta.dirname, "..", "dist", "lib");

// Pre-load the SUT's dependencies and monkey-patch their exports before
// loading api.js. vi.mock doesn't reliably intercept transitive require()
// calls inside CJS modules imported from ESM tests, so the codebase
// convention (see test/runner.test.js) is direct monkey-patching.
const registry = require(path.join(distLib, "registry"));
const metrics = require(path.join(distLib, "api-metrics"));
const commands = require(path.join(distLib, "api-commands"));

registry.listSandboxes = () => ({
  sandboxes: [{ name: "test-sandbox", provider: "nim" }],
  defaultSandbox: "test-sandbox",
});
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, provider: "nim" } : null);

metrics.getSandboxList = () => ({
  runtime: "docker",
  defaultSandbox: "test-sandbox",
  sandboxes: [{ name: "test-sandbox", provider: "nim", container: null }],
});

commands.stopSandbox = () => ({ ok: true, output: "stopped" });
commands.startSandbox = () => ({ ok: true, output: "started" });
commands.restartSandbox = () => ({ ok: true, output: "restarted" });
commands.runSandboxCommand = () => ({ ok: true, output: "command output" });
commands.readConfig = () => ({ provider: "nim" });
commands.writeConfig = () => {};

const { createApiServer } = require(path.join(distLib, "api"));

let server;
let baseUrl;

beforeAll(async () => {
  server = createApiServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${p}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on("error", reject);
  });
}

function post(p, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      `${baseUrl}${p}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("GET /sandboxes", () => {
  it("returns 200 with sandbox list", async () => {
    const { status, body } = await get("/sandboxes");
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.sandboxes).toHaveLength(1);
    expect(data.sandboxes[0].name).toBe("test-sandbox");
    expect(data.runtime).toBe("docker");
  });
});

describe("GET /sandboxes/:id", () => {
  it("returns 200 with sandbox detail for known sandbox", async () => {
    const { status, body } = await get("/sandboxes/test-sandbox");
    expect(status).toBe(200);
    expect(JSON.parse(body).name).toBe("test-sandbox");
  });

  it("returns 404 for unknown sandbox", async () => {
    const { status } = await get("/sandboxes/unknown");
    expect(status).toBe(404);
  });
});

describe("POST /sandboxes/:id/stop", () => {
  it("returns 200 with ok:true", async () => {
    const { status, body } = await post("/sandboxes/test-sandbox/stop", {});
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
  });
});

describe("POST /sandboxes/:id/commands", () => {
  it("returns 200 with command output", async () => {
    const { status, body } = await post("/sandboxes/test-sandbox/commands", {
      command: "echo hello",
    });
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
  });

  it("returns 400 when command field is missing", async () => {
    const { status } = await post("/sandboxes/test-sandbox/commands", {});
    expect(status).toBe(400);
  });
});

describe("GET /config", () => {
  it("returns 200 with config object", async () => {
    const { status, body } = await get("/config");
    expect(status).toBe(200);
    expect(JSON.parse(body).provider).toBe("nim");
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const { status } = await get("/nonexistent");
    expect(status).toBe(404);
  });
});
