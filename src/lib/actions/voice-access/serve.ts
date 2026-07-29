// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Server } from "node:http";
import path from "node:path";

import {
  createVoiceAccessGatewayServer,
  readVoiceAccessTokenFile,
} from "../../adapters/http/voice-access-gateway";

export const DEFAULT_VOICE_ACCESS_LISTEN_PORT = 18_800;
export const DEFAULT_VOICE_ACCESS_UPSTREAM_PORT = 18_790;

const LOOPBACK_ADDRESS = "127.0.0.1";
const MIN_SERVICE_PORT = 1024;
const MAX_SERVICE_PORT = 65_535;

type VoiceAccessSignal = "SIGINT" | "SIGTERM";

interface VoiceAccessProcessEvents {
  once(event: VoiceAccessSignal, listener: () => void): unknown;
  removeListener(event: VoiceAccessSignal, listener: () => void): unknown;
}

export interface VoiceAccessGatewayActionOptions {
  listenPort?: number;
  tokenFile: string;
  upstreamPort?: number;
}

export interface VoiceAccessGatewayActionDeps {
  createServer?: typeof createVoiceAccessGatewayServer;
  log?: (message: string) => void;
  processEvents?: VoiceAccessProcessEvents;
  readTokenFile?: typeof readVoiceAccessTokenFile;
}

function validateServicePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < MIN_SERVICE_PORT || port > MAX_SERVICE_PORT) {
    throw new Error(
      `${label} must be an integer between ${MIN_SERVICE_PORT} and ${MAX_SERVICE_PORT}.`,
    );
  }
}

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, LOOPBACK_ADDRESS, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Run the internal voice access gateway in the foreground until interrupted.
 *
 * The HTTP adapter owns authentication and request forwarding. This action
 * owns only configuration validation, loopback binding, and process lifetime.
 */
export async function runVoiceAccessGatewayAction(
  options: VoiceAccessGatewayActionOptions,
  deps: VoiceAccessGatewayActionDeps = {},
): Promise<void> {
  const listenPort = options.listenPort ?? DEFAULT_VOICE_ACCESS_LISTEN_PORT;
  const upstreamPort = options.upstreamPort ?? DEFAULT_VOICE_ACCESS_UPSTREAM_PORT;

  if (!path.isAbsolute(options.tokenFile)) {
    throw new Error("Voice access token file path must be absolute.");
  }
  validateServicePort(listenPort, "Voice access listen port");
  validateServicePort(upstreamPort, "Voice access upstream port");
  if (listenPort === upstreamPort) {
    throw new Error("Voice access listen and upstream ports must be different.");
  }

  const readTokenFile = deps.readTokenFile ?? readVoiceAccessTokenFile;
  const createServer = deps.createServer ?? createVoiceAccessGatewayServer;
  const processEvents = deps.processEvents ?? process;
  const log = deps.log ?? console.log;
  const server = createServer({ authToken: readTokenFile(options.tokenFile), upstreamPort });

  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: Error) => void = () => {};
  const shutdown = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const onSigint = () => resolveShutdown();
  const onSigterm = () => resolveShutdown();
  const onClose = () => resolveShutdown();
  const onRuntimeError = (error: Error) => rejectShutdown(error);

  processEvents.once("SIGINT", onSigint);
  processEvents.once("SIGTERM", onSigterm);

  try {
    await listenOnLoopback(server, listenPort);
    server.once("close", onClose);
    server.once("error", onRuntimeError);
    log(
      `Voice access gateway listening on http://${LOOPBACK_ADDRESS}:${listenPort} and forwarding to http://${LOOPBACK_ADDRESS}:${upstreamPort}.`,
    );
    await shutdown;
  } finally {
    processEvents.removeListener("SIGINT", onSigint);
    processEvents.removeListener("SIGTERM", onSigterm);
    server.removeListener("close", onClose);
    server.removeListener("error", onRuntimeError);
    await closeServer(server);
  }
}
