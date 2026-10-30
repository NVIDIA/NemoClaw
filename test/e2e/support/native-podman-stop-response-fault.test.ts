// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
} from "../../../src/lib/adapters/podman/socket-authority.ts";

import {
  captureNativeGatewayLogCursor,
  captureNativeGatewayJournalCursor,
  createNativePodmanStopResponseFault,
  parseNativePodmanStoppedInternalTrace,
  readNativeGatewayLogWindow,
  readNativeGatewayJournalWindow,
  NATIVE_PODMAN_STOP_FAULT_CANARY,
} from "../fixtures/native-podman-stop-response-fault.ts";

const CONTAINER_ID = "a".repeat(64);
const OTHER_CONTAINER_ID = "b".repeat(64);
const STOP_PATH = `/v5.0.0/libpod/containers/${CONTAINER_ID}/stop?timeout=10`;
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  expect(errors).toEqual([]);
});

async function createBackend(
  respond: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.writeHead(204).end();
  },
  parentDirectory = os.homedir(),
) {
  const directory = await fs.mkdtemp(path.join(parentDirectory, "nc-stop-backend-"));
  const socketPath = path.join(directory, "podman.sock");
  const server = http.createServer(respond);
  const connections = new Set<net.Socket>();
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanup.push(async () => {
    const stopped = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const connection of connections) connection.destroy();
    await stopped;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { socketPath, server };
}

async function createFault(
  backendSocketPath: string,
  verifyStopped = vi.fn(async (_containerId: string) => true),
) {
  const fault = await createNativePodmanStopResponseFault({
    runtimeKind: "podman",
    backendSocketPath,
    verifyStopped,
  });
  cleanup.push(() => fault.close());
  return { fault, verifyStopped, socketPath: fault.socketPath as string };
}

function request(
  socketPath: string,
  url: string,
  method = "POST",
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        socketPath,
        path: url,
        method,
        headers: { "content-length": Buffer.byteLength(body), authorization: "Bearer unit-secret" },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe.skipIf(process.platform === "win32")("native Podman stop response fault", () => {
  it("keeps Docker disabled without inspecting a backend socket", async () => {
    const verifyStopped = vi.fn(async () => true);
    const fault = await createNativePodmanStopResponseFault({
      runtimeKind: "docker",
      backendSocketPath: "/does-not-exist/unit.sock",
      verifyStopped,
    });
    expect(fault.enabled).toBe(false);
    expect(fault.socketPath).toBeNull();
    expect(() => fault.arm({ containerId: CONTAINER_ID, correlationId: "unit" })).toThrow(
      /not available for Docker/u,
    );
    await fault.close();
    expect(fault.receipt()).toEqual({
      enabled: false,
      armed: false,
      closed: true,
      faultCount: 0,
      observations: [],
    });
    expect(verifyStopped).not.toHaveBeenCalled();
  });

  it("passes native Podman socket checks when the temporary directory is writable", async () => {
    const backend = await createBackend();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "nc-unsafe-temporary-"));
    await fs.chmod(temporaryDirectory, 0o777);
    cleanup.push(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
    vi.stubEnv("TMPDIR", temporaryDirectory);

    const { socketPath } = await createFault(backend.socketPath);
    expect(() => {
      const authority = capturePodmanSocketAuthority(socketPath);
      assertPodmanSocketAuthority(authority);
    }).not.toThrow();
    expect(await request(socketPath, STOP_PATH)).toEqual({ status: 204, body: "" });
    expect((await fs.stat(temporaryDirectory)).mode & 0o777).toBe(0o777);
  });

  it("passes unrelated request bodies and responses without recording their secrets", async () => {
    const backend = await createBackend((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: incoming.method,
            url: incoming.url,
            authorization: incoming.headers.authorization,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    const { fault, socketPath, verifyStopped } = await createFault(backend.socketPath);
    const result = await request(
      socketPath,
      "/v5.0.0/libpod/info?unit=secret",
      "POST",
      "body-secret",
    );
    expect(result.status).toBe(201);
    expect(JSON.parse(result.body)).toEqual({
      method: "POST",
      url: "/v5.0.0/libpod/info?unit=secret",
      authorization: "Bearer unit-secret",
      body: "body-secret",
    });
    expect(fault.receipt().observations).toEqual([]);
    expect(JSON.stringify(fault.receipt())).not.toContain("secret");
    expect(verifyStopped).not.toHaveBeenCalled();
  });

  it.each([STOP_PATH, `http://localhost${STOP_PATH}`])(
    "injects once after the backend stop response and independent stopped-state confirmation for %s",
    async (stopPath) => {
      const backend = await createBackend();
      const { fault, socketPath, verifyStopped } = await createFault(backend.socketPath);
      fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-stop" });
      expect(await request(socketPath, stopPath)).toEqual({
        status: 500,
        body: JSON.stringify({ message: NATIVE_PODMAN_STOP_FAULT_CANARY }),
      });
      expect(await request(socketPath, stopPath)).toEqual({ status: 204, body: "" });
      expect(verifyStopped).toHaveBeenCalledExactlyOnceWith(CONTAINER_ID);
      expect(fault.receipt()).toMatchObject({
        armed: false,
        faultCount: 1,
        observations: [
          {
            containerId: CONTAINER_ID,
            correlationId: "unit-stop",
            backendStatus: 204,
            verifiedStopped: true,
            verificationFailed: false,
            faultInjected: true,
          },
        ],
      });
    },
  );

  it("does not fault another container or a non-stop request", async () => {
    const backend = await createBackend();
    const { fault, socketPath, verifyStopped } = await createFault(backend.socketPath);
    fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-target" });
    expect(
      await request(socketPath, `/v5.0.0/libpod/containers/${OTHER_CONTAINER_ID}/stop`),
    ).toEqual({ status: 204, body: "" });
    expect(await request(socketPath, STOP_PATH, "GET")).toEqual({ status: 204, body: "" });
    expect(fault.receipt()).toMatchObject({ armed: true, faultCount: 0, observations: [] });
    expect(verifyStopped).not.toHaveBeenCalled();
    expect((await request(socketPath, STOP_PATH)).status).toBe(500);
  });

  it.each([304, 409, 500])("preserves backend status %i without injecting", async (status) => {
    const backendBody = JSON.stringify({ message: "backend-original-error" });
    const backend = await createBackend((_incoming, response) => {
      response.writeHead(status).end(backendBody);
    });
    const { fault, socketPath, verifyStopped } = await createFault(backend.socketPath);
    fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-backend" });
    expect(await request(socketPath, STOP_PATH)).toEqual({
      status,
      body: status === 304 ? "" : backendBody,
    });
    expect(fault.receipt()).toMatchObject({ faultCount: 0 });
    expect(fault.receipt().observations[0]).toMatchObject({
      backendStatus: status,
      verifiedStopped: false,
      faultInjected: false,
    });
    expect(verifyStopped).not.toHaveBeenCalled();
  });

  it.each(["not-stopped", "verification-error"] as const)(
    "preserves the stop response when confirmation returns %s",
    async (outcome) => {
      const backend = await createBackend();
      const verifyStopped = vi.fn((_id: string) =>
        outcome === "verification-error"
          ? Promise.reject(new Error("controlled verification error"))
          : Promise.resolve(false),
      );
      const { fault, socketPath } = await createFault(backend.socketPath, verifyStopped);
      fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-unconfirmed" });
      expect(await request(socketPath, STOP_PATH)).toEqual({ status: 204, body: "" });
      expect(fault.receipt()).toMatchObject({ faultCount: 0 });
      expect(fault.receipt().observations[0]).toMatchObject({
        verifiedStopped: false,
        verificationFailed: outcome === "verification-error",
        faultInjected: false,
      });
    },
  );

  it("claims only one of two concurrent stop requests", async () => {
    const backend = await createBackend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifyStopped = vi.fn(async (_id: string) => {
      await gate;
      return true;
    });
    const { fault, socketPath } = await createFault(backend.socketPath, verifyStopped);
    fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-concurrent" });
    const results = [request(socketPath, STOP_PATH), request(socketPath, STOP_PATH)];
    expect((await Promise.race(results)).status).toBe(204);
    release();
    expect((await Promise.all(results)).map((result) => result.status).sort()).toEqual([204, 500]);
    expect(fault.receipt().faultCount).toBe(1);
    expect(verifyStopped).toHaveBeenCalledTimes(1);
  });

  it("disarms before a stop and rejects a second arm", async () => {
    const backend = await createBackend();
    const { fault, socketPath, verifyStopped } = await createFault(backend.socketPath);
    fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-disarmed" });
    fault.disarm();
    expect(await request(socketPath, STOP_PATH)).toEqual({ status: 204, body: "" });
    expect(verifyStopped).not.toHaveBeenCalled();
    expect(() => fault.arm({ containerId: CONTAINER_ID, correlationId: "second" })).toThrow(
      /only once/u,
    );
  });

  it("disarms while stopped-state confirmation is still pending", async () => {
    const backend = await createBackend();
    let confirm!: (value: boolean) => void;
    let started!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const verified = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    const verifyStopped = vi.fn((_id: string) => {
      started();
      return verified;
    });
    const { fault, socketPath } = await createFault(backend.socketPath, verifyStopped);
    fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-pending-disarm" });
    const response = request(socketPath, STOP_PATH);
    await checking;
    fault.disarm();
    confirm(true);
    expect(await response).toEqual({ status: 204, body: "" });
    expect(fault.receipt().faultCount).toBe(0);
  });

  it("records no injected fault when the client disconnects during stopped-state confirmation", async () => {
    const backend = await createBackend();
    let confirm!: (value: boolean) => void;
    let started!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const verified = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    const verifyStopped = vi.fn((_id: string) => {
      started();
      return verified;
    });
    const { fault, socketPath } = await createFault(backend.socketPath, verifyStopped);
    fault.arm({ containerId: CONTAINER_ID, correlationId: "unit-disconnected" });
    const pendingRequest = http.request({
      socketPath,
      path: STOP_PATH,
      method: "POST",
      agent: false,
    });
    const requestClosed = new Promise<void>((resolve) => pendingRequest.once("close", resolve));
    pendingRequest.on("error", () => undefined);
    pendingRequest.end();
    await checking;
    pendingRequest.destroy();
    await requestClosed;
    await vi.waitFor(() =>
      expect(fault.receipt().observations[0]).toMatchObject({ clientDisconnected: true }),
    );
    confirm(true);
    await vi.waitFor(() =>
      expect(fault.receipt().observations[0]).toMatchObject({ verifiedStopped: true }),
    );
    expect(fault.receipt()).toMatchObject({ faultCount: 0 });
    expect(fault.receipt().observations[0]).toMatchObject({ faultInjected: false });
  });

  it.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])(
    "rejects an incomplete or invalid container ID %s",
    async (containerId) => {
      const backend = await createBackend();
      const { fault } = await createFault(backend.socketPath);
      expect(() => fault.arm({ containerId, correlationId: "unit-invalid" })).toThrow(
        /full container ID/u,
      );
      expect(fault.receipt()).toMatchObject({ armed: false, faultCount: 0 });
    },
  );

  it("removes only its own socket and leaves the real backend available", async () => {
    const backend = await createBackend();
    const { fault, socketPath } = await createFault(backend.socketPath);
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    await fault.close();
    await fault.close();
    await expect(fs.lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.dirname(socketPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(backend.socketPath)).isSocket()).toBe(true);
    expect(await request(backend.socketPath, "/_ping", "GET")).toEqual({ status: 204, body: "" });
    expect(fault.receipt()).toMatchObject({ closed: true, armed: false });
  });

  it("forwards HTTP upgrades and their initial tunnel bytes", async () => {
    const backend = await createBackend();
    backend.server.on("upgrade", (_request, connection, head) => {
      connection.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      connection.write(head);
      connection.on("data", (data) => connection.write(data));
    });
    const { socketPath, fault } = await createFault(backend.socketPath);
    const payload = "initial-upgrade-payload";
    const response = await new Promise<string>((resolve, reject) => {
      const connection = net.createConnection(socketPath);
      let received = "";
      connection.on("error", reject);
      connection.on("data", (chunk) => {
        received += chunk.toString();
        received.includes(payload) ? (resolve(received), connection.destroy()) : undefined;
      });
      connection.once("connect", () =>
        connection.write(
          `POST /v1.40/exec/unit/start HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n${payload}`,
        ),
      );
    });
    expect(response).toContain("101 Switching Protocols");
    expect(response.endsWith(payload)).toBe(true);
    expect(fault.receipt().observations).toEqual([]);
  });
});

// Native Podman run 40625148011, artifact 12788659946, 2026-10-28.
// The retained StopSandbox response is successful. The controlled status-13
// variant follows the same recorded formatter and the pinned status producer.
const TRACE_DRIVER =
  '2026-10-28T03:16:07.674258Z  INFO request{method=POST path="/openshell.v1.OpenShell/StopSandbox" request_id="5cf21467-74cd-4338-9aba-4c08f7ec0636" otel.name=openshell.v1.OpenShell/StopSandbox otel.kind="server" rpc.system="grpc" rpc.service="openshell.v1.OpenShell" rpc.method="StopSandbox"}:driver{otel.name="driver.stop_sandbox" otel.kind="client" driver.name=podman sandbox.id="d60f5dbd-eb98-4dac-b341-343605f5c239"}:driver_rpc{otel.name="driver.stop_sandbox" otel.kind="server" rpc.system="grpc" rpc.service="openshell.compute.v1.ComputeDriver" rpc.method="stop_sandbox"}:podman.stop_sandbox{sandbox_id="d60f5dbd-eb98-4dac-b341-343605f5c239" otel.name="podman.stop_sandbox" sandbox.id=d60f5dbd-eb98-4dac-b341-343605f5c239}: openshell_driver_podman::driver: Stopping sandbox container sandbox_id=d60f5dbd-eb98-4dac-b341-343605f5c239 container=b2315564a8e240b4ecdd3c6c74a308219a19aed1f0b623afcae5889d290e917b';
const TRACE_RESPONSE_ZERO =
  '2026-10-28T03:16:52.877815Z  INFO request{method=POST path="/openshell.v1.OpenShell/StopSandbox" request_id="5cf21467-74cd-4338-9aba-4c08f7ec0636" otel.name=openshell.v1.OpenShell/StopSandbox otel.kind="server" rpc.system="grpc" rpc.service="openshell.v1.OpenShell" rpc.method="StopSandbox" http.response.status_code=200}: openshell_server::multiplex: response status=200 latency_ms=45358';
const TRACE_OTHER_RPC_THIRTEEN =
  '2026-10-28T03:16:03.792288Z  INFO request{method=POST path="/openshell.v1.OpenShell/PushSandboxLogs" request_id="530c4cee-5edc-4108-9f6a-457ec95ec803" otel.name=openshell.v1.OpenShell/PushSandboxLogs otel.kind="server" rpc.system="grpc" rpc.service="openshell.v1.OpenShell" rpc.method="PushSandboxLogs" http.response.status_code=200 rpc.grpc.status_code=13 otel.status_code="ERROR"}: openshell_server::multiplex: response status=200 latency_ms=239526';
const TRACE_CONTAINER = "b2315564a8e240b4ecdd3c6c74a308219a19aed1f0b623afcae5889d290e917b";
const TRACE_SANDBOX = "d60f5dbd-eb98-4dac-b341-343605f5c239";
const TRACE_REQUEST = "5cf21467-74cd-4338-9aba-4c08f7ec0636";
const TRACE_RESPONSE_THIRTEEN = TRACE_RESPONSE_ZERO.replace(
  "http.response.status_code=200}",
  'http.response.status_code=200 rpc.grpc.status_code=13 otel.status_code="ERROR"}',
);
// Phase-field names and values come from OpenShell 0.0.116
// apply_driver_snapshot (d1155aa7, compute/mod.rs:3840–3846).
const TRACE_STOPPED = `2026-10-28T03:16:50.000000Z  INFO openshell_server::compute: Sandbox phase changed sandbox_id=${TRACE_SANDBOX} sandbox_name=podman-dcode old_phase=Stopping new_phase=Stopped`;
const TRACE_OWNER = { containerId: TRACE_CONTAINER, sandboxId: TRACE_SANDBOX };

async function createGatewayLog(contents = "previous gateway output\n") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nc-gateway-log-"));
  const logPath = path.join(directory, "openshell-gateway.log");
  await fs.writeFile(logPath, contents, { mode: 0o600 });
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, logPath };
}

describe.skipIf(process.platform === "win32")("native gateway stop evidence", () => {
  it("reads only the pinned managed user service journal after the pre-stop cursor", () => {
    let invocationId = "a".repeat(32);
    const run = vi.fn((command: string, args: string[]) => ({
      status: 0,
      stdout: command.endsWith("systemctl")
        ? `${invocationId}\n`
        : args.includes("--show-cursor")
          ? "gateway ready\n-- cursor: s=abc;i=1\n"
          : [TRACE_DRIVER, TRACE_STOPPED, TRACE_RESPONSE_THIRTEEN].join("\n"),
    }));
    const cursor = captureNativeGatewayJournalCursor(run);
    const window = readNativeGatewayJournalWindow(cursor, run);
    expect(cursor).toEqual({ cursor: "s=abc;i=1", invocationId });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/journalctl",
      expect.arrayContaining([
        "--unit=nemoclaw-openshell-gateway.service",
        "--show-cursor",
        "--lines=1",
        "--output=cat",
      ]),
      expect.objectContaining({ maxBuffer: 262_144, timeout: 10_000 }),
    );
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/journalctl",
      expect.arrayContaining([
        "--unit=nemoclaw-openshell-gateway.service",
        "--after-cursor=s=abc;i=1",
        "--output=cat",
      ]),
      expect.objectContaining({ maxBuffer: 262_144, timeout: 10_000 }),
    );
    expect(parseNativePodmanStoppedInternalTrace(window.text, TRACE_OWNER)).toMatchObject({
      requestId: TRACE_REQUEST,
      grpcStatus: 13,
      stoppedBeforeResponse: true,
    });
    invocationId = "b".repeat(32);
    expect(() => readNativeGatewayJournalWindow(cursor, run)).toThrow(/identity changed/u);
  });

  it("fails closed when the managed journal cursor or bounded output is unavailable", () => {
    const invocationId = "a".repeat(32);
    const missingCursor = vi.fn((command: string) => ({
      status: 0,
      stdout: command.endsWith("systemctl") ? `${invocationId}\n` : "No entries\n",
    }));
    expect(() => captureNativeGatewayJournalCursor(missingCursor)).toThrow(
      /cursor is unavailable/u,
    );
    const oversized = vi.fn((command: string, args: string[]) => ({
      status: 0,
      stdout: command.endsWith("systemctl")
        ? `${invocationId}\n`
        : args.includes("--show-cursor")
          ? "-- cursor: s=abc;i=1\n"
          : "x".repeat(262_145),
    }));
    const cursor = captureNativeGatewayJournalCursor(oversized);
    expect(() => readNativeGatewayJournalWindow(cursor, oversized)).toThrow(/exceeds its bound/u);
  });

  it("binds the owned native stop, watcher transition, and same-request status 13", () => {
    const trace = parseNativePodmanStoppedInternalTrace(
      [TRACE_DRIVER, TRACE_STOPPED, TRACE_RESPONSE_THIRTEEN].join("\n"),
      TRACE_OWNER,
    );
    expect(trace).toMatchObject({
      requestId: TRACE_REQUEST,
      grpcStatus: 13,
      ...TRACE_OWNER,
      driverLine: 1,
      stoppedLine: 2,
      responseLine: 3,
      stoppedBeforeResponse: true,
    });
    expect(trace.matchedRecords).toEqual({
      driver: TRACE_DRIVER,
      stopped: TRACE_STOPPED,
      response: TRACE_RESPONSE_THIRTEEN,
    });
  });

  it("accepts recorded ANSI formatting without changing the proof fields", () => {
    const text = [TRACE_DRIVER, TRACE_STOPPED, TRACE_RESPONSE_THIRTEEN]
      .join("\n")
      .replaceAll("INFO", "\u001b[32mINFO\u001b[0m");
    expect(parseNativePodmanStoppedInternalTrace(text, TRACE_OWNER).requestId).toBe(TRACE_REQUEST);
  });

  it.each([
    ["the real successful response", TRACE_RESPONSE_ZERO],
    ["another RPC's real error", TRACE_OTHER_RPC_THIRTEEN],
    [
      "another method in the same request",
      TRACE_RESPONSE_THIRTEEN.replaceAll("StopSandbox", "PushSandboxLogs"),
    ],
    [
      "another request ID",
      TRACE_RESPONSE_THIRTEEN.replace(TRACE_REQUEST, "6e436ea1-b184-4ce6-bc85-e5e0921ea93d"),
    ],
    [
      "status 130",
      TRACE_RESPONSE_THIRTEEN.replace("rpc.grpc.status_code=13", "rpc.grpc.status_code=130"),
    ],
  ])("rejects %s as status-13 proof for this stop", (_label, response) => {
    expect(() =>
      parseNativePodmanStoppedInternalTrace(
        [TRACE_DRIVER, TRACE_STOPPED, response].join("\n"),
        TRACE_OWNER,
      ),
    ).toThrow(/same-request gRPC status 13/u);
  });

  it("rejects a phase transition for another sandbox", () => {
    const stopped = TRACE_STOPPED.replace(TRACE_SANDBOX, "f3d9052c-da9c-4a87-8ea0-b1d0bea3ee82");
    expect(() =>
      parseNativePodmanStoppedInternalTrace(
        [TRACE_DRIVER, stopped, TRACE_RESPONSE_THIRTEEN].join("\n"),
        TRACE_OWNER,
      ),
    ).toThrow(/owned Stopped transition/u);
  });

  it("reports a later phase transition without claiming it preceded the response", () => {
    const trace = parseNativePodmanStoppedInternalTrace(
      [TRACE_DRIVER, TRACE_RESPONSE_THIRTEEN, TRACE_STOPPED].join("\n"),
      TRACE_OWNER,
    );
    expect(trace.stoppedBeforeResponse).toBe(false);
    expect(trace.stoppedLine).toBeGreaterThan(trace.responseLine);
  });

  it("rejects an ambiguous duplicate native stop", () => {
    expect(() =>
      parseNativePodmanStoppedInternalTrace(
        [TRACE_DRIVER, TRACE_DRIVER, TRACE_STOPPED, TRACE_RESPONSE_THIRTEEN].join("\n"),
        TRACE_OWNER,
      ),
    ).toThrow(/exactly one owned/u);
  });

  it("rejects a native stop for another container", () => {
    expect(() =>
      parseNativePodmanStoppedInternalTrace(
        [TRACE_DRIVER, TRACE_STOPPED, TRACE_RESPONSE_THIRTEEN].join("\n"),
        { ...TRACE_OWNER, containerId: OTHER_CONTAINER_ID },
      ),
    ).toThrow(/exactly one owned/u);
  });

  it("captures only bytes appended after the owned log cursor", async () => {
    const { logPath } = await createGatewayLog();
    const cursor = captureNativeGatewayLogCursor(logPath);
    const appended = [TRACE_DRIVER, TRACE_STOPPED, TRACE_RESPONSE_THIRTEEN].join("\n");
    await fs.appendFile(logPath, appended);
    expect(await readNativeGatewayLogWindow(cursor)).toEqual({
      text: appended,
      startOffset: Buffer.byteLength("previous gateway output\n"),
      endOffset: Buffer.byteLength(`previous gateway output\n${appended}`),
    });
  });

  it("rejects a replacement log instead of reading another file", async () => {
    const { logPath } = await createGatewayLog();
    const cursor = captureNativeGatewayLogCursor(logPath);
    await fs.rename(logPath, `${logPath}.previous`);
    await fs.writeFile(logPath, "different gateway output\n", { mode: 0o600 });
    await expect(readNativeGatewayLogWindow(cursor)).rejects.toThrow(/identity changed/u);
  });

  it("rejects log truncation after the cursor", async () => {
    const { logPath } = await createGatewayLog();
    const cursor = captureNativeGatewayLogCursor(logPath);
    await fs.truncate(logPath, 0);
    await expect(readNativeGatewayLogWindow(cursor)).rejects.toThrow(/truncated/u);
  });

  it("rejects an oversized window instead of silently dropping evidence", async () => {
    const { logPath } = await createGatewayLog();
    const cursor = captureNativeGatewayLogCursor(logPath);
    await fs.appendFile(logPath, "new gateway output\n");
    await expect(readNativeGatewayLogWindow(cursor, 1)).rejects.toThrow(/bounded capture window/u);
  });

  it("rejects a symlink without reading its target", async () => {
    const { directory, logPath } = await createGatewayLog();
    const link = path.join(directory, "gateway-link.log");
    await fs.symlink(logPath, link);
    expect(() => captureNativeGatewayLogCursor(link)).toThrow();
    expect(await fs.readFile(logPath, "utf8")).toBe("previous gateway output\n");
  });

  it("rejects a log readable by another user", async () => {
    const { logPath } = await createGatewayLog();
    await fs.chmod(logPath, 0o644);
    expect(() => captureNativeGatewayLogCursor(logPath)).toThrow(/private owned regular/u);
  });

  it("rejects a hard-linked log", async () => {
    const { directory, logPath } = await createGatewayLog();
    await fs.link(logPath, path.join(directory, "gateway-hard-link.log"));
    expect(() => captureNativeGatewayLogCursor(logPath)).toThrow(/private owned regular/u);
  });
});
