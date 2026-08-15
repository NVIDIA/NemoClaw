// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLocalAdapterStateDir,
  isLocalAdapterProcess,
  killLocalAdapterPid,
  LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES,
  loadLocalAdapterPid,
  localAdapterTokenHash,
  persistLocalAdapterPid,
  probeLocalAdapterHealth,
  readLocalAdapterJsonFile,
  readLocalAdapterTextFile,
  spawnDetachedNodeAdapter,
  waitForLocalAdapterHealth,
  writeLocalAdapterJsonFile,
  writeLocalAdapterSecretFile,
} from "./local-adapter-lifecycle";
import { isOllamaAuthProxyCommandLine } from "./ollama/process";

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
  vi.unstubAllEnvs();
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

async function waitForFileText(filePath: string, expected: string, attempts = 50): Promise<string> {
  const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  return actual === expected
    ? actual
    : attempts > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() =>
          waitForFileText(filePath, expected, attempts - 1),
        )
      : Promise.reject(new Error(`adapter did not write expected output: ${actual}`));
}

describe("local adapter lifecycle", () => {
  it("executes detached TypeScript adapters", async () => {
    const dir = tempDir();
    const scriptPath = path.join(dir, "adapter.mts");
    const outputPath = path.join(dir, "adapter-output.txt");
    fs.writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nconst answer: number = 42;\nwriteFileSync(process.env.NEMOCLAW_TEST_ADAPTER_OUTPUT ?? "", String(answer));\n`,
    );

    spawnDetachedNodeAdapter({
      scriptPath,
      env: { NEMOCLAW_TEST_ADAPTER_OUTPUT: outputPath },
      buildEnv: (extraEnv) => ({ ...process.env, ...extraEnv }),
    });

    await waitForFileText(outputPath, "42");
  });

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

  it.each([
    "ollama-auth-proxy.js",
    "ollama-auth-proxy.mts",
  ])("guards PID cleanup for the supported %s script", (scriptName) => {
    const pidPath = path.join(tempDir(), "adapter.pid");
    persistLocalAdapterPid(pidPath, 789);
    const killed: string[][] = [];
    const commandLine = `node /opt/nemoclaw/scripts/${scriptName}`;

    expect(isLocalAdapterProcess(789, isOllamaAuthProxyCommandLine, () => commandLine)).toBe(true);

    killLocalAdapterPid({
      pidPath,
      processMatcher: isOllamaAuthProxyCommandLine,
      run: (args) => {
        killed.push(args);
      },
      runCapture: () => commandLine,
    });

    expect(killed).toEqual([["kill", "789"]]);
    expect(loadLocalAdapterPid(pidPath)).toBeNull();
  });

  it.each([
    "ollama-auth-proxy-helper.mjs",
    "ollama-auth-proxy.mts.backup",
  ])("does not clean up the near-named %s process", (scriptName) => {
    const pidPath = path.join(tempDir(), "adapter.pid");
    persistLocalAdapterPid(pidPath, 789);
    const killed: string[][] = [];

    killLocalAdapterPid({
      pidPath,
      processMatcher: isOllamaAuthProxyCommandLine,
      run: (args) => {
        killed.push(args);
      },
      runCapture: () => `node /opt/nemoclaw/scripts/${scriptName}`,
    });

    expect(killed).toEqual([]);
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

  it("fails closed when a chunked health response exceeds the memory budget", async () => {
    const expectedTokenHash = localAdapterTokenHash("secret-token");
    const payload = Buffer.from(
      JSON.stringify({
        tokenHash: expectedTokenHash,
        padding: " ".repeat(LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES),
      }),
    );
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(payload.subarray(0, LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES));
      res.end(payload.subarray(LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES));
    });
    const port = await listen(server);

    await expect(
      probeLocalAdapterHealth({
        host: "127.0.0.1",
        port,
        expectedTokenHash,
      }),
    ).resolves.toBe(false);
  });

  it("accepts a valid health response at the memory budget", async () => {
    const expectedTokenHash = localAdapterTokenHash("secret-token");
    const emptyPayload = JSON.stringify({ tokenHash: expectedTokenHash, padding: "" });
    const payload = Buffer.from(
      JSON.stringify({
        tokenHash: expectedTokenHash,
        padding: " ".repeat(
          LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES - Buffer.byteLength(emptyPayload),
        ),
      }),
    );
    expect(payload).toHaveLength(LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Length": String(payload.length),
        "Content-Type": "application/json",
      });
      res.end(payload);
    });
    const port = await listen(server);

    await expect(
      probeLocalAdapterHealth({
        host: "127.0.0.1",
        port,
        expectedTokenHash,
      }),
    ).resolves.toBe(true);
  });

  it("fails closed when a health response closes before completion", async () => {
    const expectedTokenHash = localAdapterTokenHash("secret-token");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Length": "128",
        "Content-Type": "application/json",
      });
      res.write('{"tokenHash":"');
      res.socket?.destroy();
    });
    const port = await listen(server);

    await expect(
      probeLocalAdapterHealth({
        host: "127.0.0.1",
        port,
        expectedTokenHash,
      }),
    ).resolves.toBe(false);
  });

  it("destroys a declared health response above the memory budget before buffering", async () => {
    const expectedTokenHash = localAdapterTokenHash("secret-token");
    const declaredBytes = LOCAL_ADAPTER_HEALTH_MAX_RESPONSE_BYTES + 1;
    const destroySpy = vi.spyOn(http.IncomingMessage.prototype, "destroy");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Length": String(declaredBytes),
        "Content-Type": "application/json",
      });
      res.end();
    });
    const port = await listen(server);

    await expect(
      probeLocalAdapterHealth({
        host: "127.0.0.1",
        port,
        expectedTokenHash,
      }),
    ).resolves.toBe(false);
    expect(
      destroySpy.mock.calls.some((args, index) => {
        const response = destroySpy.mock.contexts[index] as http.IncomingMessage;
        return (
          response.statusCode === 200 &&
          response.headers["content-length"] === String(declaredBytes) &&
          args.length === 0
        );
      }),
    ).toBe(true);
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

  describe.skipIf(process.platform === "win32")("symlink-safe adapter state", () => {
    it.each([
      "gateways",
      "selected port",
    ])("rejects a symlink at the %s ancestor before writing adapter secrets (#3053)", (symlinkAt) => {
      const home = tempDir();
      vi.stubEnv("HOME", home);
      const controlled = path.join(home, "controlled");
      const sharedRoot = path.join(home, ".nemoclaw");
      const gatewaysDir = path.join(sharedRoot, "gateways");
      const selectedDir = path.join(gatewaysDir, "9123");
      fs.mkdirSync(controlled, { recursive: true });
      fs.mkdirSync(symlinkAt === "gateways" ? sharedRoot : gatewaysDir, { recursive: true });
      fs.symlinkSync(controlled, symlinkAt === "gateways" ? gatewaysDir : selectedDir);

      expect(() =>
        writeLocalAdapterSecretFile(path.join(selectedDir, "adapter-token"), "secret"),
      ).toThrow(/symbolic link/);
      expect(fs.existsSync(path.join(controlled, "adapter-token"))).toBe(false);
    });

    it("refuses to overwrite an adapter secret through a final-component symlink", () => {
      const home = tempDir();
      vi.stubEnv("HOME", home);
      const selectedDir = path.join(home, ".nemoclaw", "gateways", "9123");
      const controlled = path.join(home, "controlled-token");
      fs.mkdirSync(selectedDir, { recursive: true });
      fs.writeFileSync(controlled, "unchanged\n", { mode: 0o600 });
      fs.symlinkSync(controlled, path.join(selectedDir, "adapter-token"));

      expect(() =>
        writeLocalAdapterSecretFile(path.join(selectedDir, "adapter-token"), "secret"),
      ).toThrow();
      expect(fs.readFileSync(controlled, "utf8")).toBe("unchanged\n");
    });
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
