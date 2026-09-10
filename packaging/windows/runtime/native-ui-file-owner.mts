// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

const MAX_CHUNK = 1024 * 1024;
const MAX_RESPONSE = 4 * Math.ceil(MAX_CHUNK / 3) + 128;
const RELATIVE =
  /^(?:ready|shutdown|stream-[0-9a-f]{16}\/(?:open|host-close|sandbox-close|(?:host|sandbox)-[0-9]{10}\.bin))$/u;
const STREAM = /^stream-[0-9a-f]{16}$/u;

export async function openNativeUiFileOwner(launcher: string, root: string) {
  const child = spawn(launcher, ["--native-ui-file-owner", root], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  let failure: Error | undefined;
  let buffer = "";
  let active: {
    resolve(value: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let started = false;
  let closing = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = () => {
    failure ??= new Error(
      "The native Web UI file boundary stopped or rejected an unsafe operation.",
    );
    readyReject(failure);
    if (active) {
      clearTimeout(active.timer);
      active.reject(failure);
      active = null;
    }
    child.kill();
  };
  child.stdin.once("error", fail);
  child.stdout.once("error", fail);
  child.stderr.once("error", fail);
  child.once("error", fail);
  const completion = new Promise<number>((resolve) =>
    child.once("close", (code) => {
      if (!closing || code !== 0) fail();
      resolve(code ?? 1);
    }),
  );
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    if (chunk.some((value) => value > 127)) {
      fail();
      return;
    }
    buffer += chunk.toString("ascii");
    if (buffer.length > MAX_RESPONSE) {
      fail();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!started) {
        if (line !== "READY") {
          fail();
          return;
        }
        started = true;
        readyResolve();
      } else if (active && (line === "OK" || line === "MISS" || line.startsWith("OK\t"))) {
        const pending = active;
        active = null;
        clearTimeout(pending.timer);
        pending.resolve(line);
      } else {
        fail();
        return;
      }
    }
  });
  const startupTimer = setTimeout(fail, 15_000);
  try {
    await ready;
  } catch (error) {
    await completion;
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  let tail = Promise.resolve();
  let queued = 0;
  const request = (line: string): Promise<string> => {
    if (failure) return Promise.reject(failure);
    if (closing || queued >= 256) {
      fail();
      return Promise.reject(failure);
    }
    queued++;
    const result = tail
      .then(
        () =>
          new Promise<string>((resolve, reject) => {
            if (failure) {
              reject(failure);
              return;
            }
            active = { resolve, reject, timer: setTimeout(fail, 15_000) };
            if (line === "close") closing = true;
            child.stdin.write(line + "\n");
          }),
      )
      .finally(() => {
        queued--;
      });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const relative = (value: string) => {
    if (!RELATIVE.test(value)) throw new Error("The native UI file name is invalid.");
    return value;
  };
  const stream = (value: string) => {
    if (!STREAM.test(value)) throw new Error("The native UI stream name is invalid.");
    return value;
  };
  return {
    async mkdir(value: string) {
      if ((await request(`mkdir\t${stream(value)}`)) !== "OK")
        throw new Error("The native UI stream could not open.");
    },
    async read(value: string): Promise<Buffer | null> {
      const result = await request(`read\t${relative(value)}`);
      if (result === "MISS") return null;
      if (!result.startsWith("OK\t")) throw new Error("The native UI file reply is invalid.");
      const encoded = result.slice(3);
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > MAX_CHUNK || decoded.toString("base64") !== encoded)
        throw new Error("The native UI file reply is invalid.");
      return decoded;
    },
    async write(value: string, content: string | Buffer) {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      if (bytes.length > MAX_CHUNK) throw new Error("The native UI data frame exceeds its limit.");
      if ((await request(`write\t${relative(value)}\t${bytes.toString("base64")}`)) !== "OK")
        throw new Error("The native UI frame could not be written.");
    },
    async list(value: string) {
      const result = await request(`list\t${stream(value)}`);
      if (!result.startsWith("OK\t")) throw new Error("The native UI stream list is invalid.");
      const names = result.slice(3) ? result.slice(3).split(",") : [];
      if (names.length > 4096 || names.some((name) => !RELATIVE.test(`${value}/${name}`)))
        throw new Error("The native UI stream list is invalid.");
      return names;
    },
    async unlink(value: string) {
      if ((await request(`unlink\t${relative(value)}`)) !== "OK")
        throw new Error("The native UI frame could not be removed.");
    },
    async release(value: string) {
      if ((await request(`release\t${stream(value)}`)) !== "OK")
        throw new Error("The native UI stream could not close.");
    },
    async close() {
      if (closing) return;
      try {
        const result = await request("close");
        if (result !== "OK") throw new Error("The native UI file owner could not close.");
        closing = true;
        child.stdin.end();
        const timeout = setTimeout(fail, 5000);
        const code = await completion;
        clearTimeout(timeout);
        if (code !== 0 || failure)
          throw failure ?? new Error("The native UI file owner cleanup failed.");
      } catch (error) {
        closing = true;
        fail();
        await completion;
        throw error;
      }
    },
  };
}
