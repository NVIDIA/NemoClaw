// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDashboardOrigin, createNativeBrowserOpener } from "./native-runtime-browser.mts";

test("OpenClaw origins and Hermes single root slashes bind the same canonical origin", () => {
  for (const port of [1, 80, 49152, 65535]) {
    const origin = `http://127.0.0.1:${port}`;
    assert.equal(canonicalDashboardOrigin(origin), origin);
    assert.equal(canonicalDashboardOrigin(origin + "/"), origin);
  }
});
test("browser requests refuse path, scheme, credentials, arguments and alternate host authority", () => {
  for (const origin of [
    "https://example.com",
    "http://localhost:80",
    "http://127.0.0.1:0",
    "http://127.0.0.1:080",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:80//",
    "http://127.0.0.1:80/path",
    "http://127.0.0.1:80/?query=1",
    "http://127.0.0.1:80/#fragment",
    "http://127.0.0.1:80/%2f",
    "http://127.0.0.1:80#token",
    "http://127.0.0.1:80?command=run",
    "http://user@127.0.0.1:80",
    "http://127.0.0.1:80\\x",
    "http://127.0.0.1:80\nopen",
    "file:///x",
    "ms-settings:",
  ])
    assert.throws(() => canonicalDashboardOrigin(origin));
});
test("an absent guardian channel fails without an ordinary child-process fallback", async () => {
  const previous = process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE;
  delete process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE;
  try {
    await assert.rejects(
      createNativeBrowserOpener("http://127.0.0.1:12345"),
      /owner is unavailable/,
    );
  } finally {
    if (previous !== undefined) process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE = previous;
  }
});

// Actual named pipes on Windows; no TCP substitute or portable OS claim.
for (const behavior of ["repeated-open", "activation-failed", "malformed-reply"] as const) {
  test(
    "actual browser channel closes after " + behavior,
    { skip: process.platform !== "win32" },
    async () => {
      const { createServer } = await import("node:net");
      const { randomBytes } = await import("node:crypto");
      const pipe = "\\\\.\\pipe\\NemoClawRuntime-" + randomBytes(16).toString("hex");
      const actions: string[] = [];
      let connection: import("node:net").Socket | undefined;
      let disconnected!: () => void;
      const disconnection = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const server = createServer((socket) => {
        connection = socket;
        socket.on("error", () => {});
        socket.once("close", disconnected);
        let buffer = "";
        socket.on("data", (bytes) => {
          buffer += bytes.toString("ascii");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const action = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            actions.push(action);
            if (action.startsWith("bind ")) socket.write("bound\n");
            else if (action === "close") socket.end("closed\n");
            else if (behavior === "malformed-reply") socket.write("invalid reply\n");
            else if (behavior === "activation-failed") socket.write("failed\n");
            else socket.write("opened\n");
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, resolve);
      });
      const previous = process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE;
      process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE = pipe;
      let owner: Awaited<ReturnType<typeof createNativeBrowserOpener>> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        owner = await createNativeBrowserOpener(
          behavior === "repeated-open" ? "http://127.0.0.1:12345/" : "http://127.0.0.1:12345",
        );
        if (behavior === "repeated-open") {
          await owner.open();
          await owner.open();
        } else await assert.rejects(owner.open());
        await owner.close();
        await Promise.race([
          disconnection,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Owned browser pipe remained live.")), 5000);
          }),
        ]);
        assert.equal(actions[0], "bind http://127.0.0.1:12345");
        assert.equal(actions.filter((action) => action.startsWith("bind ")).length, 1);
        if (behavior !== "malformed-reply") assert.equal(actions.at(-1), "close");
      } finally {
        clearTimeout(timer);
        if (owner) await owner.close().catch(() => {});
        connection?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE;
        else process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE = previous;
      }
    },
  );
}
