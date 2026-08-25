// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  createDockerLlamaCppPrivateBridgeController,
  type DockerLlamaCppPrivateBridgeAuthority,
} from "./docker-llama-cpp-private-bridge";
import {
  createLlamaCppPrivateBridgeServer,
  parseLlamaCppPrivateBridgeArguments,
} from "./docker-llama-cpp-private-bridge-process";

const TRANSACTION = "9".repeat(64);
const API_KEY = "a".repeat(64);
const authority: DockerLlamaCppPrivateBridgeAuthority = {
  transactionId: TRANSACTION,
  apiKeyPath: "/private/api-key",
  targetHost: "172.30.0.2",
  targetPort: 8081,
  listenPort: 8081,
  bindAddresses: ["127.0.0.1", "172.29.0.1"],
};

function fixture() {
  let nextPid = 40_001;
  const processes = new Map<number, readonly string[]>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const openApiKeyDescriptor = vi.fn(() => 17);
  const closeApiKeyDescriptor = vi.fn();
  const spawnProcess = vi.fn((file: string, args: readonly string[]) => {
    const pid = nextPid++;
    processes.set(pid, [file, ...args]);
    return { pid, unref: vi.fn() } as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const controller = createDockerLlamaCppPrivateBridgeController({
    spawnProcess,
    processIsAlive: (pid) => processes.has(pid),
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      processes.delete(pid);
    },
    listProcessIds: () => [...processes.keys()],
    readProcessArgv: (pid) => processes.get(pid) ?? null,
    openApiKeyDescriptor,
    closeApiKeyDescriptor,
    sleep: vi.fn(),
  });
  return {
    closeApiKeyDescriptor,
    controller,
    openApiKeyDescriptor,
    processes,
    signals,
    spawnProcess,
  };
}

function defaultCredentialOpenerFixture() {
  let openedCredentialSize: number | null = null;
  const spawnProcess = vi.fn(
    (_file: string, _args: readonly string[], options: { readonly stdio: readonly unknown[] }) => {
      const descriptor = options.stdio[3] as number;
      expect(descriptor).toEqual(expect.any(Number));
      openedCredentialSize = Number(fs.fstatSync(descriptor).size);
      return { pid: 40_001, unref: vi.fn() } as unknown as ChildProcess;
    },
  ) as unknown as typeof spawn;
  const controller = createDockerLlamaCppPrivateBridgeController({
    spawnProcess,
    processIsAlive: () => false,
    signalProcess: vi.fn(),
    listProcessIds: () => [],
    readProcessArgv: () => null,
    sleep: vi.fn(),
  });
  return {
    controller,
    openedCredentialSize: () => openedCredentialSize,
    spawnProcess,
  };
}

function privateCredentialFile(
  size: number,
  mode = 0o600,
): {
  readonly directory: string;
  readonly file: string;
} {
  // defaultOpenApiKeyDescriptor() rejects a credential path that differs from
  // its own realpath (anti symlink-swap check). os.tmpdir() resolves through
  // a symlinked ancestor on macOS (/var -> /private/var), so realpath the
  // created directory before building fixture paths on top of it.
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-bridge-key-")),
  );
  const file = path.join(directory, "api-key");
  fs.writeFileSync(file, "a".repeat(size), { mode });
  fs.chmodSync(file, mode);
  return { directory, file };
}

describe("Docker llama.cpp private bridge controller", () => {
  it("owns one exact transaction-scoped bridge and stops only that process", () => {
    const {
      closeApiKeyDescriptor,
      controller,
      openApiKeyDescriptor,
      processes,
      signals,
      spawnProcess,
    } = fixture();
    controller.start(authority);
    controller.assertRunning(authority);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringMatching(/docker-llama-cpp-private-bridge-process\.js$/u),
        "--transaction",
        TRANSACTION,
      ]),
      expect.objectContaining({
        detached: true,
        env: {},
        shell: false,
        stdio: ["ignore", "ignore", "ignore", 17],
      }),
    );
    expect(openApiKeyDescriptor).toHaveBeenCalledExactlyOnceWith(authority.apiKeyPath);
    expect(closeApiKeyDescriptor).toHaveBeenCalledExactlyOnceWith(17);
    expect([...processes.values()][0]).toEqual(
      expect.arrayContaining([
        "--transaction",
        TRANSACTION,
        "--auth-mode",
        "api-key-fd3",
        "--target-host",
        "172.30.0.2",
        "--bind-address",
        "127.0.0.1",
        "--bind-address",
        "172.29.0.1",
      ]),
    );
    controller.stopTransaction(TRANSACTION);
    controller.assertStopped(TRANSACTION);
    expect(signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
  });

  it("replaces drifted authority for the same transaction without touching another process", () => {
    const { controller, processes, signals } = fixture();
    controller.start(authority);
    const unrelated = [...processes.values()][0]!.slice();
    unrelated[3] = "8".repeat(64);
    processes.set(50_000, unrelated);
    controller.start({ ...authority, targetHost: "172.30.0.3" });
    expect(signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(processes.has(50_000)).toBe(true);
    controller.assertRunning({ ...authority, targetHost: "172.30.0.3" });
  });

  it("replaces a pre-authentication bridge process for the same transaction (#9591)", () => {
    const { controller, processes, signals } = fixture();
    controller.start(authority);
    const [pid, authenticatedArgv] = [...processes.entries()][0]!;
    const authModeIndex = authenticatedArgv.indexOf("--auth-mode");
    processes.set(pid, [
      ...authenticatedArgv.slice(0, authModeIndex),
      ...authenticatedArgv.slice(authModeIndex + 2),
    ]);

    controller.start(authority);

    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    controller.assertRunning(authority);
  });

  it("fails closed when exact bridge ownership is ambiguous", () => {
    const { controller, processes } = fixture();
    controller.start(authority);
    processes.set(50_000, [...processes.values()][0]!);
    expect(() => controller.assertRunning(authority)).toThrow("2 matching processes");
  });

  it.each([64, 65])(
    "starts with a private credential file containing %i bytes",
    (credentialSize) => {
      const credential = privateCredentialFile(credentialSize);
      const runtime = defaultCredentialOpenerFixture();
      try {
        runtime.controller.start({ ...authority, apiKeyPath: credential.file });

        expect(runtime.spawnProcess).toHaveBeenCalledOnce();
        expect(runtime.openedCredentialSize()).toBe(credentialSize);
      } finally {
        fs.rmSync(credential.directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects an insecure credential mode before spawning", () => {
    const credential = privateCredentialFile(64, 0o644);
    const runtime = defaultCredentialOpenerFixture();
    try {
      expect(() => runtime.controller.start({ ...authority, apiKeyPath: credential.file })).toThrow(
        "API-key file is unavailable or invalid",
      );
      expect(runtime.spawnProcess).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(credential.directory, { recursive: true, force: true });
    }
  });

  it("rejects a credential symlink before spawning", () => {
    const credential = privateCredentialFile(64);
    const link = path.join(credential.directory, "api-key-link");
    fs.symlinkSync(credential.file, link);
    const runtime = defaultCredentialOpenerFixture();
    try {
      expect(() => runtime.controller.start({ ...authority, apiKeyPath: link })).toThrow(
        "API-key file is unavailable or invalid",
      );
      expect(runtime.spawnProcess).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(credential.directory, { recursive: true, force: true });
    }
  });

  it("rejects a credential hard link before spawning", () => {
    const credential = privateCredentialFile(64);
    const link = path.join(credential.directory, "api-key-link");
    fs.linkSync(credential.file, link);
    const runtime = defaultCredentialOpenerFixture();
    try {
      expect(() => runtime.controller.start({ ...authority, apiKeyPath: link })).toThrow(
        "API-key file is unavailable or invalid",
      );
      expect(runtime.spawnProcess).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(credential.directory, { recursive: true, force: true });
    }
  });

  it.each([63, 66])(
    "rejects a credential file containing %i bytes before spawning",
    (credentialSize) => {
      const credential = privateCredentialFile(credentialSize);
      const runtime = defaultCredentialOpenerFixture();
      try {
        expect(() =>
          runtime.controller.start({ ...authority, apiKeyPath: credential.file }),
        ).toThrow("API-key file is unavailable or invalid");
        expect(runtime.spawnProcess).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(credential.directory, { recursive: true, force: true });
      }
    },
  );
});

describe("llama.cpp private bridge argument boundary", () => {
  const argv = [
    "--transaction",
    TRANSACTION,
    "--auth-mode",
    "api-key-fd3",
    "--target-host",
    "172.30.0.2",
    "--target-port",
    "8081",
    "--listen-port",
    "8081",
    "--bind-address",
    "127.0.0.1",
    "--bind-address",
    "172.29.0.1",
  ];

  it("accepts only the exact private loopback and OpenShell bridge topology", () => {
    expect(parseLlamaCppPrivateBridgeArguments(argv)).toEqual({
      transactionId: TRANSACTION,
      targetHost: authority.targetHost,
      targetPort: authority.targetPort,
      listenPort: authority.listenPort,
      bindAddresses: authority.bindAddresses,
    });
    const publicTarget = argv.slice();
    publicTarget[publicTarget.indexOf("--target-host") + 1] = "8.8.8.8";
    expect(() => parseLlamaCppPrivateBridgeArguments(publicTarget)).toThrow("authority is invalid");
    const broadListener = argv.slice();
    broadListener[broadListener.lastIndexOf("--bind-address") + 1] = "0.0.0.0";
    expect(() => parseLlamaCppPrivateBridgeArguments(broadListener)).toThrow(
      "authority is invalid",
    );
    const unauthenticated = argv.slice();
    unauthenticated[unauthenticated.indexOf("--auth-mode") + 1] = "none";
    expect(() => parseLlamaCppPrivateBridgeArguments(unauthenticated)).toThrow(
      "authority is invalid",
    );
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(
  port: number,
  input: {
    readonly authorization?: string | readonly string[];
    readonly body?: string;
    readonly eagerBody?: boolean;
    readonly expectContinue?: boolean;
    readonly keepAlive?: boolean;
    readonly method?: string;
    readonly path?: string;
  } = {},
): Promise<{
  readonly body: string;
  readonly continued: boolean;
  readonly headers: http.IncomingHttpHeaders;
  readonly status: number;
}> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      ...(input.authorization === undefined
        ? {}
        : { Authorization: input.authorization as string | string[] }),
      ...(input.body === undefined
        ? {}
        : {
            "Content-Length": Buffer.byteLength(input.body),
            "Content-Type": "application/json",
          }),
      ...(input.expectContinue ? { Expect: "100-continue" } : {}),
      ...(input.keepAlive ? { Connection: "keep-alive" } : {}),
    };
    let continued = false;
    const outgoing = http.request(
      {
        headers,
        host: "127.0.0.1",
        method: input.method ?? "GET",
        path: input.path ?? "/v1/models",
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            continued,
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
          outgoing.destroy();
        });
      },
    );
    const finishBodyAfterContinue = input.eagerBody
      ? () => undefined
      : () => outgoing.end(input.body);
    outgoing.once("continue", () => {
      continued = true;
      finishBodyAfterContinue();
    });
    outgoing.once("error", reject);
    const start = input.expectContinue
      ? input.eagerBody
        ? () => outgoing.end(input.body)
        : () => outgoing.flushHeaders()
      : () => outgoing.end(input.body);
    start();
  });
}

async function requestBridgeFixture() {
  const receivedAuthorization: Array<string | undefined> = [];
  const upstream = http.createServer((incoming, response) => {
    receivedAuthorization.push(incoming.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}\n");
  });
  const upstreamPort = await listen(upstream);
  const bridge = createLlamaCppPrivateBridgeServer(
    { targetHost: "127.0.0.1", targetPort: upstreamPort },
    API_KEY,
  );
  const bridgePort = await listen(bridge);
  return {
    bridge,
    bridgePort,
    receivedAuthorization,
    upstream,
  };
}

describe("llama.cpp private bridge request authentication", () => {
  it("rejects missing, invalid, and duplicate credentials before forwarding (#9591)", async () => {
    const runtime = await requestBridgeFixture();
    try {
      const missing = await request(runtime.bridgePort);
      const invalid = await request(runtime.bridgePort, {
        authorization: `Bearer ${"b".repeat(64)}`,
      });
      const duplicate = await request(runtime.bridgePort, {
        authorization: [`Bearer ${API_KEY}`, `Bearer ${API_KEY}`],
      });

      expect([missing.status, invalid.status, duplicate.status]).toEqual([401, 401, 401]);
      expect(missing.headers["www-authenticate"]).toBe("Bearer");
      expect(runtime.receivedAuthorization).toEqual([]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it("forwards one canonical valid Bearer credential (#9591)", async () => {
    const runtime = await requestBridgeFixture();
    try {
      const result = await request(runtime.bridgePort, {
        authorization: `bearer ${API_KEY}`,
      });

      expect(result.status).toBe(200);
      expect(runtime.receivedAuthorization).toEqual([`Bearer ${API_KEY}`]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it("keeps only the exact GET health probe credential-free (#9591)", async () => {
    const runtime = await requestBridgeFixture();
    try {
      const health = await request(runtime.bridgePort, { path: "/health" });
      const healthQuery = await request(runtime.bridgePort, { path: "/health?details=1" });
      const healthPost = await request(runtime.bridgePort, { path: "/health", method: "POST" });

      expect([health.status, healthQuery.status, healthPost.status]).toEqual([200, 401, 401]);
      expect(runtime.receivedAuthorization).toEqual([undefined]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it("forwards an upstream rejection without acknowledging Expect: 100-continue", async () => {
    let receivedBodyBytes = 0;
    const rejectionBody = `${JSON.stringify({
      error: {
        code: "request_body_too_large",
        message: "Request body exceeds the declared limit.",
        type: "invalid_request_error",
      },
    })}\n`;
    const upstream = http.createServer();
    const upstreamSocketClosed = new Promise<void>((resolve) => {
      upstream.once("connection", (socket) => socket.once("close", resolve));
    });
    upstream.on("checkContinue", (incoming, response) => {
      incoming.on("data", (chunk: Buffer) => {
        receivedBodyBytes += chunk.length;
      });
      response.writeHead(413, {
        "Content-Length": Buffer.byteLength(rejectionBody),
        "Content-Type": "application/json",
      });
      response.end(rejectionBody);
    });
    const upstreamPort = await listen(upstream);
    const bridge = createLlamaCppPrivateBridgeServer(
      { targetHost: "127.0.0.1", targetPort: upstreamPort },
      API_KEY,
    );
    const bridgePort = await listen(bridge);
    try {
      const result = await request(bridgePort, {
        authorization: `Bearer ${API_KEY}`,
        body: "x".repeat(2 * 1024 * 1024),
        expectContinue: true,
        keepAlive: true,
        method: "POST",
        path: "/v1/chat/completions",
      });

      expect(result).toMatchObject({
        body: rejectionBody,
        continued: false,
        status: 413,
      });
      expect(receivedBodyBytes).toBe(0);
      await upstreamSocketClosed;
    } finally {
      await close(bridge);
      await close(upstream);
    }
  });

  it("relays an upstream 100 Continue response before forwarding the request body", async () => {
    let receivedBody = "";
    const upstream = http.createServer();
    upstream.on("checkContinue", (incoming, response) => {
      response.writeContinue();
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      incoming.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}\n");
      });
    });
    const upstreamPort = await listen(upstream);
    const bridge = createLlamaCppPrivateBridgeServer(
      { targetHost: "127.0.0.1", targetPort: upstreamPort },
      API_KEY,
    );
    const bridgePort = await listen(bridge);
    const body = '{"model":"default"}';
    try {
      const result = await request(bridgePort, {
        authorization: `Bearer ${API_KEY}`,
        body,
        expectContinue: true,
        method: "POST",
        path: "/v1/chat/completions",
      });

      expect(result).toMatchObject({ continued: true, status: 200 });
      expect(receivedBody).toBe(body);
    } finally {
      await close(bridge);
      await close(upstream);
    }
  });

  it("holds an eagerly sent request body until the upstream server accepts it", async () => {
    let bodyBytesBeforeContinue = -1;
    let receivedBody = "";
    const upstream = http.createServer();
    upstream.on("checkContinue", (incoming, response) => {
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      setImmediate(() => {
        bodyBytesBeforeContinue = Buffer.byteLength(receivedBody);
        response.writeContinue();
      });
      incoming.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}\n");
      });
    });
    const upstreamPort = await listen(upstream);
    const bridge = createLlamaCppPrivateBridgeServer(
      { targetHost: "127.0.0.1", targetPort: upstreamPort },
      API_KEY,
    );
    const bridgePort = await listen(bridge);
    const body = "x".repeat(2 * 1024 * 1024);
    try {
      const result = await request(bridgePort, {
        authorization: `Bearer ${API_KEY}`,
        body,
        eagerBody: true,
        expectContinue: true,
        method: "POST",
        path: "/v1/chat/completions",
      });

      expect(result).toMatchObject({ continued: true, status: 200 });
      expect(bodyBytesBeforeContinue).toBe(0);
      expect(receivedBody).toBe(body);
    } finally {
      await close(bridge);
      await close(upstream);
    }
  });

  it("bounds the wait for an upstream 100 Continue response", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout"] });
    const upstream = http.createServer();
    let acceptRequest: (() => void) | undefined;
    const requestAccepted = new Promise<void>((resolve) => {
      acceptRequest = resolve;
    });
    const upstreamSocketClosed = new Promise<void>((resolve) => {
      upstream.once("connection", (socket) => socket.once("close", resolve));
    });
    upstream.on("checkContinue", () => acceptRequest?.());
    const upstreamPort = await listen(upstream);
    const bridge = createLlamaCppPrivateBridgeServer(
      { targetHost: "127.0.0.1", targetPort: upstreamPort },
      API_KEY,
    );
    const bridgePort = await listen(bridge);
    try {
      let uploadedChunks = 0;
      let outgoing: http.ClientRequest;
      let uploadTimer: ReturnType<typeof setInterval> | undefined;
      let responseResult: { readonly connection: string | undefined; readonly status: number };
      let resolveResponse: (() => void) | undefined;
      const responseReceived = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const clientClosed = new Promise<void>((resolve) => {
        outgoing = http.request(
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Length": 16 * 1024 * 1024,
              Expect: "100-continue",
            },
            host: "127.0.0.1",
            method: "POST",
            path: "/v1/chat/completions",
            port: bridgePort,
          },
          (response) => {
            responseResult = {
              connection: response.headers.connection,
              status: response.statusCode ?? 0,
            };
            response.resume();
            response.once("end", () => resolveResponse?.());
          },
        );
        outgoing.once("close", resolve);
        outgoing.on("error", () => undefined);
        outgoing.flushHeaders();
        uploadTimer = setInterval(() => {
          uploadedChunks += 1;
          outgoing.write("x".repeat(16 * 1024));
        }, 1_000);
      });
      await requestAccepted;

      await vi.advanceTimersByTimeAsync(30_000);

      await responseReceived;
      await clientClosed;
      await upstreamSocketClosed;
      clearInterval(uploadTimer!);
      expect(responseResult!).toEqual({ connection: "close", status: 502 });
      expect(outgoing!.destroyed).toBe(true);
      expect(uploadedChunks).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      await close(bridge);
      await close(upstream);
    }
  });

  it("rejects unauthenticated Expect: 100-continue without requesting the body", async () => {
    const runtime = await requestBridgeFixture();
    try {
      const result = await request(runtime.bridgePort, {
        body: "x".repeat(2 * 1024 * 1024),
        expectContinue: true,
        method: "POST",
        path: "/v1/chat/completions",
      });

      expect(result).toMatchObject({ continued: false, status: 401 });
      expect(runtime.receivedAuthorization).toEqual([]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it("returns HTTP 502 when an authenticated request cannot reach the server (#9591)", async () => {
    const runtime = await requestBridgeFixture();
    await close(runtime.upstream);
    try {
      const result = await request(runtime.bridgePort, {
        authorization: `Bearer ${API_KEY}`,
      });

      expect(result.status).toBe(502);
    } finally {
      await close(runtime.bridge);
    }
  });
});
