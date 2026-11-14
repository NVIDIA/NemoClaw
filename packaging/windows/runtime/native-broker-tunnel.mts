// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  BROKER_FRAME_BYTES,
  createBrokerRelayPeer,
  validateBrokerRelayIdentity,
  type BrokerRelayFiles,
  type RelayMeasurements,
} from "./native-broker-relay-protocol.mts";

const RELATIVE =
  /^(?:ready|shutdown|stream-[0-9a-f]{16}\/(?:open|host-close|sandbox-close|(?:host|sandbox)-[0-9]{10}\.bin))$/u;
const DIRECTORY = /^stream-[0-9a-f]{16}$/u;

// This adapter runs with the contained process's own authority. Host-side I/O
// always uses the native file owner; this is not a portable substitute for it.
export function containedBrokerRelayFiles(
  root: string,
  measurements?: RelayMeasurements,
): BrokerRelayFiles {
  const file = (name: string) => {
    if (!RELATIVE.test(name)) throw new Error("The contained broker file name is invalid.");
    return path.join(root, ...name.split("/"));
  };
  return {
    async read(name) {
      const limit = name === "ready" ? 65536 : BROKER_FRAME_BYTES + 32;
      let descriptor: number;
      try {
        descriptor = fs.openSync(file(name), "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > limit)
          throw new Error("The contained broker frame exceeds its bound.");
        const bytes = Buffer.allocUnsafe(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = fs.readSync(descriptor, bytes, count, bytes.length - count, null);
          if (!read) break;
          count += read;
        }
        if (count > limit || count !== stat.size)
          throw new Error("The contained broker frame changed while reading.");
        return bytes.subarray(0, count);
      } finally {
        fs.closeSync(descriptor);
      }
    },
    async write(name, content) {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      if (bytes.length > BROKER_FRAME_BYTES + 32)
        throw new Error("The contained broker frame exceeds its bound.");
      const descriptor = fs.openSync(file(name), "wx");
      try {
        fs.writeFileSync(descriptor, bytes);
        const started = measurements?.start();
        let flushed = false;
        try {
          fs.fsyncSync(descriptor);
          flushed = true;
        } finally {
          if (started !== undefined)
            measurements!.finish("flush", started, flushed ? "success" : "failure");
        }
      } finally {
        fs.closeSync(descriptor);
      }
    },
    async unlink(name) {
      const target = file(name);
      const deadline = performance.now() + 250;
      for (;;) {
        try {
          fs.unlinkSync(target);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return;
          // The native publisher briefly denies deletion while its flushed
          // frame handle closes. Retry only this idempotent owned-file unlink.
          if (
            process.platform !== "win32" ||
            !["EACCES", "EPERM", "EBUSY"].includes(code ?? "") ||
            performance.now() >= deadline
          )
            throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      }
    },
    async list(name) {
      if (!DIRECTORY.test(name)) throw new Error("The contained broker stream name is invalid.");
      const entries = fs.readdirSync(path.join(root, name));
      const result = entries.filter(
        (entry) => !/^\.native-ui-write-[0-9]+-[0-9a-f]{16}\.tmp$/u.test(entry),
      );
      if (result.length > 64 || result.some((entry) => !RELATIVE.test(`${name}/${entry}`)))
        throw new Error("The contained broker stream inventory is invalid.");
      return result;
    },
  };
}

export async function startNativeBrokerTunnel(options: {
  relayRoot: string;
  relayToken: string;
  signal?: AbortSignal;
  measurements?: RelayMeasurements;
}) {
  validateBrokerRelayIdentity(options.relayRoot, options.relayToken);
  if (options.signal?.aborted)
    throw new Error("The native broker transport was stopped before startup.");
  const files = containedBrokerRelayFiles(options.relayRoot, options.measurements);
  const bytes = await files.read("ready");
  if (bytes === null) throw new Error("The host broker transport is not ready.");
  let ready: { schemaVersion?: unknown; transport?: unknown; token?: unknown; slots?: unknown };
  try {
    ready = JSON.parse(bytes.toString("utf8")) as typeof ready;
  } catch {
    throw new Error("The host broker transport readiness is invalid.");
  }
  if (
    ready.schemaVersion !== 1 ||
    ready.transport !== "guarded-file-tcp" ||
    ready.token !== options.relayToken ||
    !Array.isArray(ready.slots) ||
    ready.slots.some((slot) => typeof slot !== "string")
  )
    throw new Error("The host broker transport readiness is invalid.");
  const peer = await createBrokerRelayPeer({
    files,
    token: options.relayToken,
    slots: ready.slots as string[],
    side: "sandbox",
    signal: options.signal,
    measurements: options.measurements,
  });
  if (peer.port === null) {
    await peer.close();
    throw new Error("The contained broker listener did not bind.");
  }
  return {
    ...peer,
    transport: "guarded-file-tcp" as const,
    host: "127.0.0.1" as const,
    port: peer.port,
  };
}
