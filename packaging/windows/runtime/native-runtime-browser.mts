// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createConnection } from "node:net";

export function canonicalDashboardOrigin(value: string) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/u.test(value))
    throw new Error("The native dashboard origin is invalid.");
  const origin = value.endsWith("/") ? value.slice(0, -1) : value;
  const port = Number(origin.slice("http://127.0.0.1:".length));
  if (port > 65535) throw new Error("The native dashboard origin is invalid.");
  return origin;
}

// Only the held SEA can connect to this guardian-created channel. WPF sends an
// Open action through its existing private pipe, never a URL or launch command.
export async function createNativeBrowserOpener(origin: string) {
  origin = canonicalDashboardOrigin(origin);
  const pipe = process.env.NEMOCLAW_RUNTIME_BROWSER_PIPE;
  if (!pipe || !/^\\\\\.\\pipe\\NemoClawRuntime-[a-f0-9]{32}$/u.test(pipe))
    throw new Error("The native browser owner is unavailable.");
  const socket = createConnection(pipe);
  let pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  let failure: Error | undefined;
  let buffer = "";
  let closing: Promise<void> | undefined;
  let closed = false;
  let count = 0;
  const fail = () => {
    failure ??= new Error("The native browser owner closed unexpectedly.");
    pending?.reject(failure);
    pending = undefined;
    socket.destroy();
  };
  socket.on("error", fail);
  socket.on("close", () => {
    if (!closed) fail();
  });
  socket.on("data", (bytes: Buffer) => {
    if (bytes.some((byte) => byte > 127)) {
      fail();
      return;
    }
    buffer += bytes.toString("ascii");
    if (buffer.length > 64 || !/^[a-z\n]*$/u.test(buffer)) {
      fail();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      if (!pending || newline !== buffer.length - 1) {
        fail();
        return;
      }
      const receiver = pending;
      pending = undefined;
      const value = buffer.slice(0, newline);
      buffer = "";
      receiver.resolve(value);
    }
  });
  const request = async (action: string, timeout = 5000) => {
    if (failure) throw failure;
    if (closed || pending) throw new Error("The native browser request is unavailable.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(fail, timeout);
        socket.write(action + "\n", (error) => {
          if (error) fail();
        });
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if ((await request("bind " + origin)) !== "bound")
      throw new Error("The native browser origin was refused.");
  } catch (error) {
    closed = true;
    socket.destroy();
    throw error;
  }
  return {
    async open() {
      if (closing || ++count > 64) throw new Error("The native browser open limit was reached.");
      if ((await request("open")) !== "opened")
        throw new Error("Windows could not open the default browser.");
    },
    close() {
      closing ??= (async () => {
        try {
          if (!failure && (await request("close", 1000)) !== "closed")
            throw new Error("The native browser owner did not close.");
        } finally {
          closed = true;
          socket.destroy();
        }
      })();
      return closing;
    },
  };
}
