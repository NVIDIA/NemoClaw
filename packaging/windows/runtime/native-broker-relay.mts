// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { openNativeUiFileOwner } from "./native-ui-file-owner.mts";
import {
  BROKER_CONNECTION_LIMIT,
  createBrokerRelayPeer,
  validateBrokerRelayIdentity,
  type RelayMeasurements,
} from "./native-broker-relay-protocol.mts";

export async function startNativeBrokerRelay(options: {
  relayRoot: string;
  relayToken: string;
  brokerPort: number;
  launcher: string;
  signal?: AbortSignal;
  measurements?: RelayMeasurements;
}) {
  validateBrokerRelayIdentity(options.relayRoot, options.relayToken);
  if (options.signal?.aborted)
    throw new Error("The native broker transport was stopped before startup.");
  const files = await openNativeUiFileOwner(
    options.launcher,
    options.relayRoot,
    options.measurements,
  );
  let relay: Awaited<ReturnType<typeof createBrokerRelayPeer>> | undefined;
  try {
    const slots = Array.from(
      { length: BROKER_CONNECTION_LIMIT },
      () => `stream-${randomBytes(8).toString("hex")}`,
    );
    for (const slot of slots) await files.mkdir(slot);
    relay = await createBrokerRelayPeer({
      files,
      token: options.relayToken,
      slots,
      side: "host",
      brokerPort: options.brokerPort,
      signal: options.signal,
      measurements: options.measurements,
    });
    await files.write(
      "ready",
      JSON.stringify({
        schemaVersion: 1,
        transport: "guarded-file-tcp",
        token: options.relayToken,
        slots,
      }),
    );
    if (options.signal?.aborted)
      throw new Error("The native broker transport was stopped during startup.");
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await relay?.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      await files.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, "Native broker transport startup and cleanup failed.");
  }
  const active = relay;
  let closing: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const onAbort = () => {
    void close().catch(() => {});
  };
  const close = () => {
    closing ??= (async () => {
      options.signal?.removeEventListener("abort", onAbort);
      const failures: unknown[] = [];
      try {
        await active.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await files.write("shutdown", options.relayToken);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Native broker transport shutdown failed.");
    })();
    return closing;
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return {
    transport: "guarded-file-tcp" as const,
    brokerHost: "127.0.0.1" as const,
    brokerPort: options.brokerPort,
    failure: active.failure,
    diagnostics: active.diagnostics,
    nativePerformance: files.nativePerformance,
    close,
    dispose() {
      disposal ??= (async () => {
        const failures: unknown[] = [];
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await files.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new AggregateError(failures, "Native broker transport disposal failed.");
      })();
      return disposal;
    },
  };
}
