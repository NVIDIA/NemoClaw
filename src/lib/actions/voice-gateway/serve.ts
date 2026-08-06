// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Server } from "node:http";

import { readPrivateCredentialFile } from "../../adapters/fs/private-credential";
import { createVoiceGatewayServer } from "../../adapters/http/voice-gateway";
import { OpenClawVoiceAgentClient } from "../../adapters/openclaw/voice-agent-client";
import { type VoiceDiagnostic, VoiceSessionService } from "../../domain/voice/session-service";

export const VOICE_GATEWAY_FEATURE_FLAG = "NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY";
export const DEFAULT_VOICE_GATEWAY_PORT = 18_800;
export const DEFAULT_VOICE_SESSION_LIFETIME_MS = 5 * 60_000;
export const DEFAULT_VOICE_TURN_TIMEOUT_MS = 90_000;
const LOOPBACK_ADDRESS = "127.0.0.1";

type VoiceGatewaySignal = "SIGINT" | "SIGTERM";

interface ProcessEvents {
  once(event: VoiceGatewaySignal, listener: () => void): unknown;
  removeListener(event: VoiceGatewaySignal, listener: () => void): unknown;
}

export interface VoiceGatewayActionOptions {
  admissionCredentialFile: string;
  openClawCredentialFile: string;
  openClawEndpoint: string;
  listenPort?: number;
  runtimeId: string;
  runtimeProfile: string;
  sandbox: string;
  agent: string;
  sessionLifetimeMs?: number;
  turnTimeoutMs?: number;
}

export interface VoiceGatewayActionDeps {
  environment?: NodeJS.ProcessEnv;
  readCredential?: typeof readPrivateCredentialFile;
  createServer?: typeof createVoiceGatewayServer;
  createAgentClient?: () => OpenClawVoiceAgentClient;
  processEvents?: ProcessEvents;
  log?: (message: string) => void;
}

function validatePort(value: number): void {
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error("Voice gateway listen port must be an integer between 1024 and 65535.");
  }
}

function validateTrustedName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK_ADDRESS, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function runVoiceGatewayAction(
  options: VoiceGatewayActionOptions,
  deps: VoiceGatewayActionDeps = {},
): Promise<void> {
  const environment = deps.environment ?? process.env;
  if (environment[VOICE_GATEWAY_FEATURE_FLAG] !== "1") {
    throw new Error(
      `Experimental voice gateway is disabled. Set ${VOICE_GATEWAY_FEATURE_FLAG}=1 to enable it.`,
    );
  }

  const listenPort = options.listenPort ?? DEFAULT_VOICE_GATEWAY_PORT;
  const sessionLifetimeMs = options.sessionLifetimeMs ?? DEFAULT_VOICE_SESSION_LIFETIME_MS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_VOICE_TURN_TIMEOUT_MS;
  validatePort(listenPort);
  validateTrustedName(options.runtimeId, "Voice runtime identity");
  validateTrustedName(options.runtimeProfile, "Voice runtime profile");
  validateTrustedName(options.sandbox, "Voice sandbox");
  validateTrustedName(options.agent, "Voice agent");

  const readCredential = deps.readCredential ?? readPrivateCredentialFile;
  const admissionCredential = readCredential(
    options.admissionCredentialFile,
    "Voice deployment credential",
  );
  const openClawCredential = readCredential(
    options.openClawCredentialFile,
    "OpenClaw agent gateway credential",
  );
  const diagnostic = (value: VoiceDiagnostic) => {
    (deps.log ?? console.log)(
      JSON.stringify({ component: "experimental-voice-gateway", ...value }),
    );
  };
  const sessionService = new VoiceSessionService({
    runtimeId: options.runtimeId,
    runtimeProfile: options.runtimeProfile,
    sandbox: options.sandbox,
    agent: options.agent,
    sessionLifetimeMs,
    turnTimeoutMs,
    diagnostic,
    createAgentClient:
      deps.createAgentClient ??
      (() =>
        new OpenClawVoiceAgentClient({
          endpoint: options.openClawEndpoint,
          credential: openClawCredential,
          requestTimeoutMs: turnTimeoutMs,
        })),
  });
  const server = (deps.createServer ?? createVoiceGatewayServer)({
    admissionCredential,
    sessionService,
  });
  const processEvents = deps.processEvents ?? process;
  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: Error) => void = () => {};
  const shutdown = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const onSignal = () => resolveShutdown();
  const onClose = () => resolveShutdown();
  const onError = (error: Error) => rejectShutdown(error);
  processEvents.once("SIGINT", onSignal);
  processEvents.once("SIGTERM", onSignal);
  try {
    await listen(server, listenPort);
    server.once("close", onClose);
    server.once("error", onError);
    diagnostic({ event: "service.started", state: "experimental" });
    await shutdown;
  } finally {
    processEvents.removeListener("SIGINT", onSignal);
    processEvents.removeListener("SIGTERM", onSignal);
    server.removeListener("close", onClose);
    server.removeListener("error", onError);
    await close(server);
  }
}
