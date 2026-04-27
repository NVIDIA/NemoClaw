// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MetricsRegistry } from "./metrics.js";

export interface MetricsLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface MetricsServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

export const DEFAULT_METRICS_HOST = "127.0.0.1";
export const DEFAULT_METRICS_PORT = 9090;

export function resolveMetricsPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NEMOCLAW_METRICS_PORT;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_METRICS_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`NEMOCLAW_METRICS_PORT must be an integer from 0 to 65535, got '${raw}'`);
  }
  return parsed;
}

export function resolveMetricsHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.NEMOCLAW_METRICS_HOST?.trim();
  return raw ? raw : DEFAULT_METRICS_HOST;
}

export function createMetricsRequestHandler(
  registry: MetricsRegistry,
  logger?: Pick<MetricsLogger, "warn">,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") {
      res.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET",
      });
      res.end("method not allowed\n");
      return;
    }

    const pathname = resolveRequestPathname(req.url);
    if (!pathname) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("bad request\n");
      return;
    }

    if (pathname !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }

    try {
      const body = registry.renderPrometheus();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (error) {
      logger?.warn(
        `[OBSERVABILITY] Could not render NemoClaw metrics: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("internal server error\n");
    }
  };
}

function resolveRequestPathname(rawUrl: string | undefined): string | undefined {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

export async function startMetricsServer({
  registry,
  logger,
  env = process.env,
}: {
  registry: MetricsRegistry;
  logger: MetricsLogger;
  env?: NodeJS.ProcessEnv;
}): Promise<MetricsServer> {
  const host = resolveMetricsHost(env);
  const requestedPort = resolveMetricsPort(env);
  const server = createServer(createMetricsRequestHandler(registry, logger));

  return await new Promise<MetricsServer>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : requestedPort;
      logger.info(`NemoClaw metrics endpoint listening at http://${host}:${String(port)}/metrics`);
      resolve({
        host,
        port,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
