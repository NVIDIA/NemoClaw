// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ensureNativeInference,
  installNativeInference,
  nativeInferenceCatalog,
  serveNativeInference,
  stopNativeInference,
} from "./native-inference.mts";

async function main() {
  const [action, ownership] = process.argv.slice(2);
  if (
    !["catalog", "install", "ensure-ready", "stop", "serve"].includes(action) ||
    (action === "serve" ? ownership !== "--owned-host" : ownership !== undefined) ||
    process.argv.length > 4
  )
    throw new Error("The native inference operation is invalid.");
  const installRoot = process.env.NEMOCLAW_NATIVE_INSTALL_ROOT;
  if (!installRoot) throw new Error("The native inference installation root is unavailable.");
  const controller = new AbortController();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let started = action !== "serve";
  let start!: () => void;
  let rejectStart!: (error: Error) => void;
  const handshake =
    action === "serve"
      ? new Promise<void>((resolve, reject) => {
          start = resolve;
          rejectStart = reject;
        })
      : Promise.resolve();
  let inputBytes = 0;
  input.on("line", (line) => {
    inputBytes += Buffer.byteLength(line, "utf8");
    if (inputBytes > 128) {
      controller.abort();
      rejectStart?.(new Error("The inference control input exceeded its limit."));
      return;
    }
    if (!started && line === "start") {
      started = true;
      start();
      return;
    }
    if (line === "cancel") {
      controller.abort();
      return;
    }
    controller.abort();
    rejectStart?.(new Error("The inference control input is invalid."));
  });
  input.once("close", () => {
    if (action === "serve") {
      controller.abort();
      if (!started) rejectStart(new Error("The native process owner closed before its handshake."));
    }
  });
  const options = {
    installRoot,
    signal: controller.signal,
    onProgress: (event: unknown) => {
      if (action !== "serve") process.stdout.write(JSON.stringify(event) + "\n");
    },
  };
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    if (action === "serve") {
      const timeout = setTimeout(
        () => rejectStart(new Error("The native inference owner handshake timed out.")),
        15_000,
      );
      try {
        await handshake;
      } finally {
        clearTimeout(timeout);
      }
      controller.signal.throwIfAborted();
      await serveNativeInference(options);
      return;
    }
    const result =
      action === "catalog"
        ? await nativeInferenceCatalog(options)
        : action === "install"
          ? await installNativeInference(options)
          : action === "stop"
            ? await stopNativeInference(options)
            : await ensureNativeInference(options).then(
                ({ credential: _credential, ...ready }) => ({
                  schemaVersion: 1,
                  event: "ready",
                  ...ready,
                }),
              );
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    input.close();
    process.stdin.pause();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message.slice(0, 1024) : "Native inference failed.";
    process.stderr.write(JSON.stringify({ schemaVersion: 1, event: "error", message }) + "\n", () =>
      process.exit(1),
    );
  });
}
