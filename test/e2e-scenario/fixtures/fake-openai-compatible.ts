// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SERVER_SCRIPT = path.join(REPO_ROOT, "test/e2e/lib/fake-openai-compatible-api.mts");

export interface FakeOpenAiCompatibleRequest {
  readonly method: string;
  readonly path: string;
  readonly bodyBytes: number;
  readonly auth?: string;
  readonly model?: string;
  readonly stream?: boolean;
}

export interface FakeOpenAiCompatibleServer {
  readonly baseUrl: string;
  readonly logFile: string;
  readonly requestsFile: string;
  requests(): readonly FakeOpenAiCompatibleRequest[];
  close(): Promise<void>;
}

export interface FakeOpenAiCompatibleServerOptions {
  readonly apiKey?: string;
  readonly chatContent?: string;
  readonly host?: string;
  readonly model?: string;
  readonly port?: number;
  readonly publicHost?: string;
  readonly requireAuth?: boolean;
  readonly responseText?: string;
}

function readPort(portFile: string): number | null {
  try {
    const value = Number(fs.readFileSync(portFile, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function canReachModels(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        path: "/v1/models",
        port,
        timeout: 1_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReady(portFile: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("fake OpenAI-compatible endpoint exited before becoming ready");
    }
    const port = readPort(portFile);
    if (port !== null && (await canReachModels(port))) return port;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("fake OpenAI-compatible endpoint did not become ready");
}

function parseRequests(requestsFile: string): FakeOpenAiCompatibleRequest[] {
  try {
    return fs
      .readFileSync(requestsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeOpenAiCompatibleRequest);
  } catch {
    return [];
  }
}

export async function startFakeOpenAiCompatibleServer(
  options: FakeOpenAiCompatibleServerOptions = {},
): Promise<FakeOpenAiCompatibleServer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openai-"));
  const portFile = path.join(tmpDir, "port");
  const logFile = path.join(tmpDir, "server.log");
  const requestsFile = path.join(tmpDir, "requests.jsonl");
  const host = options.host ?? "127.0.0.1";
  const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_SCRIPT], {
    env: {
      ...process.env,
      NEMOCLAW_FAKE_OPENAI_API_KEY: options.apiKey ?? "",
      NEMOCLAW_FAKE_OPENAI_CHAT_CONTENT: options.chatContent ?? "ok",
      NEMOCLAW_FAKE_OPENAI_HOST: host,
      NEMOCLAW_FAKE_OPENAI_LOG_FILE: logFile,
      NEMOCLAW_FAKE_OPENAI_MODEL: options.model ?? "test-model",
      NEMOCLAW_FAKE_OPENAI_PORT: String(options.port ?? 0),
      NEMOCLAW_FAKE_OPENAI_PORT_FILE: portFile,
      NEMOCLAW_FAKE_OPENAI_REQUESTS_FILE: requestsFile,
      NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH: options.requireAuth ? "1" : "0",
      NEMOCLAW_FAKE_OPENAI_RESPONSE_TEXT: options.responseText ?? options.chatContent ?? "ok",
    },
    stdio: "ignore",
  });

  let port: number;
  try {
    port = await waitForReady(portFile, child);
  } catch (error) {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(tmpDir, { force: true, recursive: true });
    throw error;
  }
  const publicHost = options.publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
  return {
    baseUrl: `http://${publicHost}:${port}/v1`,
    logFile,
    requestsFile,
    requests: () => parseRequests(requestsFile),
    close: async () => {
      child.kill("SIGTERM");
      await waitForExit(child);
      fs.rmSync(tmpDir, { force: true, recursive: true });
    },
  };
}
