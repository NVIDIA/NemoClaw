// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { telemetryRuntime } =
  require("../../dist/lib/adapters/telemetry/http.js") as typeof import("../../src/lib/adapters/telemetry/http");
const { recordTelemetryTarget, setTelemetryOutcome, withTelemetryOperation } =
  require("../../dist/lib/actions/telemetry/operation.js") as typeof import("../../src/lib/actions/telemetry/operation");
const { isOperationEvent } =
  require("../../dist/lib/domain/telemetry/schema.js") as typeof import("../../src/lib/domain/telemetry/schema");
const { NemoClawCommand } =
  require("../../dist/lib/cli/nemoclaw-oclif-command.js") as typeof import("../../src/lib/cli/nemoclaw-oclif-command");

class MappedTelemetryCommand extends NemoClawCommand {
  static id = "update";

  public async run(): Promise<void> {
    setTelemetryOutcome("completed", "applied", "cli");
    await withTelemetryOperation("install", async () => {
      recordTelemetryTarget({ scope: "cli", outcome: "completed", state: "applied" });
    });
  }
}

class UnmappedTelemetryCommand extends NemoClawCommand {
  static id = "status";

  public async run(): Promise<void> {
    setTelemetryOutcome("completed", "applied", "cli");
  }
}

it("delivers one mapped oclif operation and skips an unmapped command (#12859)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-contract-"));
  const sourceRoot = path.join(import.meta.dirname, "../..");
  const receipts = path.join(root, "received.ndjson");
  const server = new Worker(
    `const http = require('node:http');
     const fs = require('node:fs');
     const { parentPort, workerData } = require('node:worker_threads');
     const server = http.createServer((request, response) => {
       let body = '';
       request.on('data', (chunk) => { body += String(chunk); });
       request.on('end', () => {
         fs.appendFileSync(workerData.receipts, JSON.stringify({ method: request.method, body }) + '\\n');
         response.writeHead(200).end();
       });
     });
     server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
     setTimeout(() => { server.closeAllConnections(); server.close(); }, 10000).unref();`,
    { eval: true, workerData: { receipts } },
  );
  try {
    const [port] = (await once(server, "message")) as [number];
    vi.stubEnv("CI", undefined);
    vi.stubEnv("GITHUB_ACTIONS", undefined);
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", undefined);
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", undefined);
    vi.stubEnv("NEMOCLAW_TELEMETRY_CONTEXT_DIR", undefined);
    vi.stubEnv("HOME", root);
    telemetryRuntime.config = {
      endpoint: new URL(`http://127.0.0.1:${port}/`),
      localReceiver: true,
    };

    await MappedTelemetryCommand.run([], sourceRoot);
    await UnmappedTelemetryCommand.run([], sourceRoot);

    const received = fs.readFileSync(receipts, "utf8").trim().split("\n");
    expect(received).toHaveLength(1);
    const request = JSON.parse(received[0]);
    expect(request.method).toBe("POST");
    const envelope = JSON.parse(request.body);
    expect(envelope.events).toHaveLength(1);
    expect(isOperationEvent(envelope.events[0])).toBe(true);
    expect(envelope.events[0].parameters).toMatchObject({
      operation: "update",
      outcome: "completed",
      state: "applied",
    });
  } finally {
    telemetryRuntime.config = null;
    vi.unstubAllEnvs();
    await server.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
