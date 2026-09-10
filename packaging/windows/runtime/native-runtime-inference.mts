// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createConnection } from "node:net";

// A request to the existing native guardian, not a command or process-ID API.
// That guardian starts the existing inference owner outside the agent's job.
export async function startNativeRuntimeInferenceSupervisor(signal?: AbortSignal) {
  const pipe = process.env.NEMOCLAW_RUNTIME_SERVICE_PIPE;
  if (!pipe || !/^\\\\\.\\pipe\\NemoClawRuntime-[a-f0-9]{32}$/u.test(pipe))
    throw new Error("The native inference lifetime owner is unavailable.");
  signal?.throwIfAborted();
  const socket = createConnection(pipe);
  let closed = false;
  let error: Error | undefined;
  let pending: { resolve(value: string): void; reject(reason: Error): void } | undefined;
  let text = "";
  let committed = false;
  let ended = false;
  socket.setNoDelay(true);
  const fail = (reason: string) => {
    error ??= new Error(reason);
    pending?.reject(error);
    pending = undefined;
  };
  socket.on("error", () => fail("The native inference lifetime channel failed."));
  socket.on("close", () => {
    closed = true;
    if (!committed) fail("The native inference lifetime owner closed before admission.");
  });
  socket.on("data", (bytes: Buffer) => {
    if (!pending || bytes.some((byte) => byte > 0x7f) || text.length + bytes.length > 128) {
      fail("The native inference lifetime reply is invalid.");
      socket.destroy();
      return;
    }
    text += bytes.toString("ascii");
    if (!text.endsWith("\n")) return;
    if (text.indexOf("\n") !== text.length - 1) {
      fail("The native inference lifetime reply is invalid.");
      socket.destroy();
      return;
    }
    const reply = text.slice(0, -1);
    text = "";
    const receiver = pending;
    pending = undefined;
    receiver.resolve(reply);
  });
  const request = async (action: "start" | "status" | "commit" | "cancel") => {
    if (closed || error || pending)
      throw error ?? new Error("The native lifetime channel is unavailable.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortRequest = () => {
      fail("The native inference admission was stopped.");
      socket.destroy();
    };
    try {
      if (action !== "cancel") {
        signal?.throwIfAborted();
        signal?.addEventListener("abort", abortRequest, { once: true });
      }
      return await new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(() => {
          fail("The native inference lifetime request timed out.");
          socket.destroy();
        }, 10_000);
        socket.write(`${action}\n`, (failure) => {
          if (failure) fail("The native inference lifetime request could not be sent.");
        });
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortRequest);
    }
  };
  const abort = () => socket.destroy(new Error("The native inference admission was stopped."));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const reply = await request("start");
    const match = /^started ([1-9][0-9]{0,9}) ([a-f0-9]{16})$/u.exec(reply);
    if (!match || Number(match[1]) > 0xffffffff)
      throw new Error("The native inference owner identity is invalid.");
    return {
      pid: Number(match[1]),
      creationTime: match[2],
      get ended() {
        return ended;
      },
      async refresh() {
        const status = await request("status");
        if (status === "running") return;
        if (!/^exited [0-9]{1,10}$/u.test(status))
          throw new Error("The native inference owner status is invalid.");
        ended = true;
      },
      async commit() {
        if ((await request("commit")) !== "committed")
          throw new Error("The native inference owner did not confirm independent admission.");
        committed = true;
        socket.end();
      },
      async cancel() {
        if (committed)
          throw new Error("An admitted shared inference service cannot be cancelled here.");
        try {
          if ((await request("cancel")) !== "cancelled")
            throw new Error("The owned inference start did not confirm cancellation.");
          ended = true;
          committed = true; // The owned failed start is closed; no shared service was admitted.
        } finally {
          socket.destroy();
        }
      },
    };
  } catch (failure) {
    socket.destroy(); // Native owner cancels only its uncommitted newly started child.
    throw failure;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
