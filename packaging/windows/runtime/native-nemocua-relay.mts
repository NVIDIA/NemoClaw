// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import net, { type Socket } from "node:net";
import path from "node:path";
import { openNativeUiFileOwner } from "./native-ui-file-owner.mts";

const STREAM_LIMIT = 32;
const STREAM_BYTES = 8 * 1024 * 1024;
type Stream = {
  directory: string;
  phase: "unused" | "open" | "closed";
  socket?: Socket;
  sequence: number;
  received: number;
  sent: number;
  ended: boolean;
};

export async function startFileTcpTargetRelay(
  relayRoot: string,
  token: string,
  targetPort: number,
  launcher: string,
) {
  const files = await openNativeUiFileOwner(launcher, relayRoot);
  const streams: Stream[] = [];
  const resultDirectory = `stream-${randomBytes(8).toString("hex")}`;
  const resultName = `${resultDirectory}/sandbox-0000000000.bin`;
  let closed = false;
  let failure: Error | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const writes = new Set<Promise<void>>();
  const recordFailure = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error("The guarded NemoCUA relay failed.");
    rejectFailure(failure);
    for (const stream of streams) stream.socket?.destroy();
  };
  const queueWrite = (operation: Promise<void>) => {
    const pending = operation.catch(recordFailure).finally(() => writes.delete(pending));
    writes.add(pending);
  };
  try {
    for (let index = 0; index < STREAM_LIMIT; index++) {
      const directory = `stream-${randomBytes(8).toString("hex")}`;
      await files.mkdir(directory);
      streams.push({ directory, phase: "unused", sequence: 0, received: 0, sent: 0, ended: false });
    }
    await files.mkdir(resultDirectory);
    await files.write(
      "ready",
      JSON.stringify({
        schemaVersion: 1,
        token,
        streams: streams.map((stream) => stream.directory),
        result: resultName,
      }),
    );
  } catch (error) {
    await files.close();
    throw error;
  }
  let polling = false;
  let pollTask = Promise.resolve();
  const poll = setInterval(() => {
    if (closed || polling || failure) return;
    polling = true;
    pollTask = (async () => {
      for (const stream of streams) {
        if (closed || failure) break;
        if (stream.phase === "unused") {
          const marker = await files.read(`${stream.directory}/open`);
          if (marker === null) continue;
          if (marker.toString("utf8") !== token)
            throw new Error("The NemoCUA relay stream identity is invalid.");
          stream.phase = "open";
          const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
          stream.socket = socket;
          socket.once("error", recordFailure);
          socket.on("data", (chunk: Buffer) => {
            socket.pause();
            stream.sent += chunk.length;
            if (stream.sent > STREAM_BYTES) {
              recordFailure(new Error("The NemoCUA relay response exceeded its bound."));
              return;
            }
            queueWrite(
              files
                .write(
                  `${stream.directory}/host-${String(stream.sequence++).padStart(10, "0")}.bin`,
                  chunk,
                )
                .then(() => {
                  socket.resume();
                }),
            );
          });
          socket.once("close", () => {
            stream.phase = "closed";
            if (!closed && !failure)
              queueWrite(files.write(`${stream.directory}/host-close`, Buffer.alloc(0)));
          });
        }
        if (stream.phase !== "open" || !stream.socket) continue;
        for (const name of (await files.list(stream.directory))
          .filter((name) => /^sandbox-[0-9]{10}\.bin$/u.test(name))
          .sort()) {
          if (closed || failure) break;
          const data = await files.read(`${stream.directory}/${name}`);
          if (data === null) continue;
          stream.received += data.length;
          if (stream.received > STREAM_BYTES)
            throw new Error("The NemoCUA relay request exceeded its bound.");
          if (!stream.socket.write(data)) await waitForDrain(stream.socket);
          await files.unlink(`${stream.directory}/${name}`);
        }
        if (!stream.ended && (await files.read(`${stream.directory}/sandbox-close`)) !== null) {
          stream.ended = true;
          stream.socket.end();
        }
      }
    })()
      .catch(recordFailure)
      .finally(() => {
        polling = false;
      });
  }, 10);
  let disposal: Promise<void> | undefined;
  return {
    failure: failed,
    resultPath: path.join(relayRoot, resultDirectory, "sandbox-0000000000.bin"),
    streamLimit: STREAM_LIMIT,
    async readResult() {
      return await files.read(resultName);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      for (const stream of streams) stream.socket?.destroy();
      await pollTask;
      await Promise.all(writes);
      await files.write("shutdown", token).catch(recordFailure);
    },
    async dispose() {
      disposal ??= (async () => {
        await files.close();
        if (failure) throw failure;
      })();
      return await disposal;
    },
  };
}

function waitForDrain(socket: Socket) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeListener("drain", drained);
      socket.removeListener("close", ended);
      if (error) reject(error);
      else resolve();
    };
    const drained = () => finish();
    const ended = () => finish(new Error("The NemoCUA relay connection closed during a request."));
    const timer = setTimeout(() => finish(new Error("The NemoCUA relay request stalled.")), 15_000);
    socket.once("drain", drained);
    socket.once("close", ended);
  });
}

export function relayWorkloadSource() {
  return String.raw`import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { join } from "node:path";

const required = (name) => { const value = process.env[name]; if (!value) throw new Error(name + " is required"); return value; };
const relayRoot = required("NEMOCLAW_NEMOCUA_RELAY_ROOT");
const relayToken = required("NEMOCLAW_NEMOCUA_RELAY_TOKEN");
const resultPath = required("NEMOCLAW_NEMOCUA_RESULT");
const pool = JSON.parse(fs.readFileSync(join(relayRoot, "ready"), "utf8"));
if (pool.schemaVersion !== 1 || pool.token !== relayToken || !Array.isArray(pool.streams) || pool.streams.length !== 32 ||
    new Set(pool.streams).size !== 32 || pool.streams.some((name) => !/^stream-[0-9a-f]{16}$/.test(name)) ||
    !/^stream-[0-9a-f]{16}\/sandbox-0000000000.bin$/.test(pool.result) || join(relayRoot, ...pool.result.split("/")) !== resultPath)
  throw new Error("The host-owned NemoCUA relay pool is invalid.");
const publish = (file, content) => {
  const handle = fs.openSync(file, "wx");
  try { fs.writeFileSync(handle, content); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
};
const streams = new Map();
let nextSlot = 0;
let failure;
let child;
let poll;
const stop = (error) => {
  failure ??= error;
  if (poll) clearInterval(poll);
  for (const stream of streams.values()) stream.socket.destroy();
  if (child) child.kill();
};
const server = net.createServer((socket) => {
  if (nextSlot >= pool.streams.length) { socket.destroy(); stop(new Error("The bounded NemoCUA relay exhausted its 32 connection slots.")); return; }
  const slot = pool.streams[nextSlot++];
  const root = join(relayRoot, slot);
  const state = { root, sequence: 0, bytes: 0, socket, closing: false };
  streams.set(slot, state);
  try { publish(join(root, "open"), relayToken); } catch (error) { stop(error); return; }
  socket.on("data", (chunk) => {
    state.bytes += chunk.length;
    if (state.bytes > 8 * 1024 * 1024) { stop(new Error("The bounded NemoCUA request is too large.")); return; }
    try { publish(join(root, "sandbox-" + String(state.sequence++).padStart(10, "0") + ".bin"), chunk); } catch (error) { stop(error); }
  });
  socket.once("error", stop);
  socket.once("close", () => {
    streams.delete(slot);
    if (!state.closing && !failure) try { publish(join(root, "sandbox-close"), Buffer.alloc(0)); } catch (error) { stop(error); }
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
poll = setInterval(() => {
  try {
    const shutdown = join(relayRoot, "shutdown");
    if (fs.existsSync(shutdown) && fs.readFileSync(shutdown, "utf8") === relayToken) { stop(new Error("The NemoCUA session was stopped.")); return; }
    for (const stream of streams.values()) {
      for (const name of fs.readdirSync(stream.root).filter((name) => /^host-[0-9]{10}[.]bin$/.test(name)).sort()) {
        const file = join(stream.root, name);
        stream.socket.write(fs.readFileSync(file)); fs.unlinkSync(file);
      }
      if (!stream.closing && fs.existsSync(join(stream.root, "host-close"))) { stream.closing = true; stream.socket.end(); }
    }
  } catch (error) { stop(error); }
}, 10);
let code = 1;
try {
  child = spawn(required("NEMOCLAW_NEMOCUA_PYTHON"), [required("NEMOCLAW_NEMOCUA_HARNESS"), required("NEMOCLAW_NEMOCUA_MODE"),
    "--bridge-url", "http://127.0.0.1:" + server.address().port, "--result-path", resultPath],
    { env: process.env, stdio: "inherit", windowsHide: true });
  code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
} finally {
  clearInterval(poll);
  for (const stream of streams.values()) { stream.closing = true; stream.socket.destroy(); }
  await new Promise((resolve) => server.close(resolve));
}
if (failure) throw failure;
process.exitCode = code;
`;
}
