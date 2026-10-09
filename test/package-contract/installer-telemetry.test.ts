// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { isOperationEvent } =
  require("../../dist/lib/domain/telemetry/schema.js") as typeof import("../../src/lib/domain/telemetry/schema");

const INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");

it("delivers one installer record after the shell exits (#12859)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-telemetry-"));
  const receipts = path.join(root, "received.ndjson");
  const sourceRoot = path.join(import.meta.dirname, "../..");
  const entry = path.join(sourceRoot, "dist/lib/cli/installer-telemetry-entry.js");
  const adapter = path.join(sourceRoot, "dist/lib/adapters/telemetry/http.js");
  const identity = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "dist/build-identity.json"), "utf8"),
  ) as { nemoclawVersion: string };
  const preload = path.join(root, "local-receiver.cjs");
  const trace = path.join(root, "delivery-trace.log");
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const { TEST_TELEMETRY_ENDPOINT } = require(${JSON.stringify(adapter)});
fs.appendFileSync(process.env.NEMOCLAW_TEST_TRACE, 'loaded ' + process.argv[1] + '\\n');
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  fs.appendFileSync(process.env.NEMOCLAW_TEST_TRACE, 'fetch ' + String(input) + '\\n');
  if (String(input) !== TEST_TELEMETRY_ENDPOINT) throw new Error('Unexpected network request');
  return fetchOriginal(process.env.NEMOCLAW_TEST_RECEIVER_URL, init);
};
`,
  );
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
    expect(fs.existsSync(entry)).toBe(true);
    const [port] = (await once(server, "message")) as [number];
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$INSTALLER_UNDER_TEST"
_NEMOCLAW_VERIFIED_VERSION="$EXPECTED_VERSION"
_installer_telemetry_begin installed
[[ "$_INSTALLER_TELEMETRY_ACTIVE" == true ]]
_INSTALLER_TELEMETRY_OUTCOME=completed
_INSTALLER_TELEMETRY_STATE=applied
exit 0`,
      ],
      {
        cwd: sourceRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "",
          GITHUB_ACTIONS: "",
          VITEST: "",
          NODE_ENV: "",
          NEMOCLAW_DISABLE_TELEMETRY: "",
          NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-telemetry:client:attempt-1",
          NEMOCLAW_TEST_RECEIVER_URL: `http://127.0.0.1:${port}/`,
          NEMOCLAW_TEST_TRACE: trace,
          NEMOCLAW_SOURCE_ROOT: sourceRoot,
          NODE_OPTIONS: `--require=${preload}`,
          HOME: root,
          INSTALLER_UNDER_TEST: INSTALLER,
          EXPECTED_VERSION: identity.nemoclawVersion,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(
      fs.existsSync(receipts),
      `${result.stderr} ${fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "no trace"}`,
    ).toBe(true);
    const requests = fs
      .readFileSync(receipts, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    const envelope = JSON.parse(requests[0].body);
    expect(envelope.events).toHaveLength(1);
    expect(isOperationEvent(envelope.events[0])).toBe(true);
    const parameters = envelope.events[0].parameters;
    expect(parameters.operation).toBe("install");
    expect(parameters.outcome).toBe("completed");
    expect(parameters.state).toBe("applied");
    expect(parameters.versions.installedStatus).toBe("reported");
    expect(parameters.versions.targetStatus).toBe("reported");
  } finally {
    await server.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
