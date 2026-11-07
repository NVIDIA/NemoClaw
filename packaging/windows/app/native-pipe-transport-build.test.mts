// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EventEmitter } from "node:events";
import syntax from "typescript";
import { transformSync } from "esbuild";
import { compileNativePipeTransport } from "./native-pipe-transport-build.mts";
import { createBrokerRelayPeer } from "../runtime/native-broker-relay-protocol.mts";
import { containedBrokerRelayFiles } from "../runtime/native-broker-tunnel.mts";

const listenerPath = "dist/server-start-yuOHTviK.js";
const listener =
  "module.exports = function(httpServer, port, bindHost) { return httpServer.listen(port, bindHost); };";
const clientPath = "dist/client-I-RoP1Al.js";
const client =
  "module.exports = function(url, transport) { return new WebSocket(url, transport.options); };";
const providerPath = "dist/provider-transport-fetch-DGSx4u4m.js";
const provider =
  "module.exports = function(model, guardedFetchOptions, useEnvProxy) { return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions); };";
const callPath = "dist/call-BWR5pPgw.js";
const catalogPath = "dist/provider-catalog-live-runtime-EZZSw18v.js";
const catalog =
  "module.exports = async function(params, options) { return await params.fetchGuard(options); };";
const localCatalogPath = "dist/provider-setup-CQYNqo2d.js";
const localCatalog =
  "module.exports = async function(params) { return await fetchWithSsrFGuard({ url: params.url }); };";
const call =
  "function shouldOmitDeviceIdentityForGatewayCall(params) { return params.original; } module.exports = shouldOmitDeviceIdentityForGatewayCall;";
function load(
  relative: string,
  text: string,
  selected?: string,
  platform = "win32",
  broker?: string,
  environment: Record<string, string> = {},
  modules: Record<string, unknown> = {},
) {
  const code = transformSync(compileNativePipeTransport(relative, text, syntax), {
    format: "cjs",
  }).code;
  const context = {
    module: { exports: undefined as unknown },
    process: {
      platform,
      env: {
        ...environment,
        ...(selected === undefined ? {} : { NEMOCLAW_MXC_GATEWAY_PIPE_PORT: selected }),
        ...(broker === undefined ? {} : { NEMOCLAW_MXC_BROKER_PIPE_PORT: broker }),
      },
    },
    fetchWithSsrFGuard: (options: unknown) => options,
    withTrustedEnvProxyGuardedFetchMode: (options: object) => ({
      ...options,
      mode: "trusted_env_proxy",
    }),
    URL,
    Response,
    Request,
    Headers,
    AbortSignal,
    require: (name: string) => {
      if (name in modules) return modules[name];
      if (name === "node:stream") return { Readable };
      if (name === "node:stream/promises") return { pipeline };
      if (name === "node:http") return { request: () => assert.fail("Unexpected HTTP request") };
      assert.equal(name, "node:net");
      return { connect: (pipe: string) => ({ pipe }) };
    },
    WebSocket: function (url: string, options: Record<string, unknown>) {
      return { url, options };
    },
  };
  vm.runInNewContext(code, context);
  return context.module.exports as (...args: unknown[]) => unknown;
}

test("declared gateway listener uses only its sandbox-local pipe", () => {
  const listen = load(listenerPath, listener, "18789");
  const server = { listen: (...args: unknown[]) => args };
  const [options] = listen(server, 18789, "127.0.0.1") as { path: string }[];
  assert.equal(options?.path, String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18789`);
  assert.equal((listen(server, 18789, "::1") as { path: string }[])[0]?.path, options?.path);
  assert.throws(() => listen(server, 18790, "127.0.0.1"), /declared loopback port/);
  assert.throws(() => listen(server, 18789, "0.0.0.0"), /declared loopback port/);
  assert.deepEqual(load(listenerPath, listener)(server, 18789, "127.0.0.1"), [18789, "127.0.0.1"]);
});

test("native provider identities use only their selected broker transport", () => {
  for (const providerId of ["nvidia", "openrouter"]) {
    const fetch = load(providerPath, provider, undefined, "win32", "18790", {
      NEMOCLAW_MXC_MODEL_PROVIDER: providerId,
    });
    const options = { url: "http://127.0.0.1:18790/v1/chat/completions" };
    const guarded = fetch(
      { provider: providerId, baseUrl: "http://127.0.0.1:18790/v1" },
      options,
    ) as { dispatcherPolicy: unknown };
    assert(guarded.dispatcherPolicy);
    assert.equal(
      fetch({ provider: "foreign", baseUrl: "https://foreign.invalid" }, options),
      options,
    );
  }
});

test("native catalog parsing receives the provider response over the authenticated private pipe", async () => {
  const requests: Record<string, any>[] = [];
  const modules = {
    "node:stream": { Readable },
    "node:http": {
      request(options: Record<string, unknown>, callback: (response: Readable) => void) {
        requests.push(options);
        const request = new EventEmitter() as EventEmitter & { end(): void };
        request.end = () =>
          callback(
            Object.assign(Readable.from([Buffer.from('{"data":[{"id":"fixture"}]}')]), {
              statusCode: 200,
              headers: {},
            }),
          );
        return request;
      },
    },
  };
  const environment = {
    NEMOCLAW_MXC_MODEL_PROVIDER: "nvidia",
    NEMOCLAW_MXC_MODEL_TOKEN: "fixture-token_".repeat(4),
  };
  const fetch = load(catalogPath, catalog, undefined, "win32", "18790", environment, modules);
  const params = {
    providerId: "nvidia",
    fetchGuard: () => assert.fail("Direct network must not run"),
  };
  const url = "https://integrate.api.nvidia.com/v1/models";
  const result = (await fetch(params, {
    url,
    timeoutMs: 2000,
    init: { headers: { authorization: "untrusted-header" } },
  })) as { response: Response; finalUrl: string; release(): Promise<void> };
  assert.deepEqual(await result.response.json(), { data: [{ id: "fixture" }] });
  assert.equal(result.finalUrl, url);
  await result.release();
  assert.equal(requests[0]?.socketPath, String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18790`);
  assert.equal(requests[0]?.path, "/v1/models");
  assert.equal(
    requests[0]?.headers.authorization,
    "Bearer " + environment.NEMOCLAW_MXC_MODEL_TOKEN,
  );
  assert.equal(requests[0]?.method, "GET");
  const featured = (await fetch(params, {
    url: "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json",
  })) as typeof result;
  await featured.release();
  assert.equal(requests[1]?.path, "/native/nvidia-featured-models");
  for (const target of [
    url + "?next=other",
    url + "#fragment",
    "https://other.invalid/v1/models",
    "http://127.0.0.1:18791/v1/models",
    "http://127.0.0.1:18790/v1/chat/completions",
  ]) {
    await assert.rejects(async () => fetch(params, { url: target }), /escaped/);
  }
  await assert.rejects(
    async () => fetch({ ...params, providerId: "openrouter" }, { url }),
    /escaped/,
  );
  assert.equal(requests.length, 2);
  const unmodified = load(catalogPath, catalog, undefined, "linux", undefined, {}, modules);
  assert.equal(await unmodified({ fetchGuard: () => "native-fetch" }, { url }), "native-fetch");
  const local = load(
    localCatalogPath,
    localCatalog,
    undefined,
    "win32",
    "18790",
    { ...environment, NEMOCLAW_MXC_MODEL_PROVIDER: "nemoclawNative" },
    modules,
  );
  const localResult = (await local({ url: "http://127.0.0.1:18790/v1/models" })) as typeof result;
  await localResult.release();
  assert.equal(requests[2]?.path, "/v1/models");
});

test("provider pipe retains guarded fetch and refuses origin or transport changes", () => {
  const fetch = load(providerPath, provider, undefined, "win32", "18790");
  const model = { provider: "nemoclawNative", baseUrl: "http://127.0.0.1:18790/v1" };
  const policy = { allowedOrigins: [model.baseUrl] };
  const init = { method: "POST", headers: { authorization: "fixture" } };
  const options = { url: model.baseUrl + "/chat/completions", timeoutMs: 10000, policy, init };
  const guarded = fetch(model, options, true) as typeof options & {
    dispatcherPolicy: { connect: { socketPath: string } };
    resolveDispatcherPolicy(url: URL): unknown;
  };
  assert.equal(guarded.policy, policy);
  assert.equal(guarded.init, init);
  assert.equal(guarded.timeoutMs, options.timeoutMs);
  assert.equal(
    guarded.dispatcherPolicy.connect.socketPath,
    String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18790`,
  );
  assert.equal(
    guarded.resolveDispatcherPolicy(new URL(model.baseUrl + "/models")),
    guarded.dispatcherPolicy,
  );
  for (const url of [
    "http://example.invalid:18790/v1/models",
    "http://127.0.0.1:18791/v1/models",
    "http://127.0.0.1:18790/private",
    "https://127.0.0.1:18790/v1/models",
    model.baseUrl + "/models?key=other",
  ])
    assert.throws(() => guarded.resolveDispatcherPolicy(new URL(url)), /escaped/);
  assert.throws(() => fetch(model, { ...options, dispatcherPolicy: {} }), /conflicting/);
  assert.throws(() => fetch(model, { ...options, fetchImpl: () => {} }), /conflicting/);
  assert.throws(
    () => fetch({ ...model, baseUrl: "https://127.0.0.1:18790/v1" }, options),
    /declared local origin/,
  );
  assert.throws(
    () => load(providerPath, provider, undefined, "win32", "018790")(model, options),
    /Invalid native broker/,
  );
  assert.equal(fetch({ ...model, provider: "other" }, options), options);
  assert.equal(load(providerPath, provider)(model, options), options);
});

test(
  "Windows guarded provider pipe streams repeated responses and propagates cancellation",
  {
    skip: process.platform !== "win32",
    timeout: 30000,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-provider-pipe-"));
    const slots = Array.from({ length: 32 }, () => `stream-${randomBytes(8).toString("hex")}`);
    for (const slot of slots) fs.mkdirSync(path.join(root, slot));
    const payload = Buffer.from("data: " + "a".repeat(96 * 1024) + "\n\ndata: [DONE]\n\n");
    let received = 0;
    const server = http.createServer(async (request, response) => {
      const body = await buffer(request);
      received++;
      response.setHeader("content-type", "text/event-stream");
      if (body.toString() === "wait") {
        response.flushHeaders();
        return;
      }
      if (
        request.headers.authorization !== "Bearer fixture" ||
        body.toString() !== "fixture request"
      ) {
        response.writeHead(400).end();
        return;
      }
      response.end(payload);
    });
    let host: Awaited<ReturnType<typeof createBrokerRelayPeer>> | undefined;
    let sandbox: typeof host;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const options = {
        files: containedBrokerRelayFiles(root),
        token: randomBytes(32).toString("base64url"),
        slots,
      };
      const pipePort = randomInt(20000, 60000);
      host = await createBrokerRelayPeer({
        ...options,
        side: "host",
        brokerPort: (server.address() as { port: number }).port,
      });
      sandbox = await createBrokerRelayPeer({
        ...options,
        side: "sandbox",
        sandboxPipePort: pipePort,
      });
      const url = `http://127.0.0.1:${pipePort}/v1/chat/completions`;
      const adapt = load(
        providerPath,
        provider,
        undefined,
        "win32",
        String(pipePort),
        {},
        { "node:http": http },
      );
      const guarded = adapt(
        { provider: "nemoclawNative", baseUrl: `http://127.0.0.1:${pipePort}/v1` },
        { url },
      ) as {
        fetchImpl(url: string, init: RequestInit): Promise<Response>;
      };
      for (let turn = 0; turn < 36; turn++) {
        const request = new Request(url, {
          method: "POST",
          headers: { authorization: "Bearer fixture" },
          body: "fixture request",
        });
        const response = await guarded.fetchImpl(url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
          ...{ duplex: "half" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/event-stream");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
      }
      const beforeRejected = received;
      await assert.rejects(
        guarded.fetchImpl("http://127.0.0.1:1/v1/models", { redirect: "manual" }),
        /escaped/,
      );
      await assert.rejects(guarded.fetchImpl(url, { redirect: "follow" }), /guarded redirects/);
      assert.equal(received, beforeRejected);
      const controller = new AbortController();
      const pending = await guarded.fetchImpl(url, {
        method: "POST",
        body: "wait",
        redirect: "manual",
        signal: controller.signal,
      });
      controller.abort();
      await assert.rejects(pending.text());
      const cancelled = await guarded.fetchImpl(url, {
        method: "POST",
        body: "wait",
        redirect: "manual",
      });
      await cancelled.body!.cancel();
      await sandbox.close();
      await host.close();
      assert.equal(host.diagnostics().activeConnections, 0);
      assert.equal(sandbox.diagnostics().activeConnections, 0);
    } finally {
      try {
        await sandbox?.close();
      } finally {
        try {
          await host?.close();
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
);

test("pipe activation rejects invalid ports and non-Windows execution", () => {
  const server = { listen: () => assert.fail("Invalid configuration reached listen") };
  for (const port of ["", "0", "018789", "65536", "-1", "18789/other", " 18789"])
    assert.throws(
      () => load(listenerPath, listener, port)(server, 18789, "127.0.0.1"),
      /Invalid native gateway pipe port/,
    );
  assert.throws(
    () => load(listenerPath, listener, "18789", "linux")(server, 18789, "127.0.0.1"),
    /Invalid native gateway pipe port/,
  );
});

test("normal gateway client retains options and uses the declared pipe only", () => {
  const connect = load(clientPath, client, "18789");
  const options = { handshakeTimeout: 3000, headers: { authorization: "fixture-token" } };
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const socket = connect(`ws://${host}:18789`, { options }) as {
      options: typeof options & { createConnection(): { pipe: string } };
    };
    assert.equal(socket.options.headers, options.headers);
    assert.equal(socket.options.handshakeTimeout, options.handshakeTimeout);
    assert.equal(
      socket.options.createConnection().pipe,
      String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18789`,
    );
  }
  for (const url of ["ws://example.invalid:18789", "ws://127.0.0.1:12345"])
    assert.equal((connect(url, { options }) as { options: unknown }).options, options);
  assert.equal(
    (load(clientPath, client)("ws://127.0.0.1:18789", { options }) as { options: unknown }).options,
    options,
  );
  assert.throws(() => connect("wss://127.0.0.1:18789", { options }), /requires local ws transport/);
});

test("pipe clients retain device identity instead of assuming TCP loopback trust", () => {
  const omit = load(callPath, call, "18789");
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(omit({ url: `ws://${host}:18789`, original: true }), false);
  for (const url of ["ws://example.invalid:18789", "ws://127.0.0.1:12345"])
    assert.equal(omit({ url, original: true }), true);
  assert.equal(load(callPath, call)({ url: "ws://127.0.0.1:18789", original: true }), true);
  assert.throws(
    () => load(callPath, call, "0")({ url: "ws://127.0.0.1:18789" }),
    /Invalid native gateway/,
  );
});

test("compiler rejects missing or duplicated pinned transport sites", () => {
  assert.equal(compileNativePipeTransport("unrelated.js", listener), listener);
  assert.throws(() => compileNativePipeTransport(listenerPath, listener), /syntax parser/);
  for (const [relative, code] of [
    [listenerPath, listener],
    [clientPath, client],
    [providerPath, provider],
    [callPath, call],
    [catalogPath, catalog],
    [localCatalogPath, localCatalog],
  ]) {
    assert.throws(
      () => compileNativePipeTransport(relative!, "unrelated();", syntax),
      /call site changed/,
    );
    assert.throws(
      () => compileNativePipeTransport(relative!, code! + code!, syntax),
      /call site changed/,
    );
  }
});
