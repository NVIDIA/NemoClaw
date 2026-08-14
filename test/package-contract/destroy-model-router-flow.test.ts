// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../helpers/destroy-flow-test-harness";

// A real detached HTTP server whose command line matches the model-router
// proxy shape (venv-style interposition: args[0]=node, args[1]=.../model-router).
const STUB_SOURCE = [
  'const http = require("node:http");',
  'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
  "http",
  '  .createServer((_req, res) => { res.statusCode = 200; res.end("{}"); })',
  '  .listen(port, "127.0.0.1");',
].join("\n");

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function probeHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe("destroySandbox model-router teardown (#9098)", () => {
  let exitSpy: MockInstance;
  let originalGatewayEnv: string | undefined;
  let stubDir: string;
  let stub: ChildProcess | null = null;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-router-stub-"));
  });

  afterEach(() => {
    try {
      stub?.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    stub = null;
    fs.rmSync(stubDir, { recursive: true, force: true });
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it(
    "destroying the last routed sandbox stops the tracked router proxy and frees its port (#9098)",
    { timeout: 30_000 },
    async () => {
      const port = await reserveLoopbackPort();
      const stubPath = path.join(stubDir, "model-router");
      fs.writeFileSync(stubPath, STUB_SOURCE);
      stub = spawn(process.execPath, [stubPath, "proxy", "--port", String(port)], {
        stdio: "ignore",
      });
      let stubExited = false;
      stub.on("exit", () => {
        stubExited = true;
      });
      await vi.waitFor(async () => expect(await probeHealthy(port)).toBe(true), {
        timeout: 10_000,
        interval: 100,
      });

      const harness = createDestroyHarness({
        provider: "nvidia-router",
        endpointUrl: `http://host.openshell.internal:${port}/v1`,
        sessionRouterPid: stub.pid,
      });
      await expect(
        harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
      ).resolves.toBeUndefined();

      // The teardown must run under the gateway route lock so routed
      // onboarding cannot register a peer between the scan and the stop.
      expect(harness.withGatewayRouteMutationLockSpy).toHaveBeenCalledWith(
        "nemoclaw-19080",
        expect.any(Function),
      );

      await vi.waitFor(() => expect(stubExited).toBe(true), { timeout: 8_000, interval: 100 });
      expect(await probeHealthy(port)).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();

      const sessionsWithRouterPidCleared = harness.updateSessionSpy.mock.results
        .map((result) => result.value as { routerPid?: number | null })
        .filter((session) => "routerPid" in session);
      expect(sessionsWithRouterPidCleared).toEqual([
        expect.objectContaining({ routerPid: null, routerCredentialHash: null }),
      ]);
    },
  );
});
