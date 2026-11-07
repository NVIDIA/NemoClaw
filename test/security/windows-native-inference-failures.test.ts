// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNativeInferenceBroker } from "../../packaging/windows/runtime/native-inference-broker.mts";
import {
  finishNativeInferenceCleanup,
  finishNativeInferencePreparation,
  waitForNativeInferenceShutdown,
} from "../../packaging/windows/runtime/native-inference.mts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function cleanupFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-inference-cleanup-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, "runtime");
  const record = path.join(directory, "owner.json");
  const key = path.join(directory, "key-fixture");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "runtime.dll"), "owned runtime");
  fs.writeFileSync(record, "signed owner fixture");
  fs.writeFileSync(key, "private fixture key");
  const lease = fs.openSync(path.join(directory, "lease"), "wx");
  let released = false;
  cleanups.push(() => {
    try {
      fs.closeSync(lease);
    } catch {
      /* already released by the production cleanup */
    }
  });
  return {
    runtime,
    record,
    key,
    released: () => released,
    actions: {
      closeListener: async () => {},
      stopServer: async () => {},
      serverStopped: () => true,
      removeRuntime: async () => {
        await fs.promises.rm(runtime, { recursive: true });
      },
      removeRecord: async () => {
        await fs.promises.unlink(record);
      },
      deleteCredential: async () => {
        await fs.promises.unlink(key);
      },
      releaseState: async () => {
        fs.closeSync(lease);
        released = true;
      },
    },
  };
}

async function listen(server: Server) {
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
}

async function broker(upstreamPort: number) {
  const owner = await startNativeInferenceBroker(
    { endpoint: `http://127.0.0.1:${upstreamPort}/v1`, inference: "local" },
    "private-provider-key",
    "agent-broker-token",
    { options: {}, environment: {} },
  );
  cleanups.push(async () => {
    owner.server.closeAllConnections();
    await new Promise<void>((resolve) => owner.server.close(() => resolve()));
  });
  return owner;
}

describe("native inference failure cleanup", () => {
  it("always releases preparation state and preserves the primary failure after runtime removal fails", async () => {
    const f = cleanupFixture();
    const primary = new Error("preparation failed");
    const removal = new Error("runtime removal failed");
    const failure = await finishNativeInferencePreparation(primary, {
      removeRuntime: async () => {
        throw removal;
      },
      releaseState: f.actions.releaseState,
    });
    expect((failure as AggregateError).errors).toEqual([primary, removal]);
    expect(f.released()).toBe(true);
    expect(fs.readFileSync(f.record, "utf8")).toBe("signed owner fixture");
    expect(fs.readFileSync(f.key, "utf8")).toBe("private fixture key");
  });

  it("removes runtime, record and key and releases a stopped server's lease after a wait timeout", async () => {
    const f = cleanupFixture();
    const failure = await finishNativeInferenceCleanup(undefined, {
      ...f.actions,
      stopServer: () => waitForNativeInferenceShutdown(new Promise(() => {}), 10),
    });
    expect(failure?.message).toContain("CUDA server did not stop");
    expect(fs.existsSync(f.runtime)).toBe(false);
    expect(fs.existsSync(f.record)).toBe(false);
    expect(fs.existsSync(f.key)).toBe(false);
    expect(f.released()).toBe(true);
  });

  it("preserves the original startup error and diagnostic key while aggregating later cleanup failures", async () => {
    const f = cleanupFixture();
    const primary = new Error("model readiness failed");
    const cleanupFailure = new Error("runtime removal failed");
    const failure = await finishNativeInferenceCleanup(primary, {
      ...f.actions,
      removeRuntime: async () => {
        throw cleanupFailure;
      },
    });
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanupFailure]);
    expect(fs.readFileSync(f.record, "utf8")).toBe("signed owner fixture");
    expect(fs.readFileSync(f.key, "utf8")).toBe("private fixture key");
    expect(f.released()).toBe(true);
  });

  it("retains state ownership for a still-live CUDA process while completing the other cleanup", async () => {
    const f = cleanupFixture();
    const failure = await finishNativeInferenceCleanup(undefined, {
      ...f.actions,
      stopServer: () => waitForNativeInferenceShutdown(new Promise(() => {}), 10),
      serverStopped: () => false,
    });
    expect(failure?.message).toContain("CUDA server did not stop");
    expect(failure?.message).toContain("lease is retained");
    expect(fs.existsSync(f.runtime)).toBe(false);
    expect(fs.existsSync(f.record)).toBe(false);
    expect(fs.existsSync(f.key)).toBe(false);
    expect(f.released()).toBe(false);
  });

  it("still deletes the key and releases the lease when record removal fails", async () => {
    const f = cleanupFixture();
    const failure = await finishNativeInferenceCleanup(undefined, {
      ...f.actions,
      removeRecord: async () => {
        throw new Error("record removal failed");
      },
    });
    expect(failure?.message).toBe("record removal failed");
    expect(fs.existsSync(f.record)).toBe(true);
    expect(fs.existsSync(f.key)).toBe(false);
    expect(f.released()).toBe(true);
  });
});

describe("native inference broker response bounds", () => {
  it("rejects and cancels an oversized provider stream without waiting for its end", async () => {
    let providerClosed = false;
    const upstream = createServer((_request, response) => {
      response.once("close", () => {
        providerClosed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write(Buffer.alloc(33 * 1024 * 1024, "x"));
      // Deliberately never end: buffering the complete response cannot finish.
    });
    const owner = await broker(await listen(upstream));
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("provider response exceeded the broker limit");
    await vi.waitFor(() => expect(providerClosed).toBe(true));
  });

  it.each([200, 204])("preserves an ordinary provider response with status %s", async (status) => {
    const upstream = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end('{"data":[]}');
    });
    const owner = await broker(await listen(upstream));
    const response = await fetch(`http://127.0.0.1:${owner.port}/v1/models`, {
      headers: { authorization: "Bearer agent-broker-token" },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(status === 204 ? "" : '{"data":[]}');
  });
});
