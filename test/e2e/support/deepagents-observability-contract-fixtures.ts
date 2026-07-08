// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";

import type { StartedOtlpCaptureServers } from "../live/deepagents-otlp-capture-server.ts";
import type { OtlpAttributeValue } from "../live/otlp-trace-decoder.ts";

export const SERVICE_NAME = "nemoclaw-langchain-deepagents-code";

export type TestSpan = {
  attributes: Record<string, OtlpAttributeValue>;
  name: string;
};

function varint(value: number): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function field(fieldNumber: number, wireType: number, value: Buffer): Buffer {
  return Buffer.concat([varint((fieldNumber << 3) | wireType), value]);
}

function bytesField(fieldNumber: number, value: Buffer): Buffer {
  return field(fieldNumber, 2, Buffer.concat([varint(value.length), value]));
}

function stringField(fieldNumber: number, value: string): Buffer {
  return bytesField(fieldNumber, Buffer.from(value));
}

function anyValue(value: OtlpAttributeValue): Buffer {
  if (value === null) return Buffer.alloc(0);
  if (typeof value === "string") return stringField(1, value);
  if (typeof value === "boolean") return field(2, 0, varint(value ? 1 : 0));
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return field(3, 0, varint(value));
    const double = Buffer.alloc(8);
    double.writeDoubleLE(value);
    return field(4, 1, double);
  }
  if (Array.isArray(value)) {
    const array = Buffer.concat(value.map((item) => bytesField(1, anyValue(item))));
    return bytesField(5, array);
  }
  const entries = Object.entries(value).map(([key, item]) => bytesField(1, keyValue(key, item)));
  return bytesField(6, Buffer.concat(entries));
}

function keyValue(key: string, value: OtlpAttributeValue): Buffer {
  return Buffer.concat([stringField(1, key), bytesField(2, anyValue(value))]);
}

function attributes(fieldNumber: number, values: Record<string, OtlpAttributeValue>): Buffer[] {
  return Object.entries(values).map(([key, value]) =>
    bytesField(fieldNumber, keyValue(key, value)),
  );
}

function spanBytes(span: TestSpan): Buffer {
  return Buffer.concat([stringField(5, span.name), ...attributes(9, span.attributes)]);
}

export function traceRequest(spans: readonly TestSpan[], serviceName = SERVICE_NAME): Buffer {
  const resource = Buffer.concat(attributes(1, { "service.name": serviceName }));
  const scopeSpans = Buffer.concat(spans.map((span) => bytesField(2, spanBytes(span))));
  const resourceSpans = Buffer.concat([bytesField(1, resource), bytesField(2, scopeSpans)]);
  return bytesField(1, resourceSpans);
}

export function request(
  port: number,
  headers: Record<string, string>,
  body = "",
): Promise<number | null> {
  return new Promise((resolve) => {
    const client = http.request(
      { host: "127.0.0.1", method: "POST", path: "/v1/traces", port, headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? null));
      },
    );
    client.on("error", () => resolve(null));
    if (body) client.write(body);
    client.end();
  });
}

export function pendingRequest(
  port: number,
  contentLength: number,
): {
  complete(body: string): void;
  destroy(): void;
  status: Promise<number | null>;
} {
  let finish: (status: number | null) => void = () => {};
  const status = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const client = http.request(
    {
      host: "127.0.0.1",
      method: "POST",
      path: "/v1/traces",
      port,
      headers: {
        "content-length": String(contentLength),
        "content-type": "application/x-protobuf",
      },
    },
    (response) => {
      response.resume();
      response.on("end", () => finish(response.statusCode ?? null));
    },
  );
  client.on("error", () => finish(null));
  client.flushHeaders();
  return {
    complete: (body) => client.end(body),
    destroy: () => client.destroy(),
    status,
  };
}

export async function waitForMetadata(captureDir: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.readdirSync(captureDir).filter((name) => name.endsWith(".json")).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`capture server did not write ${count} metadata files`);
}

export async function waitForReservedBytes(
  started: Pick<StartedOtlpCaptureServers, "snapshot">,
  expectedBytes: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (started.snapshot().reservedBytes === expectedBytes) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (started.snapshot().reservedBytes === expectedBytes) return;
  throw new Error(`capture server did not reserve ${expectedBytes} bytes`);
}
