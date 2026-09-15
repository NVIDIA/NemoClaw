// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

import { ownChildProcess } from "../../helpers/child-process-lifecycle";

export const VOICE_GATEWAY_STARTUP_TIMEOUT_MS = 15_000;
export const VOICE_GATEWAY_SESSION_REQUEST_TIMEOUT_MS = 5_000;
export const VOICE_GATEWAY_GRACEFUL_STOP_TIMEOUT_MS = 1_000;
export const VOICE_GATEWAY_FORCE_STOP_TIMEOUT_MS = 1_000;
const VOICE_GATEWAY_PROCESS_CONTRACT_CLEANUP_MARGIN_MS = 5_000;

/**
 * Two launches, three session requests, and two bounded shutdowns make up the
 * real-process package contract. Keep its test ceiling outside every fixture
 * phase so a phase-specific error wins before Vitest's generic timeout.
 */
export const VOICE_GATEWAY_PROCESS_CONTRACT_TIMEOUT_MS =
  2 * VOICE_GATEWAY_STARTUP_TIMEOUT_MS +
  3 * VOICE_GATEWAY_SESSION_REQUEST_TIMEOUT_MS +
  2 * (VOICE_GATEWAY_GRACEFUL_STOP_TIMEOUT_MS + VOICE_GATEWAY_FORCE_STOP_TIMEOUT_MS) +
  VOICE_GATEWAY_PROCESS_CONTRACT_CLEANUP_MARGIN_MS;

/** Reserve and release an ephemeral loopback port for a process-contract test. */
export async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Wait until the child reports its listening state or terminates. */
export async function waitForGatewayListening(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onExit = (code: number | null): void =>
      fail(new Error(`voice gateway exited before startup: ${code}`));
    const onData = (chunk: Buffer | string): void => {
      stdout += String(chunk);
      if (stdout.includes('"state":"listening"')) {
        cleanup();
        resolve();
      }
    };
    const timeout = setTimeout(
      () => fail(new Error("voice gateway startup timed out")),
      VOICE_GATEWAY_STARTUP_TIMEOUT_MS,
    );
    timeout.unref();
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  });
}

/** Return filesystem targets still held open by a running process. */
export function openFileTargets(pid: number): string[] {
  if (process.platform === "linux") {
    return fs
      .readdirSync(`/proc/${pid}/fd`)
      .map((descriptor) => `/proc/${pid}/fd/${descriptor}`)
      .flatMap((descriptorPath) => {
        try {
          return [fs.readlinkSync(descriptorPath)];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      });
  }
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-Fn"], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** Submit one authenticated session request to the process under test. */
export async function requestSession(
  port: number,
  bearer: string,
  timeoutMs = VOICE_GATEWAY_SESSION_REQUEST_TIMEOUT_MS,
): Promise<{ readonly status: number; readonly body: string }> {
  const body = JSON.stringify({ runtimeConversationId: "process-contract" });
  return new Promise((resolve, reject) => {
    let response: http.IncomingMessage | null = null;
    let settled = false;
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      clearTimeout(timeout);
      request.off("error", onRequestError);
      response?.off("data", onResponseData);
      response?.off("end", onResponseEnd);
      response?.off("error", onResponseError);
      response?.off("aborted", onResponseAborted);
    };
    const fail = (error: Error, destroy = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) {
        response?.once("error", () => undefined);
        request.once("error", () => undefined);
        response?.destroy();
        request.destroy();
      }
      reject(error);
    };
    const onRequestError = (error: Error): void =>
      fail(new Error(`voice gateway session request transport failed: ${error.message}`));
    const onResponseData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.from(chunk));
    };
    const onResponseEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        status: response?.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    };
    const onResponseError = (error: Error): void =>
      fail(new Error(`voice gateway session response failed: ${error.message}`));
    const onResponseAborted = (): void =>
      fail(new Error("voice gateway session response was aborted"));
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/voice/sessions",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-length": String(Buffer.byteLength(body)),
          "content-type": "application/json",
        },
      },
      (incoming) => {
        response = incoming;
        response.on("data", onResponseData);
        response.once("end", onResponseEnd);
        response.once("error", onResponseError);
        response.once("aborted", onResponseAborted);
      },
    );
    const timeout = setTimeout(
      () => fail(new Error(`voice gateway session request timed out after ${timeoutMs} ms`), true),
      timeoutMs,
    );
    timeout.unref();
    request.once("error", onRequestError);
    request.end(body);
  });
}

/** Stop a gateway child and wait for process termination. */
export async function stopGateway(child: ChildProcess): Promise<void> {
  await ownChildProcess(child, {
    gracefulTimeoutMs: VOICE_GATEWAY_GRACEFUL_STOP_TIMEOUT_MS,
    forceTimeoutMs: VOICE_GATEWAY_FORCE_STOP_TIMEOUT_MS,
  }).terminate();
}
