// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";

import { createWebSearchFlowHelpers } from "../../src/lib/onboard/web-search-flow";

const TEST_KEY = "brave-integration-synthetic-key";
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

async function withBackend(status: number, run: () => Promise<void>) {
  const worker = new Worker(BACKEND, {
    eval: true,
    workerData: { key: TEST_KEY, result: RESULT, status },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brave-integration-"));
  try {
    const [port] = await once(worker, "message");
    // Only the Brave transport is replaced. The production curl probe still
    // reads its private auth config, sends HTTP, and classifies the response.
    fs.writeFileSync(
      path.join(directory, "curl"),
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const canonical = "https://api.search.brave.com/res/v1/web/search";
if (args.filter(arg => arg === canonical).length !== 1 ||
    args.some(arg => /^https?:/.test(arg) && arg !== canonical)) process.exit(90);
const result = spawnSync("/usr/bin/curl", args.map(arg => arg === canonical
  ? "http://127.0.0.1:${port}/res/v1/web/search" : arg), {
  stdio: "inherit", timeout: 20000,
});
process.exit(result.status ?? 91);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
    // The fixture must remain local even on hosts with a corporate proxy.
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    await run();
    const received = once(worker, "message");
    worker.postMessage("requests");
    const [requests] = await received;
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/res/v1/web/search",
        query: "ping",
        count: "1",
        authenticated: true,
      },
    ]);
  } finally {
    vi.unstubAllEnvs();
    await worker.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("Brave Search with a local backend", () => {
  it.each([200, 401, 403, 429, 503])(
    "configures optional search from an HTTP %i response without a Brave account",
    async (status) => {
      await withBackend(status, async () => {
        const flow = createWebSearchFlowHelpers({
          env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "brave" },
          getCredential: (name) => (name === "BRAVE_API_KEY" ? TEST_KEY : null),
          saveCredential: vi.fn(),
          prompt: vi.fn(async () => {
            throw new Error("Unexpected interactive prompt");
          }),
          note: vi.fn(),
          cliName: () => "nemoclaw",
          isNonInteractive: () => true,
          commandExecutor: {
            runBuffered: async () => {
              throw new Error("Unexpected sandbox command");
            },
          },
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const configured = await flow.configureWebSearch(null);
        expect(configured).toEqual(
          status === 200 ? { fetchEnabled: true, provider: "brave" } : null,
        );
      });
    },
  );
});
