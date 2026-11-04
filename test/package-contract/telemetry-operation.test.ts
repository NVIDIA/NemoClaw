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

const sourceRoot = path.join(import.meta.dirname, "../..");

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

class SelectedTelemetryCommand extends NemoClawCommand {
  static id = "";
  protected override async runBeforeLifecycleBoundary(): Promise<boolean> {
    return true;
  }
  public async run(): Promise<void> {}
}

class InitRejectingTelemetryCommand extends NemoClawCommand {
  static id = "update";
  protected override async init(): Promise<void> {
    await super.init();
    throw new Error("init rejected");
  }
  public async run(): Promise<void> {}
}

type ReceivedRequest = { method: string; body: string };

async function captureRequests(run: () => Promise<void>): Promise<ReceivedRequest[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-contract-"));
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
    await run();
    return fs.existsSync(receipts)
      ? fs
          .readFileSync(receipts, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as ReceivedRequest)
      : [];
  } finally {
    telemetryRuntime.config = null;
    vi.unstubAllEnvs();
    await server.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function operationOf(request: ReceivedRequest): unknown {
  const envelope = JSON.parse(request.body);
  expect(envelope.events).toHaveLength(1);
  expect(isOperationEvent(envelope.events[0])).toBe(true);
  return envelope.events[0].parameters.operation;
}

it("delivers one mapped oclif operation and skips an unmapped command (#12859)", async () => {
  const requests = await captureRequests(async () => {
    await MappedTelemetryCommand.run([], sourceRoot);
    await UnmappedTelemetryCommand.run([], sourceRoot);
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("POST");
  expect(operationOf(requests[0])).toBe("update");
  expect(JSON.parse(requests[0].body).events[0].parameters).toMatchObject({
    outcome: "completed",
    state: "applied",
  });
}, 20_000);

it.each([
  ["onboard", "sandbox_create"],
  ["update", "update"],
  ["upgrade-sandboxes", "upgrade_sandboxes"],
  ["sandbox:rebuild", "sandbox_rebuild"],
  ["sandbox:destroy", "sandbox_destroy"],
  ["sandbox:recover", "sandbox_recover"],
  ["inference:set", "inference_set"],
  ["sandbox:inference:set", "inference_set"],
  ["sandbox:agents:add", "agent_add"],
  ["sandbox:agents:delete", "agent_delete"],
  ["sandbox:agents:apply", "agents_apply"],
  ["sandbox:channels:add", "messaging_add"],
  ["sandbox:channels:remove", "messaging_remove"],
  ["sandbox:channels:stop", "messaging_pause"],
  ["sandbox:channels:start", "messaging_resume"],
  ["sandbox:policy:add", "policy_change"],
  ["sandbox:policy:remove", "policy_change"],
  ["sandbox:policy:exclude", "policy_change"],
  ["sandbox:policy:restore", "policy_change"],
])("selects %s as %s for telemetry (#12859)", async (commandId, operation) => {
  const requests = await captureRequests(async () => {
    SelectedTelemetryCommand.id = commandId;
    await SelectedTelemetryCommand.run([], sourceRoot);
  });
  expect(requests).toHaveLength(1);
  expect(operationOf(requests[0])).toBe(operation);
});

it.each([
  { name: "separate default key", argv: ["--key", "model.default"] },
  { name: "inline provider key", argv: ["--key=model.provider"] },
  { name: "inline API mode key", argv: ["--key=model.api_mode"] },
])("selects settings telemetry for $name (#12859)", async ({ argv }) => {
  const requests = await captureRequests(async () => {
    SelectedTelemetryCommand.id = "sandbox:config:set";
    await SelectedTelemetryCommand.run(argv, sourceRoot);
  });
  expect(requests).toHaveLength(1);
  expect(operationOf(requests[0])).toBe("settings_change");
});

it.each([
  {
    name: "separate unsupported key",
    commandId: "sandbox:config:set",
    argv: ["--key", "network.policy"],
  },
  {
    name: "inline unsupported key",
    commandId: "sandbox:config:set",
    argv: ["--key=network.policy"],
  },
  { name: "settings long help", commandId: "sandbox:config:set", argv: ["--help"] },
  { name: "settings short help", commandId: "sandbox:config:set", argv: ["-h"] },
  { name: "update long help", commandId: "update", argv: ["--help"] },
  { name: "update short help", commandId: "update", argv: ["-h"] },
])("skips telemetry for $name (#12859)", async ({ commandId, argv }) => {
  const requests = await captureRequests(async () => {
    SelectedTelemetryCommand.id = commandId;
    await SelectedTelemetryCommand.run(argv, sourceRoot);
  });
  expect(requests).toEqual([]);
});

it("records a mapped command that fails during init (#12859)", async () => {
  const requests = await captureRequests(async () => {
    await expect(InitRejectingTelemetryCommand.run([], sourceRoot)).rejects.toThrow(
      "init rejected",
    );
  });
  expect(requests).toHaveLength(1);
  expect(operationOf(requests[0])).toBe("update");
  expect(JSON.parse(requests[0].body).events[0].parameters.outcome).toBe("failed");
});
