// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { responseChunks } from "./native-inference-download.mts";
import {
  controlProof,
  equalProof,
  recordSignature,
  type NativeOwnerRecord,
} from "./native-inference-host.mts";
import { NATIVE_EXPRESS, guardedNativeChat } from "./native-inference-manifest.mts";

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > NATIVE_EXPRESS.maxRequestBytes)
      throw new Error("The local model request exceeds 16 MiB.");
    chunks.push(chunk);
  }
  return guardedNativeChat(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export function createNativeInferenceGuard(options: {
  record: NativeOwnerRecord;
  credential: string;
  upstreamCredential: string;
  signal: AbortSignal;
  upstreamPort: () => number;
  onStop: () => void;
  assertHeld: () => void;
}) {
  const { record, credential, upstreamCredential, signal } = options;
  const guard = createServer(
    { maxHeaderSize: NATIVE_EXPRESS.maxHeaderBytes },
    (request, response) => {
      void (async () => {
        const identity = /^\/identity\?nonce=([a-f0-9]{64})$/u.exec(request.url ?? "");
        if (request.method === "GET" && identity) {
          json(response, 200, {
            record: { ...record, signature: recordSignature(record, credential) },
            proof: controlProof(credential, "identity", record.instance, identity[1]),
          });
          return;
        }
        if (request.method === "POST" && request.url === "/stop") {
          const nonce = request.headers["x-nemoclaw-nonce"];
          if (
            typeof nonce !== "string" ||
            !/^[a-f0-9]{64}$/u.test(nonce) ||
            !equalProof(
              request.headers["x-nemoclaw-proof"],
              controlProof(credential, "stop", record.instance, nonce),
            )
          ) {
            json(response, 401, { error: { message: "unauthorized" } });
            return;
          }
          json(response, 202, { stopping: true });
          options.onStop();
          return;
        }
        if (request.headers.authorization !== `Bearer ${credential}`) {
          json(response, 401, { error: { message: "unauthorized" } });
          return;
        }
        if (
          !(
            (request.method === "GET" && request.url === "/v1/models") ||
            (request.method === "POST" && request.url === "/v1/chat/completions")
          )
        ) {
          json(response, 404, { error: { message: "not found" } });
          return;
        }
        if (record.status !== "ready") {
          json(response, 503, { error: { message: "The model is still loading." } });
          return;
        }
        options.assertHeld();
        const body = request.method === "POST" ? await requestBody(request) : undefined;
        const cancelled = new AbortController();
        const closed = () => cancelled.abort();
        response.once("close", closed);
        try {
          const upstream = await fetch(`http://127.0.0.1:${options.upstreamPort()}${request.url}`, {
            method: request.method,
            redirect: "error",
            body: body ? JSON.stringify(body) : undefined,
            headers: {
              authorization: `Bearer ${upstreamCredential}`,
              "content-type": "application/json",
            },
            signal: AbortSignal.any([
              signal,
              cancelled.signal,
              AbortSignal.timeout(NATIVE_EXPRESS.requestTimeoutMs),
            ]),
          });
          response.writeHead(upstream.status, {
            "cache-control": "no-store",
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          let bytes = 0;
          const limit = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              callback(
                bytes > 32 * 1024 * 1024
                  ? new Error("The local inference response exceeded its limit.")
                  : null,
                chunk,
              );
            },
          });
          if (!upstream.body) throw new Error("The local inference response is empty.");
          await pipeline(Readable.from(responseChunks(upstream.body)), limit, response);
        } finally {
          response.removeListener("close", closed);
        }
      })().catch(() => {
        if (response.destroyed) return;
        if (!response.headersSent)
          json(response, 400, {
            error: { message: "The local inference request failed its contract or runtime check." },
          });
        else response.destroy();
      });
    },
  );
  guard.requestTimeout = NATIVE_EXPRESS.requestTimeoutMs;
  guard.headersTimeout = 15_000;
  guard.maxConnections = 32;
  return guard;
}
