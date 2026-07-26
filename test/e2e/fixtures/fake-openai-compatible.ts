// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { spawnObservedChild } from "./observed-child-process.ts";
import type { TestProgress, TestProgressCapability } from "./progress.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SERVER_SCRIPT = path.join(REPO_ROOT, "test/e2e/lib/fake-openai-compatible-api.mts");

export interface FakeOpenAiCompatibleRequest {
  readonly method: string;
  readonly path: string;
  readonly hostHeader?: string;
  readonly bodyBytes: number;
  readonly auth?: string;
  readonly authorizationSent?: boolean;
  readonly model?: string;
  readonly stream?: boolean;
  readonly forbiddenMarkerMatches?: number;
}

export interface FakeOpenAiCompatibleServer {
  readonly baseUrl: string;
  readonly logFile: string;
  readonly requestsFile: string;
  environmentKeys(): readonly string[];
  requests(): readonly FakeOpenAiCompatibleRequest[];
  close(): Promise<void>;
}

export interface FakeOpenAiCompatibleServerOptions {
  readonly apiKey?: string;
  readonly chatContent?: string;
  readonly forbiddenMarkers?: readonly string[];
  readonly host?: string;
  readonly maxModelLen?: number;
  readonly model?: string;
  readonly port?: number;
  readonly progress: Pick<TestProgress, "activity" | "event" | "onOutput"> & TestProgressCapability;
  readonly publicHost?: string;
  readonly requireAuth?: boolean;
  readonly requireAuthModels?: boolean;
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

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (await waitForExit(child, 5_000)) return;
  throw new Error("fake OpenAI-compatible endpoint did not stop after SIGKILL");
}

function readinessProbeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function formatHttpHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function canReachModels(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: readinessProbeHost(host),
        path: "/v1/models",
        port,
        timeout: 1_000,
      },
      (res) => {
        res.resume();
        // 401 still means the server is up — it just enforces auth on
        // /v1/models (requireAuthModels), which the readiness probe omits.
        resolve(res.statusCode === 200 || res.statusCode === 401);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReady(portFile: string, child: ChildProcess, host: string): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("fake OpenAI-compatible endpoint exited before becoming ready");
    }
    const port = readPort(portFile);
    if (port !== null && (await canReachModels(host, port))) return port;
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

function parseEnvironmentKeys(environmentFile: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(environmentFile, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export async function startFakeOpenAiCompatibleServer(
  options: FakeOpenAiCompatibleServerOptions,
): Promise<FakeOpenAiCompatibleServer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openai-"));
  const environmentFile = path.join(tmpDir, "environment-keys.json");
  const portFile = path.join(tmpDir, "port");
  const logFile = path.join(tmpDir, "server.log");
  const requestsFile = path.join(tmpDir, "requests.jsonl");
  const host = options.host ?? "127.0.0.1";
  let child: ChildProcess;
  try {
    child = spawnObservedChild(process.execPath, ["--experimental-strip-types", SERVER_SCRIPT], {
      activityLabel: "command: fake-openai-compatible-server",
      progress: options.progress,
      spawn: {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NEMOCLAW_FAKE_OPENAI_API_KEY: options.apiKey ?? "",
          NEMOCLAW_FAKE_OPENAI_CHAT_CONTENT: options.chatContent ?? "ok",
          NEMOCLAW_FAKE_OPENAI_ENVIRONMENT_FILE: environmentFile,
          NEMOCLAW_FAKE_OPENAI_FORBIDDEN_MARKERS: JSON.stringify(options.forbiddenMarkers ?? []),
          NEMOCLAW_FAKE_OPENAI_HOST: host,
          NEMOCLAW_FAKE_OPENAI_LOG_FILE: logFile,
          NEMOCLAW_FAKE_OPENAI_MAX_MODEL_LEN:
            options.maxModelLen !== undefined ? String(options.maxModelLen) : "",
          NEMOCLAW_FAKE_OPENAI_MODEL: options.model ?? "test-model",
          NEMOCLAW_FAKE_OPENAI_PORT: String(options.port ?? 0),
          NEMOCLAW_FAKE_OPENAI_PORT_FILE: portFile,
          NEMOCLAW_FAKE_OPENAI_REQUESTS_FILE: requestsFile,
          NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH: options.requireAuth ? "1" : "0",
          NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH_MODELS: options.requireAuthModels ? "1" : "0",
          NEMOCLAW_FAKE_OPENAI_RESPONSE_TEXT: options.responseText ?? options.chatContent ?? "ok",
        },
        stdio: "ignore",
      },
    });
  } catch (error) {
    fs.rmSync(tmpDir, { force: true, recursive: true });
    throw error;
  }
  try {
    options.progress?.event("fake OpenAI-compatible server started");
  } catch {
    // Progress diagnostics must never change fake endpoint behavior.
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await terminateChild(child);
      } finally {
        try {
          options.progress?.event("fake OpenAI-compatible server stopped");
        } catch {
          // Progress diagnostics must never change fake endpoint cleanup.
        }
        fs.rmSync(tmpDir, { force: true, recursive: true });
      }
    })();
    return closePromise;
  };

  let port: number;
  try {
    port = await waitForReady(portFile, child, host);
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "fake OpenAI-compatible server failed to become ready and failed to terminate cleanly",
      );
    }
    throw error;
  }
  const publicHost = options.publicHost ?? readinessProbeHost(host);
  return {
    baseUrl: `http://${formatHttpHost(publicHost)}:${port}/v1`,
    logFile,
    requestsFile,
    environmentKeys: () => parseEnvironmentKeys(environmentFile),
    requests: () => parseRequests(requestsFile),
    close,
  };
}
