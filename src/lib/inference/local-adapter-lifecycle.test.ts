// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLocalAdapterStateDir,
  isLocalAdapterProcess,
  killLocalAdapterPid,
  loadLocalAdapterPid,
  localAdapterTokenHash,
  persistLocalAdapterPid,
  probeLocalAdapterHealth,
  readLocalAdapterJsonFile,
  readLocalAdapterTextFile,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  writeLocalAdapterSecretFile,
} from "../../../dist/lib/inference/local-adapter-lifecycle";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-adapter-"));
  tempDirs.push(dir);
  return dir;
}

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      resolve(address.port);
    });
  });
}

describe("local adapter lifecycle", () => {
  it("persists local adapter secrets, JSON state, and PIDs as private files", () => {
    const dir = tempDir();
    const tokenPath = path.join(dir, "adapter-token");
    const statePath = path.join(dir, "adapter-state.json");
    const pidPath = path.join(dir, "adapter.pid");

    writeLocalAdapterSecretFile(tokenPath, "secret-token");
    writeLocalAdapterJsonFile(statePath, { endpointUrl: "https://runtime.example", pid: 123 });
    persistLocalAdapterPid(pidPath, 456);

    expect(readLocalAdapterTextFile(tokenPath)).toBe("secret-token");
    expect(readLocalAdapterJsonFile(statePath)).toEqual({
      endpointUrl: "https://runtime.example",
      pid: 123,
    });
    expect(loadLocalAdapterPid(pidPath)).toBe(456);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pidPath).mode & 0o777).toBe(0o600);
  });

  it("guards PID cleanup by process command line", () => {
    const pidPath = path.join(tempDir(), "adapter.pid");
    persistLocalAdapterPid(pidPath, 789);
    const killed: string[][] = [];

    expect(
      isLocalAdapterProcess(789, "ollama-auth-proxy.js", () => "node scripts/ollama-auth-proxy.js"),
    ).toBe(true);

    killLocalAdapterPid({
      pidPath,
      processNeedle: "ollama-auth-proxy.js",
      run: (args) => {
        killed.push(args);
      },
      runCapture: () => "node scripts/ollama-auth-proxy.js",
    });

    expect(killed).toEqual([["kill", "789"]]);
    expect(loadLocalAdapterPid(pidPath)).toBeNull();
  });

  it("probes adapter health with the expected token hash", async () => {
    const tokenHash = localAdapterTokenHash("secret-token");
    const server = http.createServer((req, res) => {
      if (req.url !== "/health") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tokenHash }));
    });
    const port = await listen(server);

    await expect(
      probeLocalAdapterHealth({
        host: "127.0.0.1",
        port,
        expectedTokenHash: tokenHash,
      }),
    ).resolves.toBe(true);
    await expect(
      probeLocalAdapterHealth({
        host: "127.0.0.1",
        port,
        expectedTokenHash: localAdapterTokenHash("other-token"),
      }),
    ).resolves.toBe(false);
  });
});

describe("ensureLocalAdapterStateDir", () => {
  it("creates directory with owner-only permissions (0o700)", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const stateDir = path.join(dir, "nested", "state");
    ensureLocalAdapterStateDir(stateDir);
    const stat = fs.statSync(stateDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("tightens permissions on an existing world-readable directory", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const stateDir = path.join(dir, "lax");
    fs.mkdirSync(stateDir, { mode: 0o755 });
    ensureLocalAdapterStateDir(stateDir);
    const stat = fs.statSync(stateDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("waitForLocalAdapterHealth", () => {
  it("retries async health probes until the adapter responds", async () => {
    let calls = 0;

    await expect(
      waitForLocalAdapterHealth(
        async () => {
          calls += 1;
          return calls >= 3;
        },
        { attempts: 5, intervalMs: 1 },
      ),
    ).resolves.toBe(true);

    expect(calls).toBe(3);
  });

  it("returns false after the configured attempt budget is exhausted", async () => {
    let calls = 0;

    await expect(
      waitForLocalAdapterHealth(
        async () => {
          calls += 1;
          return false;
        },
        { attempts: 2, intervalMs: 1 },
      ),
    ).resolves.toBe(false);

    expect(calls).toBe(2);
  });
});
