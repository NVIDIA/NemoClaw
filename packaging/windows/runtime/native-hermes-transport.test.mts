// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import ts from "typescript";
import { interactiveWorkloadSource } from "./run-installed-native-console-agent.mts";
import { hermesWorkloadSource } from "./run-installed-native-hermes-turn.mts";

const moduleSource = fs.readFileSync(new URL("native-local-pipe.mts", import.meta.url), "utf8");
const parsed = ts.createSourceFile(
  "native-local-pipe.mts",
  moduleSource,
  ts.ScriptTarget.Latest,
  true,
);
const declaration = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "requestNativeBrokerBootstrap",
);
assert(declaration);
const requestSource = stripTypeScriptTypes(declaration.getText(parsed).replace(/^export\s+/u, ""), {
  mode: "strip",
});
const token = "fixture-bootstrap-token-0123456789";

for (const mode of [
  "ok",
  "denied",
  "redirect",
  "malformed",
  "utf8",
  "oversized",
  "interrupted",
  "abort",
  "timeout",
] as const) {
  test(
    `contained bootstrap ${mode} uses the pipe and settles its request before returning`,
    { skip: process.platform === "win32" },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bootstrap-"));
      const socketPath = path.join(root, "bootstrap.sock");
      const controller = new AbortController();
      let requests = 0;
      let requestClosed = false;
      const server = http.createServer((request, response) => {
        requests++;
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/native/bootstrap");
        assert.equal(
          request.headers.authorization,
          mode === "denied" ? undefined : `Bearer ${token}`,
        );
        if (mode === "denied") {
          response.writeHead(403);
          response.end("not JSON");
        } else if (mode === "redirect") {
          response.writeHead(302, { location: "http://foreign.invalid/private" });
          response.end();
        } else if (mode === "malformed") response.end("not JSON");
        else if (mode === "utf8") response.end(Buffer.from([34, 255, 34]));
        else if (mode === "oversized") response.end("x".repeat(1024 * 1024 + 1));
        else if (mode === "interrupted") {
          response.writeHead(200, { "content-length": 1000 });
          response.write("{");
          setImmediate(() => response.destroy());
        } else if (mode === "abort") controller.abort();
        else if (mode !== "timeout") response.end(JSON.stringify({ environment: {}, options: {} }));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const run = new Function(
        "http",
        "nativeLocalPipeName",
        "setTimeout",
        "clearTimeout",
        `${requestSource}\nreturn requestNativeBrokerBootstrap;`,
      )(
        {
          request(options: http.RequestOptions) {
            assert.equal(options.socketPath, socketPath);
            assert.equal(options.host, undefined);
            assert.equal(options.port, undefined);
            assert.equal(options.agent, false);
            const request = http.request(options);
            request.once("close", () => {
              requestClosed = true;
            });
            return request;
          },
        },
        (port: number) => {
          assert.equal(port, 21000);
          return socketPath;
        },
        (callback: () => void, milliseconds: number) => {
          assert.equal(milliseconds, 15000);
          return setTimeout(callback, mode === "timeout" ? 40 : milliseconds);
        },
        clearTimeout,
      );
      try {
        await assert.rejects(run(21000, "bad\r\nheader"), /identity/u);
        const result = run(21000, mode === "denied" ? null : token, controller.signal);
        if (["malformed", "utf8", "oversized", "interrupted", "abort", "timeout"].includes(mode))
          await assert.rejects(result);
        else
          assert.deepEqual(await result, {
            status: mode === "denied" ? 403 : mode === "redirect" ? 302 : 200,
            body: mode === "ok" ? { environment: {}, options: {} } : null,
          });
        assert(requestClosed, "the public request promise must not outlive handle closure");
        assert.equal(requests, 1);
        const stopped = new AbortController();
        stopped.abort();
        await assert.rejects(run(21000, token, stopped.signal));
        assert.equal(requests, 1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("shared authenticated bootstrap reader keeps its existing success and failure contract", async () => {
  const declaration = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "readNativeBrokerBootstrap",
  );
  assert(declaration);
  const code = stripTypeScriptTypes(declaration.getText(parsed).replace(/^export\s+/u, ""), {
    mode: "strip",
  });
  let calls = 0;
  let status = 200;
  const body = { environment: {}, openclaw: {} };
  const read = new Function(
    "requestNativeBrokerBootstrap",
    `${code}\nreturn readNativeBrokerBootstrap;`,
  )(async (port: number, observedToken: string) => {
    assert.equal(port, 21000);
    assert.equal(observedToken, token);
    calls++;
    return { status, body };
  });
  assert.equal(await read(21000, token), body);
  status = 403;
  await assert.rejects(read(21000, token), /request failed/u);
  await assert.rejects(read(21000, null), /identity/u);
  assert.equal(calls, 2);
});

test("Hermes guest declares both broker pipes before bootstrap and exports the exact browser endpoint", async () => {
  const source = interactiveWorkloadSource();
  const start = source.indexOf("brokerTunnel = await startNativeBrokerTunnel(");
  const end = source.indexOf("Object.assign(process.env, nativeServices.environment);", start);
  assert(start > 0 && end > start);
  const environment: Record<string, string> = {
    NEMOCLAW_BROKER_RELAY_ROOT: "owned-model-relay",
    NEMOCLAW_BROKER_RELAY_TOKEN: "model-relay-token",
    NEMOCLAW_BROWSER_RELAY_ROOT: "owned-browser-relay",
    NEMOCLAW_BROWSER_RELAY_TOKEN: "browser-relay-token",
    NEMOCLAW_HERMES_BROWSER_PIPE_PORT: "21001",
    NEMOCLAW_BROWSER_CDP_PATH: "/devtools/browser/owned-session",
  };
  const controller = new AbortController();
  const calls: unknown[] = [];
  const receipt: Record<string, any> = { contained: {} };
  const context = {
    required: (name: string) => {
      assert(environment[name]);
      return environment[name];
    },
    agent: "hermes",
    inferencePipePort: 21000,
    brokerToken: token,
    stopWatcher: { signal: controller.signal },
    connectivity: receipt,
    bootstrapReceipt: "owned-receipt",
    process: { env: {} as Record<string, string> },
    startNativeBrokerTunnel: async (options: any) => {
      calls.push(options);
      return { port: options.sandboxPipePort };
    },
    requestNativeBrokerBootstrap: async (
      port: number,
      credential: string | null,
      signal: AbortSignal,
    ) => {
      assert.equal(port, 21000);
      assert.equal(signal, controller.signal);
      calls.push(credential);
      return credential === null
        ? { status: 403, body: null }
        : { status: 200, body: { environment: {}, options: {} } };
    },
    writeFileSync: (file: string, value: string) => {
      assert.equal(file, "owned-receipt");
      assert.equal(JSON.parse(value).verdict, "pass");
    },
  };
  const execute = new Function(
    "context",
    `return (async () => { const {${Object.keys(context).join(",")}} = context; let brokerTunnel, browserTunnel, bootstrapWritten; ${source.slice(start, end)} return {bootstrapWritten, nativeServices}; })();`,
  );
  const result = await execute(context);
  assert.equal(result.bootstrapWritten, true);
  assert.deepEqual(calls, [
    {
      relayRoot: "owned-model-relay",
      relayToken: "model-relay-token",
      sandboxPipePort: 21000,
      signal: controller.signal,
    },
    {
      relayRoot: "owned-browser-relay",
      relayToken: "browser-relay-token",
      sandboxPipePort: 21001,
      signal: controller.signal,
    },
    null,
    token,
  ]);
  assert.equal(
    context.process.env.BROWSER_CDP_URL,
    "ws://127.0.0.1:21001/devtools/browser/owned-session",
  );
  assert.equal(context.process.env.BU_CDP_WS, context.process.env.BROWSER_CDP_URL);
  assert.equal(receipt.contained.pipeConnected, true);
  assert.equal(receipt.contained.tcpConnected, undefined);
  assert.equal(receipt.containedPipePort, 21000);
  assert.equal(receipt.containedPort, undefined);
});

test("Hermes deterministic turn model binds only its declared native pipe", async () => {
  const source = hermesWorkloadSource();
  const start = source.indexOf("await new Promise((resolve, reject) => {");
  const end = source.indexOf("mkdirSync(hermesHome", start);
  assert(start >= 0 && end > start);
  const calls: unknown[] = [];
  const context = {
    modelPort: 21000,
    nativeLocalPipeName: (port: number) => {
      assert.equal(port, 21000);
      return "owned-pipe";
    },
    model: {
      once(event: string) {
        assert.equal(event, "error");
      },
      listen(...args: any[]) {
        calls.push(args.slice(0, -1));
        args.at(-1)();
      },
    },
  };
  await new Function(
    "context",
    `return (async () => { const {${Object.keys(context).join(",")}} = context; ${source.slice(start, end)} })();`,
  )(context);
  assert.deepEqual(calls, [["owned-pipe"]]);
  assert(source.includes('required("NEMOCLAW_HERMES_INFERENCE_PIPE_PORT") !== String(modelPort)'));
});

test("Hermes bootstrap receipt requires matching pipe and authentication evidence, not historical TCP fields", () => {
  const source = fs.readFileSync(
    new URL("run-installed-native-console-agent.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const validPort =", source.indexOf("const publishBootstrap ="));
  const end = source.indexOf(
    "for (const directory of [consoleEvidenceRoot, dashboardEvidenceRoot])",
    start,
  );
  assert(start > 0 && end > start);
  const code = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
  const valid = {
    schemaVersion: 1,
    agent: "hermes",
    sessionId: "0123456789",
    interface: "dashboard",
    transport: "guarded-file-native-pipe",
    brokerHost: "127.0.0.1",
    brokerPort: 12345,
    containedPipePort: 21000,
    contained: {
      pipeConnected: true,
      unauthenticatedStatus: 403,
      authenticatedStatus: 200,
      bootstrapConsumedByWorkload: true,
    },
    verdict: "pass",
    failureStage: null,
    errorCode: null,
  };
  const context = {
    agentId: "hermes",
    runId: "0123456789",
    dashboard: true,
    inferencePipePort: 21000,
    broker: { port: 12345 },
    hostProbe: { status: 403 },
    sandboxName: "owned-sandbox",
    fail: (message: string) => {
      throw new Error(message);
    },
  };
  const verify = new Function(
    "result",
    "context",
    `const {${Object.keys(context).join(",")}} = context; ${code}\nreturn receipt;`,
  );
  const receipt = verify(valid, context);
  assert.equal(receipt.transport, "guarded-file-native-pipe");
  assert.equal(receipt.containedPipePort, 21000);
  assert.equal(receipt.contained.tcpConnected, undefined);
  const mutations = [
    { transport: "guarded-file-tcp", containedPort: 21000, containedHost: "127.0.0.1" },
    { containedPipePort: 21001 },
    { containedPipePort: null },
    { sessionId: "other" },
    { contained: { ...valid.contained, pipeConnected: false } },
    { contained: { ...valid.contained, pipeConnected: undefined, tcpConnected: true } },
    { contained: { ...valid.contained, unauthenticatedStatus: 200 } },
    { contained: { ...valid.contained, authenticatedStatus: 403 } },
    { contained: { ...valid.contained, bootstrapConsumedByWorkload: false } },
  ];
  for (const change of mutations) assert.throws(() => verify({ ...valid, ...change }, context));
});

test("Hermes dashboard tunnel accepts only the live child's declared pipe", async () => {
  const source = interactiveWorkloadSource();
  const start = source.indexOf("const { port, processId } = await dashboardReady;");
  const end = source.indexOf("// The host subsequently deletes", start);
  assert(start > 0 && end > start);
  const code = source
    .slice(start, end)
    .replace(
      'const { startNativeUiTunnel } = await import("./native-ui-tunnel.mts");',
      "const { startNativeUiTunnel } = context;",
    );
  const calls: unknown[] = [];
  const controller = new AbortController();
  const context = {
    dashboardReady: Promise.resolve({ port: 21002, processId: 123 }),
    child: { pid: 123, exitCode: null as number | null, signalCode: null },
    childExit: new Promise(() => {}),
    stopWatcher: { signal: controller.signal },
    required: (name: string) =>
      ({
        NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT: "21002",
        NEMOCLAW_UI_RELAY_ROOT: "owned-ui",
        NEMOCLAW_UI_RELAY_TOKEN: "owned-token",
      })[name],
    startNativeUiTunnel: async (options: unknown) => {
      calls.push(options);
    },
  };
  const execute = new Function(
    "context",
    `return (async () => { const {${Object.keys(context)
      .filter((key) => key !== "startNativeUiTunnel")
      .join(",")}} = context; ${code} })();`,
  );
  await execute(context);
  assert.deepEqual(calls, [
    {
      relayRoot: "owned-ui",
      relayToken: "owned-token",
      uiPort: 21002,
      pipe: true,
      signal: controller.signal,
    },
  ]);
  for (const value of [
    { port: 21003, processId: 123 },
    { port: 21002, processId: 124 },
  ])
    await assert.rejects(execute({ ...context, dashboardReady: Promise.resolve(value) }));
  await assert.rejects(execute({ ...context, child: { ...context.child, exitCode: 0 } }));
  assert.equal(calls.length, 1);
});
