// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import type http from "node:http";

// Protocol mechanics only. Choosing fake versus hosted/public inference remains
// the inference-mode concern tracked by #5745.

export async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function writeJsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function writeSseBody(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function writeSseEvents(
  res: http.ServerResponse,
  events: ReadonlyArray<readonly [string | undefined, unknown]>,
  done = false,
): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [name, payload] of events) {
    if (name) res.write(`event: ${name}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end(done ? "data: [DONE]\n\n" : undefined);
}

export async function listenServer(
  server: http.Server,
  port = 0,
  host = "0.0.0.0",
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind to a TCP port");
  return address.port;
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
