// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import * as undici from "undici";

const ADVISOR_HTTP_IDLE_TIMEOUT_MS = 300_000;
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

// Undici can emit a dispatcher error while the corresponding fetch rejects normally.
// Keep that EventEmitter path from terminating the process, but report every event so
// an independent transport failure remains observable. Remove this listener when
// Undici no longer emits an uncaught dispatcher error for a rejected proxy request.
const reportUndiciDispatcherError = (error: unknown): void => {
  console.error("Advisor HTTP dispatcher error:", error);
};

function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", reportUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

/**
 * Give the embedded Pi SDK the same proxy-aware fetch transport as Pi's CLI.
 * OpenShell's inference.local route is reachable only through the sandbox proxy.
 */
export function configureAdvisorHttpDispatcher(): void {
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: ADVISOR_HTTP_IDLE_TIMEOUT_MS,
      headersTimeout: ADVISOR_HTTP_IDLE_TIMEOUT_MS,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);

  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}
