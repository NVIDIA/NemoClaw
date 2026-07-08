// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_OTLP_BODY_BYTES = 1_048_576;
export const DEFAULT_MAX_CAPTURE_BYTES = 16 * 1_048_576;
export const DEFAULT_MAX_CAPTURE_REQUESTS = 128;
const OTLP_CONTENT_TYPE = "application/x-protobuf";
const FORBIDDEN_EXPORTER_HEADERS = new Set([
  "authorization",
  "cookie",
  "grpc-metadata-authorization",
  "proxy-authorization",
  "x-api-key",
]);

export type OtlpCaptureMetadata = {
  accepted: boolean;
  contentType: typeof OTLP_CONTENT_TYPE | null;
  method: "POST" | null;
  path: "/v1/traces" | null;
  port: number;
  rejection: string | null;
};

export type OtlpCaptureServerOptions = {
  allowLoopback?: boolean;
  bindIp: string;
  captureDir: string;
  collectorPort: number;
  decoyPort: number;
  maxCaptureBytes?: number;
  maxCaptureRequests?: number;
  maxBodyBytes?: number;
};

export type StartedOtlpCaptureServers = {
  close(): Promise<void>;
  collectorPort: number;
  decoyPort: number;
  snapshot(): { capturedBytes: number; requestCount: number; reservedBytes: number };
};

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index],
    )
  ) {
    return null;
  }
  return octets;
}

export function isPrivateBridgeIpv4(value: string, allowLoopback = false): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  if (allowLoopback && octets[0] === 127) return true;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function configuredPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OTLP capture server did not expose an IPv4 listener");
  }
  return address.port;
}

function listen(server: Server, bindIp: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindIp);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeResponse(response: ServerResponse, statusCode: number): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { "content-length": "0", connection: "close" });
  response.end();
}

function numericContentLength(request: IncomingMessage): number | null {
  const raw = request.headers["content-length"];
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function captureFilePath(
  captureDir: string,
  sequence: number,
  port: number,
  extension: "body" | "json",
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("capture sequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("capture port must be a valid TCP port");
  }
  const stem = `${String(sequence).padStart(4, "0")}-${port}`;
  const target = path.resolve(captureDir, `${stem}.${extension}`);
  if (path.dirname(target) !== captureDir) {
    throw new Error("capture file escaped the configured directory");
  }
  return target;
}

function hasForbiddenExporterHeader(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some((name) => FORBIDDEN_EXPORTER_HEADERS.has(name));
}

export async function startOtlpCaptureServers(
  options: OtlpCaptureServerOptions,
): Promise<StartedOtlpCaptureServers> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_OTLP_BODY_BYTES;
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const maxCaptureRequests = options.maxCaptureRequests ?? DEFAULT_MAX_CAPTURE_REQUESTS;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < maxBodyBytes) {
    throw new Error("maxCaptureBytes must be a safe integer at least as large as maxBodyBytes");
  }
  if (!Number.isSafeInteger(maxCaptureRequests) || maxCaptureRequests < 1) {
    throw new Error("maxCaptureRequests must be a positive safe integer");
  }
  if (!isPrivateBridgeIpv4(options.bindIp, options.allowLoopback === true)) {
    throw new Error(`refusing non-private OTLP capture bind address: ${options.bindIp}`);
  }
  const requestedCaptureDir = path.resolve(options.captureDir);
  const captureStat = fs.lstatSync(requestedCaptureDir);
  if (captureStat.isSymbolicLink() || !captureStat.isDirectory()) {
    throw new Error(`OTLP capture path is not a real directory: ${requestedCaptureDir}`);
  }
  const captureDir = fs.realpathSync.native(requestedCaptureDir);

  let sequence = 0;
  let capturedBytes = 0;
  let reservedBytes = 0;
  const servers: Server[] = [];

  const start = async (port: number): Promise<Server> => {
    let server: Server;
    server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        writeResponse(response, 200);
        return;
      }

      let finalized = false;
      let observedBytes = 0;
      let reservation = 0;
      const chunks: Buffer[] = [];
      const declaredBytes = numericContentLength(request);
      sequence += 1;
      const requestSequence = sequence;

      const finalize = (accepted: boolean, rejection: string | null, statusCode: number): void => {
        if (finalized) return;
        finalized = true;
        reservedBytes -= reservation;
        reservation = 0;
        if (requestSequence > maxCaptureRequests + 1) {
          writeResponse(response, 429);
          return;
        }
        const requestLimitExceeded = requestSequence > maxCaptureRequests;
        const captureAccepted = accepted && !requestLimitExceeded;
        const body = captureAccepted ? Buffer.concat(chunks, observedBytes) : Buffer.alloc(0);
        capturedBytes += body.length;
        const port = configuredPort(server);
        const metadata: OtlpCaptureMetadata = {
          accepted: captureAccepted,
          contentType: captureAccepted ? OTLP_CONTENT_TYPE : null,
          method: captureAccepted ? "POST" : null,
          path: captureAccepted ? "/v1/traces" : null,
          port,
          rejection: requestLimitExceeded ? "capture request count exceeds bound" : rejection,
        };
        const bodyPath = captureFilePath(captureDir, requestSequence, port, "body");
        const metadataPath = captureFilePath(captureDir, requestSequence, port, "json");
        fs.writeFileSync(bodyPath, body, { flag: "wx", mode: 0o600 });
        fs.writeFileSync(metadataPath, JSON.stringify(metadata), {
          flag: "wx",
          mode: 0o600,
        });
        writeResponse(response, requestLimitExceeded ? 429 : statusCode);
      };

      if (requestSequence > maxCaptureRequests) {
        finalize(false, "capture request count exceeds bound", 429);
        request.destroy();
        return;
      }

      if (request.method !== "POST") {
        finalize(false, "unexpected request method", 405);
        request.destroy();
        return;
      }
      if (request.url !== "/v1/traces") {
        finalize(false, "unexpected request path", 404);
        request.destroy();
        return;
      }
      if (hasForbiddenExporterHeader(request)) {
        finalize(false, "forbidden exporter header", 400);
        request.destroy();
        return;
      }
      if (request.headers["content-type"] !== OTLP_CONTENT_TYPE) {
        finalize(false, "unexpected content type", 415);
        request.destroy();
        return;
      }

      if (declaredBytes === null) {
        finalize(false, "missing or invalid content-length", 411);
        request.destroy();
        return;
      }
      if (declaredBytes > maxBodyBytes) {
        finalize(false, "declared body exceeds capture bound", 413);
        request.destroy();
        return;
      }
      if (capturedBytes + reservedBytes + declaredBytes > maxCaptureBytes) {
        finalize(false, "aggregate captured bodies exceed bound", 507);
        request.destroy();
        return;
      }
      reservation = declaredBytes;
      reservedBytes += reservation;

      request.setTimeout(15_000, () => {
        finalize(false, "request body timed out", 408);
        request.destroy();
      });
      request.on("data", (chunk: Buffer) => {
        if (finalized) return;
        observedBytes += chunk.length;
        if (observedBytes > maxBodyBytes || observedBytes > declaredBytes) {
          finalize(false, "streamed body exceeds capture bound", 413);
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (finalized) return;
        if (observedBytes !== declaredBytes) {
          finalize(false, "request body length mismatch", 400);
          return;
        }
        finalize(true, null, 200);
      });
      request.on("error", () => {
        if (request.complete) finalize(false, "request body stream failed", 400);
      });
      request.on("close", () => {
        if (!request.complete) finalize(false, "request body aborted", 400);
      });
    });
    await listen(server, options.bindIp, port);
    servers.push(server);
    return server;
  };

  try {
    const collector = await start(options.collectorPort);
    const decoy = await start(options.decoyPort);
    return {
      collectorPort: configuredPort(collector),
      decoyPort: configuredPort(decoy),
      close: async () => {
        await Promise.all(servers.map(close));
      },
      snapshot: () => ({ capturedBytes, requestCount: sequence, reservedBytes }),
    };
  } catch (error) {
    await Promise.allSettled(servers.map(close));
    throw error;
  }
}

async function main(): Promise<void> {
  const [captureDir, bindIp, collectorPortRaw, decoyPortRaw] = process.argv.slice(2);
  const collectorPort = Number(collectorPortRaw);
  const decoyPort = Number(decoyPortRaw);
  if (
    !captureDir ||
    !bindIp ||
    !Number.isInteger(collectorPort) ||
    collectorPort < 1 ||
    !Number.isInteger(decoyPort) ||
    decoyPort < 1
  ) {
    throw new Error(
      "usage: deepagents-otlp-capture-server.ts <capture-dir> <private-bind-ip> <collector-port> <decoy-port>",
    );
  }
  const started = await startOtlpCaptureServers({
    bindIp,
    captureDir,
    collectorPort,
    decoyPort,
  });
  process.stdout.write(
    `CAPTURE_READY:${JSON.stringify({ bindIp, collectorPort: started.collectorPort, decoyPort: started.decoyPort })}\n`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 5_000);
    timeout.unref();
    await started.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
