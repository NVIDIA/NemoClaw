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
  runLlamaCppPrivateBridge,
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

function fixture(startupStatus: "READY" | "FAILED" | "" = "READY") {
  let nextPid = 40_001;
  const processes = new Map<number, readonly string[]>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const sleep = vi.fn();
  const openApiKeyDescriptor = vi.fn(() => 17);
  const closeApiKeyDescriptor = vi.fn();
  const spawnProcess = vi.fn(
    (file: string, args: readonly string[], options: { readonly stdio: readonly unknown[] }) => {
      const pid = nextPid++;
      processes.set(pid, [file, ...args]);
      fs.writeSync(options.stdio[4] as number, startupStatus);
      return { pid, unref: vi.fn() } as unknown as ChildProcess;
    },
  ) as unknown as typeof spawn;
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
    sleep,
  });
  return {
    closeApiKeyDescriptor,
    controller,
    openApiKeyDescriptor,
    processes,
    signals,
    sleep,
    spawnProcess,
  };
}

function forcedStopFixture(remainingPolls: number) {
  let alive = true;
  let forced = false;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const sleep = vi.fn(() => {
    remainingPolls -= Number(forced);
    alive = alive && (!forced || remainingPolls > 0);
  });
  const controller = createDockerLlamaCppPrivateBridgeController({
    processIsAlive: () => alive,
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      forced ||= signal === "SIGKILL";
    },
    listProcessIds: () => [40_001],
    readProcessArgv: () => [
      process.execPath,
      path.join(__dirname, "docker-llama-cpp-private-bridge-process.js"),
      "--transaction",
      TRANSACTION,
    ],
    sleep,
  });
  return { alive: () => alive, controller, signals, sleep };
}

function defaultCredentialOpenerFixture() {
  let openedCredentialSize: number | null = null;
  const spawnProcess = vi.fn(
    (_file: string, _args: readonly string[], options: { readonly stdio: readonly unknown[] }) => {
      const descriptor = options.stdio[3] as number;
      expect(descriptor).toEqual(expect.any(Number));
      openedCredentialSize = Number(fs.fstatSync(descriptor).size);
      fs.writeSync(options.stdio[4] as number, "READY");
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
  it.each([
    [0, undefined],
    [1, expect.objectContaining({ message: expect.stringContaining("could not prove") })],
  ] as const)(
    "requires successful remote discovery before declaring an idle bridge stopped [Docker exit %s]",
    (status, expectedFailure) => {
      const openApiKeyDescriptor = vi.fn(() => {
        throw new Error("credential is already removed");
      });
      const capture = vi.fn(() => ({
        status,
        stdout: "",
        stderr: status ? "daemon unavailable" : "",
      }));
      const controller = createDockerLlamaCppPrivateBridgeController({
        listProcessIds: () => [],
        openApiKeyDescriptor,
        remoteRequests: {
          engine: {
            engineId: "docker",
            operation: "host-local-inference",
            displayName: "Docker",
            authorityId: `docker:${"a".repeat(64)}`,
            capture,
            captureHost: vi.fn(),
          },
          apiKeyPath: "/already-removed/api-key",
          targetPort: 8081,
        },
      });
      let failure: unknown;
      try {
        controller.stopTransaction(TRANSACTION);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(expectedFailure);
      expect(capture).toHaveBeenCalledOnce();
      expect(openApiKeyDescriptor).not.toHaveBeenCalled();
    },
  );

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
        stdio: ["ignore", "ignore", "ignore", 17, expect.any(Number)],
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

  it("waits for forced process exit before reporting the transaction stopped", () => {
    const { alive, controller, signals, sleep } = forcedStopFixture(2);
    let elapsed = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (elapsed += 1_000));
    try {
      controller.stopTransaction(TRANSACTION);
      controller.assertStopped(TRANSACTION);
      expect(signals).toEqual([
        { pid: 40_001, signal: "SIGTERM" },
        { pid: 40_001, signal: "SIGKILL" },
      ]);
      expect(sleep).toHaveBeenCalled();
      expect(alive()).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("reports a process that remains alive after forced stop", () => {
    const { alive, controller, signals } = forcedStopFixture(Number.POSITIVE_INFINITY);
    let elapsed = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (elapsed += 1_000));
    try {
      expect(() => controller.stopTransaction(TRANSACTION)).toThrow(
        `process 40001 for transaction ${TRANSACTION} remained active after SIGKILL`,
      );
      expect(signals).toEqual([
        { pid: 40_001, signal: "SIGTERM" },
        { pid: 40_001, signal: "SIGKILL" },
      ]);
      expect(alive()).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("fails promptly on a bind failure and stops only its transaction process", () => {
    const { controller, processes, signals } = fixture("FAILED");
    expect(() => controller.start(authority)).toThrow("failed to bind its listeners");
    expect(signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(processes.size).toBe(0);
  });

  it("bounds a bridge startup that never reports ready and cleans up its transaction", () => {
    const { controller, processes, signals } = fixture("");
    let elapsed = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (elapsed += 50));
    try {
      expect(() => controller.start(authority)).toThrow("failed to bind its listeners");
      expect(elapsed).toBeLessThanOrEqual(10_200);
      expect(signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
      expect(processes.size).toBe(0);
    } finally {
      now.mockRestore();
    }
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

it("closes both bridge listeners when one address cannot bind (#12285)", async () => {
  const servers = [http.createServer(), http.createServer()];
  const port = await listen(servers[0]!);
  await close(servers[0]!);
  const signals = ["SIGINT", "SIGTERM"] as const;
  const originalListeners = signals.map((signal) => process.listeners(signal));
  const registerSignal = vi.spyOn(process, "once");
  vi.spyOn(http, "createServer").mockReturnValueOnce(servers[0]!).mockReturnValueOnce(servers[1]!);

  try {
    await expect(
      runLlamaCppPrivateBridge(
        { ...authority, listenPort: port, bindAddresses: ["127.0.0.1", "127.0.0.1"] },
        API_KEY,
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(servers.map((server) => server.listening)).toEqual([false, false]);
    expect(signals.map((signal) => process.listeners(signal))).toEqual(originalListeners);
  } finally {
    servers[0]!.closeAllConnections();
    servers[0]!.close();
    servers[1]!.closeAllConnections();
    servers[1]!.close();
    process.removeListener(
      "SIGINT",
      registerSignal.mock.calls.find(([event]) => event === "SIGINT")![1],
    );
    process.removeListener(
      "SIGTERM",
      registerSignal.mock.calls.find(([event]) => event === "SIGTERM")![1],
    );
  }
});

async function request(
  port: number,
  input: {
    readonly authorization?: string | readonly string[];
    readonly body?: string;
    readonly chunked?: boolean;
    readonly headers?: http.OutgoingHttpHeaders;
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
            ...(input.chunked ? {} : { "Content-Length": Buffer.byteLength(input.body) }),
            "Content-Type": "application/json",
          }),
      ...(input.expectContinue ? { Expect: "100-continue" } : {}),
      ...(input.keepAlive ? { Connection: "keep-alive" } : {}),
      ...input.headers,
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
  const receivedBodies: string[] = [];
  const upstream = http.createServer((incoming, response) => {
    receivedAuthorization.push(incoming.headers.authorization);
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.once("end", () => {
      receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
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
  return {
    bridge,
    bridgePort,
    receivedAuthorization,
    receivedBodies,
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

  it.each([
    { name: "declared", chunked: false, expectContinue: false, eagerBody: false },
    { name: "chunked", chunked: true, expectContinue: false, eagerBody: false },
    { name: "Expect", chunked: false, expectContinue: true, eagerBody: false },
    { name: "eager Expect", chunked: false, expectContinue: true, eagerBody: true },
  ])("rejects an oversized $name body before forwarding", async (framing) => {
    const runtime = await requestBridgeFixture();
    try {
      const result = await request(runtime.bridgePort, {
        ...framing,
        authorization: `Bearer ${API_KEY}`,
        body: "x".repeat(framing.chunked ? 1024 * 1024 + 1 : 2 * 1024 * 1024),
        method: "POST",
        path: "/v1/chat/completions",
      });
      expect(result).toMatchObject({ continued: false, status: 413 });
      expect(JSON.parse(result.body).error.code).toBe("request_body_too_large");
      expect(runtime.receivedAuthorization).toEqual([]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it("accepts a bounded Expect body and supplies the declared default token ceiling", async () => {
    const runtime = await requestBridgeFixture();
    try {
      const result = await request(runtime.bridgePort, {
        authorization: `Bearer ${API_KEY}`,
        body: '{"model":"default","metadata":{"max_tokens":-1},"messages":[]}',
        expectContinue: true,
        method: "POST",
        path: "/v1/chat/completions",
      });
      expect(result).toMatchObject({ continued: true, status: 200 });
      expect(JSON.parse(runtime.receivedBodies[0]!)).toEqual({
        model: "default",
        metadata: { max_tokens: -1 },
        messages: [],
        max_tokens: 4096,
      });
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it.each([
    ["[]", "invalid_json"],
    ["{}{}", "invalid_json"],
    ["\uFEFF{}", "invalid_json"],
    [`{"value":${"[".repeat(10_000)}0${"]".repeat(10_000)}}`, "invalid_json"],
    ['{"messages":[],"messages":[]}', "duplicate_json_field"],
    [String.raw`{"max_tokens":1,"max\u005ftokens":2}`, "duplicate_json_field"],
    ['{"max_tokens":0}', "output_token_limit_invalid"],
    ['{"max_tokens":1.0}', "output_token_limit_invalid"],
    ['{"max_tokens":1e3}', "output_token_limit_invalid"],
    ['{"max_tokens":"8"}', "output_token_limit_invalid"],
    ['{"max_tokens":9223372036854775808}', "output_token_limit_invalid"],
    ['{"max_tokens":4097}', "output_token_limit_exceeded"],
    ['{"max_completion_tokens":4097}', "output_token_limit_exceeded"],
    ['{"n_predict":-1}', "output_token_limit_invalid"],
    ['{"max_tokens":8,"n_predict":4097}', "output_token_limit_exceeded"],
  ])("rejects unsafe chat body before forwarding [case %#]", async (body, code) => {
    const runtime = await requestBridgeFixture();
    try {
      const result = await request(runtime.bridgePort, {
        authorization: `Bearer ${API_KEY}`,
        body,
        method: "POST",
        path: "/v1/chat/completions",
      });
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).error.code).toBe(code);
      expect(runtime.receivedAuthorization).toEqual([]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it.each(["/slots", "/completion", "/metrics?model=x", "/health?details=1"])(
    "keeps the native route %s unavailable",
    async (route) => {
      const runtime = await requestBridgeFixture();
      try {
        const result = await request(runtime.bridgePort, {
          authorization: `Bearer ${API_KEY}`,
          path: route,
        });
        expect(result.status).toBe(404);
        expect(runtime.receivedAuthorization).toEqual([]);
      } finally {
        await close(runtime.bridge);
        await close(runtime.upstream);
      }
    },
  );

  it.each([{ "Content-Encoding": "gzip" }, { "Content-Type": "text/plain" }])(
    "rejects unsupported request encoding or media type %j",
    async (headers) => {
      const runtime = await requestBridgeFixture();
      try {
        const result = await request(runtime.bridgePort, {
          authorization: `Bearer ${API_KEY}`,
          headers,
          body: "{}",
          method: "POST",
          path: "/v1/chat/completions",
        });
        expect(result.status).toBe(415);
        expect(runtime.receivedAuthorization).toEqual([]);
      } finally {
        await close(runtime.bridge);
        await close(runtime.upstream);
      }
    },
  );

  it("keeps the existing stricter header limit", async () => {
    const runtime = await requestBridgeFixture();
    try {
      const result = await request(runtime.bridgePort, {
        authorization: `Bearer ${API_KEY}`,
        headers: { "X-Large": "x".repeat(Math.min(http.maxHeaderSize, 32 * 1024)) },
      });
      expect(result.status).toBe(431);
      expect(runtime.receivedAuthorization).toEqual([]);
    } finally {
      await close(runtime.bridge);
      await close(runtime.upstream);
    }
  });

  it("bounds the complete upstream request and closes its connection at the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout"] });
    const upstream = http.createServer();
    let acceptRequest: (() => void) | undefined;
    const requestAccepted = new Promise<void>((resolve) => {
      acceptRequest = resolve;
    });
    const upstreamSocketClosed = new Promise<void>((resolve) => {
      upstream.once("connection", (socket) => socket.once("close", resolve));
    });
    upstream.on("request", () => acceptRequest?.());
    const upstreamPort = await listen(upstream);
    const bridge = createLlamaCppPrivateBridgeServer(
      { targetHost: "127.0.0.1", targetPort: upstreamPort },
      API_KEY,
    );
    const bridgePort = await listen(bridge);
    try {
      const responseReceived = request(bridgePort, { authorization: `Bearer ${API_KEY}` });
      await requestAccepted;
      await vi.advanceTimersByTimeAsync(900_000);
      const result = await responseReceived;
      await upstreamSocketClosed;
      expect(result.status).toBe(504);
      expect(result.headers.connection).toBe("close");
      expect(JSON.parse(result.body).error.code).toBe("request_timeout");
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
