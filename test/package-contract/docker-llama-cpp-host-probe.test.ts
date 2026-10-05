// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { expect, it, vi } from "vitest";

import { createDockerFixture } from "../../src/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle-engine.test-support";
import {
  contract,
  IMAGE,
  MODEL_CONTENT,
  MODEL_DIGEST,
  MODEL_FILENAME,
  plan,
  PROBE_IMAGE,
  RECEIPT_TARGET_SHA256,
  REVISION,
  RUNTIME_ID,
  TRANSACTION_ID,
} from "../../src/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle.test-support";
import { privateBridgeFixture } from "../../src/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge.test-support";

const require = createRequire(import.meta.url);
const { createDockerLlamaCppManagedLifecycle } =
  require("../../dist/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle.js") as typeof import("../../src/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle");
const { createHostLocalCreateJournalStore } =
  require("../../dist/lib/onboard/runtime-provider/host-local-create-journal.js") as typeof import("../../src/lib/onboard/runtime-provider/host-local-create-journal");
const { createFilePersistedEngineAuthorityStore } =
  require("../../dist/lib/onboard/runtime-provider/persisted-engine-authority.js") as typeof import("../../src/lib/onboard/runtime-provider/persisted-engine-authority");

it("starts the compiled lifecycle through its real host-process probe (#11823)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-probe-")));
  // The lifecycle blocks in spawnSync; a separate worker keeps the health endpoint responsive.
  const server = new Worker(
    `const http = require('node:http');
     const { parentPort } = require('node:worker_threads');
     const server = http.createServer((request, response) => {
       parentPort.postMessage(request.url);
       response.writeHead(200).end();
     });
     server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
     setTimeout(() => { server.closeAllConnections(); server.close(); }, 10000).unref();`,
    { eval: true },
  );
  try {
    const [port] = (await once(server, "message")) as [number];
    const request = once(server, "message");
    const cacheRoot = path.join(root, "cache");
    const modelPath = path.join(
      cacheRoot,
      "hub",
      "models--example--model",
      "snapshots",
      REVISION,
      MODEL_FILENAME,
    );
    fs.mkdirSync(path.dirname(modelPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(modelPath, MODEL_CONTENT, { mode: 0o600 });
    const apiKeyRoot = path.join(root, "key-root");
    fs.mkdirSync(apiKeyRoot, { mode: 0o700 });
    const apiKeyPath = path.join(apiKeyRoot, "api-key");
    fs.writeFileSync(apiKeyPath, "test-only-secret\n", { mode: 0o600 });
    const modelStat = fs.lstatSync(modelPath, { bigint: true });
    const networkName = "nemoclaw-llama-cpp-internal";
    const fixture = createDockerFixture({ apiKeyPath, modelPath, networkName, serverPort: port });
    const journalStore = createHostLocalCreateJournalStore(root);
    const lifecycle = createDockerLlamaCppManagedLifecycle(
      {
        authorityStore: createFilePersistedEngineAuthorityStore(root),
        apiKeyRootHostPath: apiKeyRoot,
        bindingSha256: "1".repeat(64),
        bindings: {
          apiKeyHostPath: apiKeyPath,
          containerName: "nemoclaw-llama-cpp",
          hostPort: port,
          imageReference: IMAGE,
          model: {
            digest: MODEL_DIGEST,
            filesystemIdentity: modelStat,
            hostPath: modelPath,
            sizeBytes: MODEL_CONTENT.length,
          },
          network: { isolation: "docker-internal", name: networkName },
          ownerLabel: { name: "io.nvidia.nemoclaw.llama-cpp-owner", value: "gateway.primary" },
          runtimeGid: 1001,
          runtimeUid: 1001,
        },
        cacheRootHostPath: cacheRoot,
        contract: { ...contract(), serve: { ...contract().serve, port } },
        engine: fixture.engine,
        journalStore,
        loopbackProbe: "host-process",
        plan: plan(),
        probeImageReference: PROBE_IMAGE,
        readinessTimeoutSeconds: 31,
      },
      { privateBridge: privateBridgeFixture() },
    );
    const writeExact = vi.fn((serialized: string) => serialized);
    const receipt = lifecycle.start({
      transactionId: TRANSACTION_ID,
      targetSha256: RECEIPT_TARGET_SHA256,
      writeExact,
    });

    expect(await request).toEqual(["/health"]);
    expect(receipt.runtime).toMatchObject({ kind: "container", runtimeId: RUNTIME_ID });
    expect(writeExact).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(journalStore.list()).toEqual([
      expect.objectContaining({ phase: "finalized", runtimeId: RUNTIME_ID }),
    ]);
  } finally {
    await server.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
