// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadPersistedOllamaHost as loadDefaultPersistedOllamaHost } from "../inference/local";
import type { OllamaHostRoute, OllamaRouteHolder } from "../inference/local-adapter-lifecycle";
import {
  isLocalOllamaRouteOwner,
  loadPendingOllamaModelCleanup as loadDefaultPendingOllamaModelCleanup,
} from "../inference/ollama/model-ownership";
import * as registry from "../state/registry";

export interface SandboxSummary {
  defaultSandbox?: string | null;
}

export interface StartCommandDeps {
  listSandboxes: () => SandboxSummary;
  startAll: (options: { sandboxName?: string }) => Promise<void>;
}

export interface OllamaCleanupLookupDeps {
  getSandbox?: (name: string) => OllamaRouteHolder | null;
  loadPersistedOllamaHost?: () => OllamaHostRoute | null;
  loadPendingOllamaModelCleanup?: (sandboxName: string) => readonly string[];
}

export interface StopCommandOptions {
  sandboxName?: string;
  releaseGatewayPort?: boolean;
  cleanupOllamaModels?: boolean;
}

export interface StopCommandDeps extends OllamaCleanupLookupDeps {
  listSandboxes: () => SandboxSummary;
  stopAll: (options: StopCommandOptions) => void;
  /** Legacy `nemoclaw stop` tears down the managed host gateway too. */
  releaseGatewayPort?: boolean;
}

const SAFE_SANDBOX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function resolveDefaultSandboxName(listSandboxes: () => SandboxSummary): string | undefined {
  // Explicit env var overrides take highest priority so that
  // `NEMOCLAW_SANDBOX_NAME=foo nemoclaw stop` targets the right sandbox.
  const envName =
    process.env.NEMOCLAW_SANDBOX_NAME ?? process.env.NEMOCLAW_SANDBOX ?? process.env.SANDBOX_NAME;
  if (envName && SAFE_SANDBOX_RE.test(envName)) return envName;

  const { defaultSandbox } = listSandboxes();
  return defaultSandbox && SAFE_SANDBOX_RE.test(defaultSandbox) ? defaultSandbox : undefined;
}

export async function runStartCommand(deps: StartCommandDeps): Promise<void> {
  await deps.startAll({ sandboxName: resolveDefaultSandboxName(deps.listSandboxes) });
}

/**
 * Decide whether `tunnel stop` / `stop` should unload Ollama models.
 *
 * vLLM-only and other non-Ollama installs never configured a local Ollama
 * route, so cleanup is not applicable. Pending cleanup receipts still force
 * an unload. When no sandbox name is available, a persisted host is the
 * only evidence that Ollama was configured.
 */
export function shouldCleanupOllamaModelsOnStop(
  sandboxName: string | undefined,
  deps: OllamaCleanupLookupDeps = {},
): boolean {
  const getSandbox = deps.getSandbox ?? ((name: string) => registry.getSandbox(name));
  const loadPersistedOllamaHost = deps.loadPersistedOllamaHost ?? loadDefaultPersistedOllamaHost;
  const loadPendingOllamaModelCleanup =
    deps.loadPendingOllamaModelCleanup ?? loadDefaultPendingOllamaModelCleanup;
  const selectedHost = loadPersistedOllamaHost();
  if (!sandboxName) return selectedHost != null;
  const pending = loadPendingOllamaModelCleanup(sandboxName);
  if (pending.length > 0) return true;
  const sandbox = getSandbox(sandboxName);
  if (sandbox) return isLocalOllamaRouteOwner(sandbox, selectedHost);
  return selectedHost != null;
}

export function runStopCommand(deps: StopCommandDeps): void {
  const sandboxName = resolveDefaultSandboxName(deps.listSandboxes);
  const options: StopCommandOptions = {
    sandboxName,
    cleanupOllamaModels: shouldCleanupOllamaModelsOnStop(sandboxName, deps),
  };
  if (deps.releaseGatewayPort) options.releaseGatewayPort = true;
  deps.stopAll(options);
}
