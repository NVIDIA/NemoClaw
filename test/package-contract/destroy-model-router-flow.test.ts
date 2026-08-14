// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopModelRouterForDestroyedSandbox } from "../../dist/lib/actions/sandbox/destroy-preflight";
import type { Session } from "../../dist/lib/state/onboard-session";

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
  let stubDir: string;
  let stub: ChildProcess | null = null;

  beforeEach(() => {
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
    vi.restoreAllMocks();
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

      const session = {
        sessionId: "router-session",
        sandboxName: "alpha",
        provider: "nvidia-router",
        endpointUrl: `http://host.openshell.internal:${port}/v1`,
        routerPid: stub.pid,
        routerCredentialHash: "router-credential-hash",
      } as Session;
      const updateSession = vi.fn((mutator: (current: Session) => Session | void) => {
        mutator(session);
        return session;
      });

      await expect(
        stopModelRouterForDestroyedSandbox(
          {
            name: "alpha",
            provider: "nvidia-router",
            endpointUrl: session.endpointUrl,
          },
          {
            listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
            loadSession: () => session,
            updateSession,
          },
        ),
      ).resolves.toBeUndefined();

      await vi.waitFor(() => expect(stubExited).toBe(true), { timeout: 8_000, interval: 100 });
      expect(await probeHealthy(port)).toBe(false);
      expect(updateSession).toHaveBeenCalledOnce();
      expect(session).toEqual(
        expect.objectContaining({ routerPid: null, routerCredentialHash: null }),
      );
    },
  );
});
