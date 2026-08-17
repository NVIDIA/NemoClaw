// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

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
    const timeout = setTimeout(() => reject(new Error("voice gateway did not start")), 15_000);
    const rejectAfterCleanup = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("error", rejectAfterCleanup);
    child.once("exit", (code) =>
      rejectAfterCleanup(new Error(`voice gateway exited before startup: ${code}`)),
    );
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('"state":"listening"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
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
): Promise<{ readonly status: number; readonly body: string }> {
  const body = JSON.stringify({ runtimeConversationId: "process-contract" });
  return new Promise((resolve, reject) => {
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
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

/** Stop a gateway child and wait for process termination. */
export async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}
