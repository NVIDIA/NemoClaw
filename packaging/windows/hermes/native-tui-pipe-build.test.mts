// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import {
  adaptNativeTuiPipeFile,
  compileNativeTuiPipe,
  dashboardSocketHelper,
  gatewaySourceSha256,
} from "./native-tui-pipe-build.mts";

const dependencies = process.env.NEMOCLAW_HERMES_PYTHON_TEST_DEPS;
const pinned = {
  skip: dependencies ? false : "Pinned Hermes transport fixtures are not configured",
};
const helper = ts.transpileModule(dashboardSocketHelper, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const pipeName = String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-8123`;

function factory(overrides = {}) {
  const calls: unknown[] = [];
  const fakeProcess = {
    platform: "win32",
    env: { NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT: "8123" },
    exitCode: undefined,
  };
  class Agent {
    constructor(options) {
      calls.push(options);
    }
    async destroy() {
      calls.push("destroy");
    }
  }
  class Socket extends EventTarget {
    url: string;
    options: unknown;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      calls.push(url);
    }
  }
  const create = vm.runInNewContext(helper + "\n__nemoDashboardSocket", {
    URL,
    process: fakeProcess,
    console,
    __nemoDashboardAgent: Agent,
    UndiciWebSocket: Socket,
    ...overrides,
  });
  return { create, calls, fakeProcess };
}

test("inactive adapter preserves the original WebSocket constructor", () => {
  const { create, calls } = factory({ process: { env: {}, platform: "linux" } });
  const socket = create(
    "wss://example.invalid/path",
    class {
      url: string;
      constructor(url) {
        this.url = url;
      }
    },
  );
  assert.equal(socket.url, "wss://example.invalid/path");
  assert.deepEqual(calls, []);
});

test("declared dashboard routes retain the exact URL and retire their dispatcher", async () => {
  for (const target of [
    "/api/ws?internal=test-token",
    "/api/pub?internal=test-token&channel=events",
  ]) {
    const { create, calls } = factory();
    const url = "ws://127.0.0.1:8123" + target;
    const socket = create(
      url,
      class {
        constructor() {
          throw new Error("TCP fallback");
        }
      },
    );
    assert.equal(socket.url, url);
    assert.equal(calls[0].connect.socketPath, pipeName);
    socket.dispatchEvent(new Event("close"));
    socket.dispatchEvent(new Event("error"));
    socket.dispatchEvent(new Event("close"));
    await Promise.resolve();
    assert.equal(calls.filter((value) => value === "destroy").length, 1);
  }
});

test("invalid declarations fail before constructing a dispatcher", () => {
  for (const declared of ["", "0", "08123", "65536", "-1", " 8123", "8123/path"]) {
    const { create, calls } = factory({
      process: { platform: "win32", env: { NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT: declared } },
    });
    assert.throws(() => create("ws://127.0.0.1:8123/api/ws"), /declaration/u);
    assert.deepEqual(calls, []);
  }
  const { create } = factory({
    process: { platform: "linux", env: { NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT: "8123" } },
  });
  assert.throws(() => create("ws://127.0.0.1:8123/api/ws"), /declaration/u);
});

test("foreign hosts, ports, credentials, TLS and unrelated routes cannot fall back to TCP", () => {
  const { create, calls } = factory();
  for (const url of [
    "ws://foreign.invalid:8123/api/ws",
    "ws://localhost:8123/api/ws",
    "ws://127.0.0.1:8124/api/ws",
    "wss://127.0.0.1:8123/api/ws",
    "http://127.0.0.1:8123/api/ws",
    "ws://user:secret@127.0.0.1:8123/api/ws",
    "ws://127.0.0.1:8123/api/ws#x",
    "ws://127.0.0.1:8123/admin",
  ]) {
    assert.throws(() => create(url), /declared endpoint/u);
  }
  assert.deepEqual(calls, []);
});

test("constructor failure destroys the owned dispatcher", async () => {
  const { create, calls } = factory({
    UndiciWebSocket: class {
      constructor() {
        throw new Error("connect failed");
      }
    },
  });
  assert.throws(() => create("ws://127.0.0.1:8123/api/ws"), /connect failed/u);
  await Promise.resolve();
  assert.equal(calls.at(-1), "destroy");
});

test("dispatcher cleanup failure is visible without disclosing the URL credential", async () => {
  const errors: string[] = [];
  const context = factory({
    __nemoDashboardAgent: class {
      async destroy() {
        throw new Error("private transport details");
      }
    },
    console: { error: (message) => errors.push(message) },
  });
  const socket = context.create("ws://127.0.0.1:8123/api/ws?internal=secret");
  socket.dispatchEvent(new Event("close"));
  await Promise.resolve();
  assert.equal(context.fakeProcess.exitCode, 1);
  assert.deepEqual(errors, ["The Hermes dashboard connection did not close cleanly."]);
});

test(
  "compiler changes exactly the two pinned upstream call sites and rejects drift",
  pinned,
  () => {
    const original = fs.readFileSync(path.join(dependencies!, "gatewayClient.ts"), "utf8");
    const adapted = compileNativeTuiPipe(original, ts);
    assert.equal(
      adapted,
      'import { Agent as __nemoDashboardAgent } from "undici";\n' +
        dashboardSocketHelper +
        original
          .replace(
            "new WebSocketCtor(this.sidecarUrl)",
            "__nemoDashboardSocket(this.sidecarUrl, WebSocketCtor)",
          )
          .replace(
            "new WebSocketCtor(attachUrl)",
            "__nemoDashboardSocket(attachUrl, WebSocketCtor)",
          ),
    );
    assert.throws(() => compileNativeTuiPipe(original + "\n", ts), /pinned/u);
    assert.throws(() => compileNativeTuiPipe(adapted, ts), /pinned/u);
  },
);

for (const phase of ["before-validation", "before-write", "after-write"] as const) {
  test(`build adapter refuses a replaced path ${phase} and closes its held file`, pinned, (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tui-race-")));
    const target = path.join(root, "gatewayClient.ts");
    const displaced = path.join(root, "held.ts");
    const original = fs.readFileSync(path.join(dependencies!, "gatewayClient.ts"), "utf8");
    fs.writeFileSync(target, original);
    const lstat = fs.lstatSync;
    const close = fs.closeSync;
    let checks = 0;
    const selectedCheck = { "before-validation": 1, "before-write": 2, "after-write": 3 }[phase];
    try {
      const closing = t.mock.method(fs, "closeSync", close);
      t.mock.method(fs, "lstatSync", (file: fs.PathLike) => {
        if (file === target && ++checks === selectedCheck) {
          fs.renameSync(target, displaced);
          fs.writeFileSync(target, "replacement must not be modified");
        }
        return lstat(file);
      });
      assert.throws(() => adaptNativeTuiPipeFile(target, ts), /ordinary owned build input/u);
      assert.equal(closing.mock.callCount(), 1);
      assert.equal(fs.readFileSync(target, "utf8"), "replacement must not be modified");
      assert.equal(
        fs.readFileSync(displaced, "utf8"),
        phase === "after-write" ? compileNativeTuiPipe(original, ts) : original,
      );
    } finally {
      t.mock.restoreAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test(
  "build adapter rejects linked, oversized and changed inputs without rewriting them",
  pinned,
  (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tui-input-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "gatewayClient.ts");
    for (const original of ["changed source", "x".repeat(1024 * 1024 + 1)]) {
      fs.writeFileSync(target, original);
      assert.throws(() => adaptNativeTuiPipeFile(target, ts), /pinned|limit/u);
      assert.equal(fs.readFileSync(target, "utf8"), original);
    }
    fs.writeFileSync(target, fs.readFileSync(path.join(dependencies!, "gatewayClient.ts")));
    const linked = path.join(root, "linked.ts");
    fs.linkSync(target, linked);
    assert.throws(() => adaptNativeTuiPipeFile(target, ts), /ordinary owned build input/u);
    assert.equal(fs.readFileSync(linked, "utf8"), fs.readFileSync(target, "utf8"));
  },
);

test(
  "build adapter CLI records the actual changed file and refuses repeated application",
  pinned,
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tui-build-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "ui-tui", "src"), { recursive: true });
    fs.copyFileSync(
      path.join(dependencies!, "gatewayClient.ts"),
      path.join(root, "ui-tui", "src", "gatewayClient.ts"),
    );
    fs.symlinkSync(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const command = [fileURLToPath(new URL("./native-tui-pipe-build.mts", import.meta.url)), root];
    const result = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sourceSha256, gatewaySourceSha256);
    assert.equal(receipt.callSites, 2);
    assert.equal(receipt.nativeExecutionQualified, false);
    assert.notEqual(receipt.adaptedSha256, receipt.sourceSha256);
    const retry = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 10_000 });
    assert.notEqual(retry.status, 0);
  },
);

for (const mode of ["accepted", "denied", "redirect"] as const) {
  const accepted = mode === "accepted";
  test(
    `pinned Undici 6.28.0 WebSocket over a Unix test socket: ${mode}`,
    {
      skip: process.platform === "win32" ? "Unix socket control runs in isolated WSL" : pinned.skip,
      timeout: 10_000,
    },
    async (t) => {
      const require = createRequire(import.meta.url);
      const { WebSocketServer } = createRequire(
        import.meta.resolve("@earendil-works/pi-coding-agent"),
      )("ws");
      const undici = require(path.join(dependencies!, "undici-6.28.0"));
      assert.equal(
        require(path.join(dependencies!, "undici-6.28.0/package.json")).version,
        "6.28.0",
      );
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ws-"));
      const endpoint = path.join(root, "test.sock");
      const server = http.createServer();
      const sockets = new WebSocketServer({ noServer: true });
      const requests: string[] = [];
      const retired: Promise<void>[] = [];
      t.after(async () => {
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all(retired);
        fs.rmSync(root, { recursive: true, force: true });
      });
      server.on("upgrade", (request, socket, head) => {
        requests.push(request.url!);
        assert.equal(request.headers.host, "127.0.0.1:8123");
        if (mode === "redirect") {
          socket.end(
            "HTTP/1.1 302 Found\r\nLocation: http://foreign.invalid:8123/api/ws\r\nContent-Length: 0\r\n\r\n",
          );
          return;
        }
        if (!accepted) {
          socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          client.on("message", (data) => client.send(data.toString()));
        });
      });
      server.listen(endpoint);
      await once(server, "listening");
      class LocalTestAgent extends undici.Agent {
        constructor(options) {
          assert.equal(options.connect.socketPath, pipeName);
          super({ ...options, connect: { socketPath: endpoint } });
        }
        destroy(...args) {
          const closing = super.destroy(...args);
          if (closing && typeof closing.then === "function") retired.push(closing);
          return closing;
        }
      }
      const { create } = factory({
        __nemoDashboardAgent: LocalTestAgent,
        UndiciWebSocket: undici.WebSocket,
      });
      const socket = create("ws://127.0.0.1:8123/api/ws?internal=fixture");
      const closed = new Promise((resolve) =>
        socket.addEventListener(accepted ? "close" : "error", resolve, { once: true }),
      );
      if (accepted) {
        await once(socket, "open");
        const message = once(socket, "message");
        socket.send('{"method":"heartbeat"}');
        assert.equal((await message)[0].data, '{"method":"heartbeat"}');
        socket.close(1000);
      }
      await closed;
      assert.deepEqual(requests, ["/api/ws?internal=fixture"]);
      assert.equal(retired.length, 1);
    },
  );
}
