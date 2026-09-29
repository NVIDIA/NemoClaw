// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

export const BRAVE_TEST_KEY = "brave-integration-synthetic-key";
const RESULT = { title: "NVIDIA fixture result", url: "https://example.test/nvidia" };

// curl is synchronous in production. A worker keeps the local backend responsive
// while the real credential probe runs in this thread.
const BACKEND = String.raw`
const { createServer } = require("node:http");
const { parentPort, workerData } = require("node:worker_threads");
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const authenticated = request.headers["x-subscription-token"] === workerData.key;
  requests.push({
    method: request.method,
    path: url.pathname,
    query: url.searchParams.get("q"),
    count: url.searchParams.get("count"),
    authenticated,
  });
  const status = !authenticated ? 401
    : request.method !== "GET" || url.pathname !== "/res/v1/web/search" ? 404
    : !url.searchParams.get("q") ? 422
    : workerData.status;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(status === 200
    ? { type: "search", web: { results: [workerData.result] } }
    : { type: "ErrorResponse", error: { status, detail: "Synthetic Brave failure" } }));
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
parentPort.on("message", () => parentPort.postMessage(requests));
`;

export async function startBraveBackend(
  status: number,
  passthroughCurl = false,
  options: { messageTimeoutMs?: number; workerSource?: string; temporaryRoot?: string } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(options.temporaryRoot ?? os.tmpdir(), "nemoclaw-brave-integration-"),
  );
  const worker = new Worker(options.workerSource ?? BACKEND, {
    eval: true,
    workerData: { key: BRAVE_TEST_KEY, result: RESULT, status },
  });
  const close = async () => {
    await worker.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  const messageTimeoutMs = options.messageTimeoutMs ?? 5_000;
  const receive = async (label: string) => {
    try {
      return await once(worker, "message", { signal: AbortSignal.timeout(messageTimeoutMs) });
    } catch (cause) {
      await close();
      throw new Error(`Brave mock backend did not report ${label} within ${messageTimeoutMs}ms`, {
        cause,
      });
    }
  };
  try {
    const [port] = await receive("startup port");
    fs.writeFileSync(
      path.join(directory, "curl"),
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const canonical = "https://api.search.brave.com/res/v1/web/search";
const brave = args.some(arg => arg.includes("api.search.brave.com"));
if (brave || !${passthroughCurl}) {
  if (args.filter(arg => arg === canonical).length !== 1 ||
      args.some(arg => /^https?:/.test(arg) && arg !== canonical)) process.exit(90);
}
const result = spawnSync("/usr/bin/curl", args.map(arg => arg === canonical
  ? "http://127.0.0.1:${port}/res/v1/web/search" : arg), {
  stdio: "inherit", timeout: 20000,
  env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
});
process.exit(result.status ?? 91);
`,
      { mode: 0o700 },
    );
    return {
      directory,
      env: { PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}` },
      requests: async () => {
        const received = receive("request report");
        worker.postMessage("requests");
        const [requests] = await received;
        return requests;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// This is the optional post-onboard service probe, never the credential guard.
// Refuse its network request without claiming Brave egress succeeded. Every
// other OpenShell command, including creation and isolation checks, stays real.
export function writeBraveEgressPreload(directory: string, openshell: string): string {
  const preload = path.join(directory, "brave-egress.cjs");
  fs.writeFileSync(
    preload,
    `const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const spawn = childProcess.spawn;
childProcess.spawn = function (binary, args, options) {
  const command = Array.isArray(args) ? args.slice(args.indexOf("--") + 1) : [];
  if (binary === ${JSON.stringify(openshell)} && Array.isArray(args) &&
    args[0] === "sandbox" && args[1] === "exec" &&
    command.length === 3 && command[0] === "sh" && command[1] === "-lc" &&
    command[2].startsWith("'curl' '-sS' '--compressed' '--max-time' '20' '-G' 'https://api.search.brave.com/res/v1/web/search' ")) {
    fs.appendFileSync(${JSON.stringify(path.join(directory, "brave-egress-blocked"))}, "blocked\\n");
    return spawn.call(this, process.execPath, ["-e", "process.exit(69)"], options);
  }
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  return preload;
}
