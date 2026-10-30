// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer, IncomingMessage, type ClientRequest, type Server } from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { text } from "node:stream/consumers";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNativeInferenceBroker } from "../../packaging/windows/runtime/native-inference-broker.mts";
import {
  assertNativeInferenceEndpoint,
  resolveNativeInferenceAddresses,
  requestNativeInference,
} from "../../packaging/windows/runtime/native-inference-endpoint.mts";
import { normalizeOnboardingConfiguration } from "../../packaging/windows/runtime/native-setup-configuration.mts";
import {
  renderNativeEndpointPolicy,
  verifyNativeEndpointPolicy,
} from "../../packaging/windows/distribution/native-endpoint-policy.mts";
import {
  TEST_DOCKER_DRIVER_GATEWAY_CERT_PEM,
  TEST_DOCKER_DRIVER_GATEWAY_KEY_PEM,
} from "../../src/lib/onboard/__test-helpers__/docker-driver-gateway-local-tls.ts";
import {
  finishNativeInferenceCleanup,
  finishNativeInferencePreparation,
  waitForNativeInferenceShutdown,
} from "../../packaging/windows/runtime/native-inference.mts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  syncBuiltinESMExports();
});

function cleanupFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-inference-cleanup-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, "runtime");
  const record = path.join(directory, "owner.json");
  const key = path.join(directory, "key-fixture");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "runtime.dll"), "owned runtime");
  fs.writeFileSync(record, "signed owner fixture");
  fs.writeFileSync(key, "private fixture key");
  const lease = fs.openSync(path.join(directory, "lease"), "wx");
  let released = false;
  cleanups.push(() => {
    try {
      fs.closeSync(lease);
    } catch {
      /* already released by the production cleanup */
    }
  });
  return {
    runtime,
    record,
    key,
    released: () => released,
    actions: {
      closeListener: async () => {},
      stopServer: async () => {},
      serverStopped: () => true,
      removeRuntime: async () => {
        await fs.promises.rm(runtime, { recursive: true });
      },
      removeRecord: async () => {
        await fs.promises.unlink(record);
      },
      deleteCredential: async () => {
        await fs.promises.unlink(key);
      },
      releaseState: async () => {
        fs.closeSync(lease);
        released = true;
      },
    },
  };
}

async function listen(server: Server) {
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
}

async function broker(upstreamPort: number) {
  const owner = await startNativeInferenceBroker(
    { endpoint: `http://127.0.0.1:${upstreamPort}/v1`, inference: "local" },
    "private-provider-key",
    "agent-broker-token",
    { options: {}, environment: {} },
  );
  cleanups.push(async () => {
    owner.server.closeAllConnections();
    await new Promise<void>((resolve) => owner.server.close(() => resolve()));
  });
  return owner;
}

describe("native inference failure cleanup", () => {
  it("always releases preparation state and preserves the primary failure after runtime removal fails", async () => {
    const f = cleanupFixture();
    const primary = new Error("preparation failed");
    const removal = new Error("runtime removal failed");
    const failure = await finishNativeInferencePreparation(primary, {
      removeRuntime: async () => {
        throw removal;
      },
      releaseState: f.actions.releaseState,
    });
    expect((failure as AggregateError).errors).toEqual([primary, removal]);
    expect(f.released()).toBe(true);
    expect(fs.readFileSync(f.record, "utf8")).toBe("signed owner fixture");
    expect(fs.readFileSync(f.key, "utf8")).toBe("private fixture key");
  });

  it("removes runtime, record and key and releases a stopped server's lease after a wait timeout", async () => {
    const f = cleanupFixture();
    const failure = await finishNativeInferenceCleanup(undefined, {
      ...f.actions,
      stopServer: () => waitForNativeInferenceShutdown(new Promise(() => {}), 10),
    });
    expect(failure?.message).toContain("CUDA server did not stop");
    expect(fs.existsSync(f.runtime)).toBe(false);
    expect(fs.existsSync(f.record)).toBe(false);
    expect(fs.existsSync(f.key)).toBe(false);
    expect(f.released()).toBe(true);
  });

  it("preserves the original startup error and diagnostic key while aggregating later cleanup failures", async () => {
    const f = cleanupFixture();
    const primary = new Error("model readiness failed");
    const cleanupFailure = new Error("runtime removal failed");
    const failure = await finishNativeInferenceCleanup(primary, {
      ...f.actions,
      removeRuntime: async () => {
        throw cleanupFailure;
      },
    });
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanupFailure]);
    expect(fs.readFileSync(f.record, "utf8")).toBe("signed owner fixture");
    expect(fs.readFileSync(f.key, "utf8")).toBe("private fixture key");
    expect(f.released()).toBe(true);
  });

  it("retains state ownership for a still-live CUDA process while completing the other cleanup", async () => {
    const f = cleanupFixture();
    const failure = await finishNativeInferenceCleanup(undefined, {
      ...f.actions,
      stopServer: () => waitForNativeInferenceShutdown(new Promise(() => {}), 10),
      serverStopped: () => false,
    });
    expect(failure?.message).toContain("CUDA server did not stop");
    expect(failure?.message).toContain("lease is retained");
    expect(fs.existsSync(f.runtime)).toBe(false);
    expect(fs.existsSync(f.record)).toBe(false);
    expect(fs.existsSync(f.key)).toBe(false);
    expect(f.released()).toBe(false);
  });

  it("still deletes the key and releases the lease when record removal fails", async () => {
    const f = cleanupFixture();
    const failure = await finishNativeInferenceCleanup(undefined, {
      ...f.actions,
      removeRecord: async () => {
        throw new Error("record removal failed");
      },
    });
    expect(failure?.message).toBe("record removal failed");
    expect(fs.existsSync(f.record)).toBe(true);
    expect(fs.existsSync(f.key)).toBe(false);
    expect(f.released()).toBe(true);
  });
});

describe("native inference broker response bounds", () => {
  it.each([
    { status: 201, contentType: "application/json", body: '{"id":"owned-model"}' },
    { status: 429, contentType: "application/problem+json", body: '{"error":"rate limited"}' },
    { status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" },
  ])(
    "forwards status $status with only fixed response headers",
    async ({ status, contentType, body }) => {
      const upstream = createServer((_request, response) => {
        response.writeHead(status, {
          "content-type": contentType,
          "cache-control": "public, max-age=3600",
          "set-cookie": "foreign=provider-controlled",
          "x-provider-header": "must-not-forward",
        });
        response.end(body);
      });
      const owner = await broker(await listen(upstream));
      const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
        headers: { authorization: "Bearer agent-broker-token" },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.has("x-provider-header")).toBe(false);
      expect(await response.text()).toBe(body);
    },
  );

  it.each([
    { encoding: "gzip", compress: gzipSync },
    { encoding: "deflate", compress: deflateSync },
    { encoding: "br", compress: brotliCompressSync },
  ])(
    "preserves authenticated inference POSTs and decodes $encoding responses",
    async ({ encoding, compress }) => {
      const observed: object[] = [];
      const upstream = createServer(async (request, response) => {
        const body = await text(request);
        observed.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body,
        });
        response.writeHead(200, {
          "content-encoding": encoding,
          "content-type": "application/json",
        });
        response.end(compress('{"result":"retained-agent-response"}'));
      });
      const owner = await broker(await listen(upstream));
      const body = JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "hello" }],
      });
      const response = await fetch(`http://127.0.0.1:${owner.port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer agent-broker-token", "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: "retained-agent-response" });
      expect(observed).toEqual([
        {
          method: "POST",
          url: "/v1/chat/completions",
          authorization: "Bearer private-provider-key",
          contentType: "application/json",
          body,
        },
      ]);
    },
  );

  it("applies the response limit to decompressed bytes", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(gzipSync(Buffer.alloc(33 * 1024 * 1024)));
    });
    const owner = await broker(await listen(upstream));
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("provider response exceeded the broker limit");
  });

  it("refuses redirects without sending the provider key to the redirected target", async () => {
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests++;
      response.end("must not be reached");
    });
    const targetPort = await listen(target);
    const upstream = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/private` });
      response.end();
    });
    const owner = await broker(await listen(upstream));
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("redirects are not allowed");
    expect(targetRequests).toBe(0);
  });

  it("rejects and cancels an oversized provider stream without waiting for its end", async () => {
    let providerClosed = false;
    const upstream = createServer((_request, response) => {
      response.once("close", () => {
        providerClosed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write(Buffer.alloc(33 * 1024 * 1024, "x"));
      // Deliberately never end: buffering the complete response cannot finish.
    });
    const owner = await broker(await listen(upstream));
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("provider response exceeded the broker limit");
    await vi.waitFor(() => expect(providerClosed).toBe(true));
  });

  it.each([200, 204])("preserves an ordinary provider response with status %s", async (status) => {
    const upstream = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end('{"data":[]}');
    });
    const owner = await broker(await listen(upstream));
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(status === 204 ? "" : '{"data":[]}');
  });
});

describe("native inference endpoint admission", () => {
  it("completes a verified HTTPS inference request using the admitted localhost pin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-inference-ca-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const ca = path.join(root, "fixture-ca.pem");
    fs.writeFileSync(ca, TEST_DOCKER_DRIVER_GATEWAY_CERT_PEM);
    const requests: object[] = [];
    const server = https.createServer(
      {
        cert: TEST_DOCKER_DRIVER_GATEWAY_CERT_PEM,
        key: TEST_DOCKER_DRIVER_GATEWAY_KEY_PEM,
      },
      (request, response) => {
        requests.push({ host: request.headers.host, authorization: request.headers.authorization });
        response.end('{"accepted":true}');
      },
    );
    const port = await listen(server);
    const module = new URL(
      "../../packaging/windows/runtime/native-inference-endpoint.mts",
      import.meta.url,
    ).href;
    const source = `import {requestNativeInference} from ${JSON.stringify(module)};
      const response = await requestNativeInference(new URL("https://localhost:${port}/v1/models"), "local", {
        method:"GET", headers:{authorization:"Bearer synthetic-provider-key"}, signal:AbortSignal.timeout(5000)
      });
      for await (const chunk of response) process.stdout.write(chunk);`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({ accepted: true });
    expect(requests).toEqual([
      { host: `localhost:${port}`, authorization: "Bearer synthetic-provider-key" },
    ]);
  });

  it("rejects an untrusted TLS peer before sending credentials even with an unsafe ambient TLS setting", async () => {
    let connections = 0;
    let requests = 0;
    const server = https.createServer(
      {
        cert: TEST_DOCKER_DRIVER_GATEWAY_CERT_PEM,
        key: TEST_DOCKER_DRIVER_GATEWAY_KEY_PEM,
      },
      (_request, response) => {
        requests++;
        response.end();
      },
    );
    server.on("connection", () => {
      connections++;
    });
    const port = await listen(server);
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await expect(
      requestNativeInference(new URL(`https://localhost:${port}/v1/models`), "local", {
        method: "GET",
        headers: { authorization: "Bearer synthetic-provider-key" },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(connections).toBe(1);
    expect(requests).toBe(0);
  });

  it("pins the transport to admitted DNS answers while retaining URL identity and TLS verification", async () => {
    const endpoint = new URL("https://provider.example:8443/v1/models");
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const socket = new Socket();
    const response = new IncomingMessage(socket);
    response.statusCode = 200;
    cleanups.push(() => {
      response.destroy();
      socket.destroy();
    });
    const request = Object.assign(new EventEmitter(), {
      end: vi.fn(() => {
        queueMicrotask(() => request.emit("response", response));
      }),
    });
    const transport = vi
      .spyOn(https, "request")
      .mockReturnValue(request as unknown as ClientRequest);
    syncBuiltinESMExports();
    const result = await requestNativeInference(
      endpoint,
      "compatible",
      {
        method: "GET",
        headers: { authorization: "Bearer synthetic-provider-key" },
        signal: AbortSignal.timeout(5000),
      },
      lookup,
    );
    expect(result).toBe(response);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("provider.example", { all: true });
    const [url, options] = transport.mock.calls[0] as unknown as [URL, https.RequestOptions];
    expect(url.href).toBe(endpoint.href);
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    const callback = vi.fn();
    options.lookup!("provider.example", { all: true }, callback);
    await new Promise<void>((done) => queueMicrotask(done));
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, [{ address: "8.8.8.8", family: 4 }]);
    const single = vi.fn();
    options.lookup!("provider.example", {}, single);
    await new Promise<void>((done) => queueMicrotask(done));
    expect(single).toHaveBeenCalledExactlyOnceWith(null, "8.8.8.8", 4);
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(
      requestNativeInference(
        endpoint,
        "compatible",
        {
          method: "GET",
          headers: {},
          signal: AbortSignal.timeout(5000),
        },
        lookup,
      ),
    ).rejects.toThrow("exclusively to public addresses");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending DNS resolution without later opening a provider connection", async () => {
    let resolve!: (addresses: { address: string; family: number }[]) => void;
    const pending = new Promise<{ address: string; family: number }[]>((done) => {
      resolve = done;
    });
    const transport = vi.spyOn(https, "request");
    syncBuiltinESMExports();
    const cancelled = new AbortController();
    const result = requestNativeInference(
      new URL("https://provider.example/v1"),
      "compatible",
      {
        method: "GET",
        headers: {},
        signal: cancelled.signal,
      },
      async () => pending,
    );
    cancelled.abort();
    await expect(result).rejects.toThrow("cancelled");
    resolve([{ address: "8.8.8.8", family: 4 }]);
    await new Promise((done) => setImmediate(done));
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "https://169.254.169.254/v1",
    "https://10.1.2.3/v1",
    "https://[::1]/v1",
    "https://[::ffff:169.254.169.254]/v1",
    "https://2130706433/v1",
    "https://[64:ff9b::a00:1]/v1",
    "https://[fc00::1]/v1",
    "https://198.18.0.1/v1",
    "https://[2001:db8::1]/v1",
    "https://service.internal./v1",
    "https://metadata/v1",
    "https://localhost/v1",
    "https://host.local/v1",
    "http://example.com/v1",
    "https://user:secret@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/v1#secret",
  ])("rejects unsafe remote setup endpoint %s", (endpoint) => {
    expect(() =>
      normalizeOnboardingConfiguration(
        {
          agent: "hermes",
          inference: "compatible",
          options: { endpoint, model: "fixture", credential: "synthetic-provider-key" },
        },
        false,
      ),
    ).toThrow();
  });

  it.each(
    [
      [],
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
      [{ address: "::ffff:127.0.0.1", family: 6 }],
      [{ address: "8.8.8.8", family: 6 }],
      [{ address: "not-an-address", family: 4 }],
    ].map((addresses) => ({ addresses })),
  )("rejects empty, private, mixed or malformed resolver answers %#", async ({ addresses }) => {
    await expect(
      resolveNativeInferenceAddresses(
        new URL("https://public.example/v1"),
        "compatible",
        async () => addresses,
      ),
    ).rejects.toThrow("exclusively to public addresses");
  });

  it("fails closed on DNS failure without disclosing resolver diagnostics", async () => {
    await expect(
      resolveNativeInferenceAddresses(
        new URL("https://public.example/v1"),
        "compatible",
        async () => {
          throw new Error("private resolver detail");
        },
      ),
    ).rejects.toThrow(/^The inference endpoint could not be resolved\.$/u);
  });

  it("copies all admitted addresses without retaining mutable resolver-owned entries", async () => {
    const answers = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const pins = await resolveNativeInferenceAddresses(
      new URL("https://public.example/v1"),
      "compatible",
      async () => answers,
    );
    expect(pins).toEqual(answers);
    answers[0].address = "127.0.0.1";
    expect(pins[0].address).toBe("8.8.8.8");
  });

  it.each([
    { host: "localhost", address: "127.0.0.1", family: 4 },
    { host: "127.0.0.1", address: "127.0.0.1", family: 4 },
    { host: "[::1]", address: "::1", family: 6 },
  ])(
    "preserves explicit local inference at $host without DNS",
    async ({ host, address, family }) => {
      const lookup = vi.fn(async () => {
        throw new Error("must not resolve");
      });
      const endpoint = new URL(`http://${host}/v1`);
      expect(await resolveNativeInferenceAddresses(endpoint, "local", lookup)).toEqual([
        { address, family },
      ]);
      expect(() => assertNativeInferenceEndpoint(endpoint, "compatible")).toThrow();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("refuses a private HTTPS endpoint before any provider connection", async () => {
    let providerRequests = 0;
    let providerConnections = 0;
    const upstream = createServer((_request, response) => {
      providerRequests++;
      response.end();
    });
    upstream.on("connection", () => {
      providerConnections++;
    });
    const port = await listen(upstream);
    const owner = await startNativeInferenceBroker(
      { endpoint: `https://127.0.0.1:${port}/v1`, inference: "compatible" },
      "synthetic-provider-key",
      "agent-broker-token",
      { options: {}, environment: {} },
    );
    cleanups.push(async () => {
      owner.server.closeAllConnections();
      await new Promise<void>((resolve) => owner.server.close(() => resolve()));
    });
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
    });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("private or reserved");
    expect(text).not.toContain("synthetic-provider-key");
    expect(providerRequests).toBe(0);
    expect(providerConnections).toBe(0);
  });

  it("rejects stale generated policy when the canonical network document changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-endpoint-policy-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, "packaging/windows/runtime");
    const blueprint = path.join(root, "nemoclaw-blueprint");
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(blueprint);
    const source = path.join(blueprint, "private-networks.yaml");
    fs.writeFileSync(source, "ipv4: []\nipv6: []\nnames: []\n");
    fs.writeFileSync(
      path.join(runtime, "native-endpoint-policy.generated.json"),
      renderNativeEndpointPolicy(runtime),
    );
    expect(() => verifyNativeEndpointPolicy(runtime)).not.toThrow();
    fs.writeFileSync(source, "ipv4: []\nipv6: []\nnames: [{name: internal, purpose: fixture}]\n");
    expect(() => verifyNativeEndpointPolicy(runtime)).toThrow("policy is stale");
  });
});
