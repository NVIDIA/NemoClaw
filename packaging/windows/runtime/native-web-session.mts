// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { join } from "node:path";

function validateAddress(url: string) {
  const address = new URL(url);
  if (
    address.protocol !== "http:" ||
    address.hostname !== "127.0.0.1" ||
    address.username ||
    address.password ||
    url.length > 1600
  )
    throw new Error("The native web session address is invalid.");
}

export async function openNativeWebSession(
  installRoot: string,
  agent: "openclaw" | "hermes",
  url?: string,
  options: { qualification?: boolean } = {},
) {
  if (url !== undefined) validateAddress(url);
  const child = spawn(
    join(installRoot, "native-ui", "NemoClaw.Bootstrapper.exe"),
    ["--web-session", "--agent", agent],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  child.stdin.on("error", () => {});
  let ended = false;
  let completing = false;
  let stopRequested = false;
  const cancellation = new AbortController();
  const closed = new Promise<number>((resolve) =>
    child.once("close", (code) => {
      ended = true;
      resolve(code ?? 1);
    }),
  );
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  let bytes = 0;
  let pending = "";
  let sawReady = false;
  let failure: Error | undefined;
  const reject = () => {
    failure ??= new Error("The native web session control stopped unexpectedly.");
    fail(failure);
    stop();
    cancellation.abort(failure);
  };
  child.once("error", reject);
  child.once("close", () => {
    if (!completing) reject();
    else stop();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256) {
      reject();
      child.kill();
      return;
    }
    pending += chunk.toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        if (record.kind === "ready" && !sawReady) {
          sawReady = true;
          ready();
        } else if (record.kind === "stop" && sawReady) {
          stopRequested = true;
          cancellation.abort(new Error("The native Web UI session was stopped."));
          stop();
        } else reject();
      } catch {
        reject();
      }
    }
  });
  const timeout = setTimeout(reject, 15_000);
  child.stdin.write(
    JSON.stringify({
      schemaVersion: 1,
      agent,
      url,
      qualification: options.qualification === true,
    }) + "\n",
  );
  try {
    await readiness;
  } catch (error) {
    child.stdin.end();
    child.kill();
    await closed;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return {
    // Resolve on Stop or unexpected UI exit; the owner must always clean up.
    stopped,
    signal: cancellation.signal,
    assertRunning() {
      if (failure || ended || stopRequested)
        throw new Error("The native Web UI session was stopped.");
    },
    ready(address: string) {
      if (failure || ended || stopRequested)
        throw new Error("The native Web UI session was stopped.");
      validateAddress(address);
      child.stdin.write(JSON.stringify({ kind: "ready", url: address }) + "\n");
    },
    progress(stage: "inference" | "runtime" | "sandbox" | "dashboard") {
      if (!ended && !completing)
        child.stdin.write(JSON.stringify({ kind: "progress", stage }) + "\n");
    },
    async complete(cleanupSucceeded: boolean) {
      completing = true;
      if (!ended)
        child.stdin.end(JSON.stringify({ kind: cleanupSucceeded ? "stopped" : "failed" }) + "\n");
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
      if (failure) throw failure;
    },
  };
}
