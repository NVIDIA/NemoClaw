// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import * as registry from "../../state/registry";
import { stopSandboxChannels } from "../../tunnel/sandbox-gateway-stop";
import { teardownSandboxDashboardForward } from "./forward-recovery";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";

function teardownDashboardForwardBestEffort(
  sandboxName: string,
  teardown: typeof teardownSandboxDashboardForward,
  warn: (message: string) => void,
): void {
  try {
    teardown(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`  Warning: could not release the dashboard port-forward: ${detail}`);
  }
}

function defaultUnloadOllamaModels(onlyModels: readonly string[]): void {
  const { unloadOllamaModels } = require("../../inference/ollama/proxy") as {
    unloadOllamaModels: (onlyModels?: readonly string[]) => void;
  };
  unloadOllamaModels(onlyModels);
}

/**
 * Release the GPU memory an Ollama-backed sandbox left resident (#9110).
 *
 * `stopAll()` and `destroySandbox()` already unload; a plain stop did not, so
 * the model stayed loaded until Ollama's own idle TTL expired. Best-effort:
 * the sandbox is already stopped by this point, so GPU cleanup must never
 * change the exit code.
 */
function unloadOllamaModelsBestEffort(
  sandbox: registry.SandboxEntry,
  deps: SandboxStopDeps,
): void {
  if (!sandbox.provider?.includes("ollama")) return;
  try {
    const withOwnershipLock =
      deps.withOllamaModelOwnershipLock ??
      (require("../../inference/ollama/proxy") as typeof import("../../inference/ollama/proxy"))
        .withOllamaModelOwnershipLock;
    const exclusivelyHeldOllamaModel =
      deps.exclusivelyHeldOllamaModel ??
      (require("../../inference/ollama/model-ownership") as typeof import("../../inference/ollama/model-ownership"))
        .exclusivelyHeldOllamaModel;
    withOwnershipLock(() => {
      const { sandboxes } = (deps.listSandboxes ?? registry.listSandboxes)();
      const model = exclusivelyHeldOllamaModel(sandbox, sandboxes);
      if (!model) return;
      (deps.unloadOllamaModels ?? defaultUnloadOllamaModels)([model]);
    });
  } catch {
    /* Best-effort: a failed unload must not fail the stop. */
  }
}

export type { SandboxLifecycleResult } from "./runtime/lifecycle-runtime";

export interface SandboxStopDeps {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  stopSandboxChannels?: typeof stopSandboxChannels;
  teardownSandboxDashboardForward?: typeof teardownSandboxDashboardForward;
  listSandboxes?: typeof registry.listSandboxes;
  unloadOllamaModels?: (onlyModels: readonly string[]) => void;
  exclusivelyHeldOllamaModel?: typeof import("../../inference/ollama/model-ownership").exclusivelyHeldOllamaModel;
  withOllamaModelOwnershipLock?: typeof import("../../inference/ollama/proxy").withOllamaModelOwnershipLock;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Stop the selected provider workload while preserving registry, workspace,
 * credentials, and shared gateway state.
 */
export function stopSandbox(
  sandboxName: string,
  deps: SandboxStopDeps = {},
): SandboxLifecycleResult {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const sandbox = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    "stop",
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok) return resolved.result;

  const input = {
    environment: deps.environment ?? process.env,
    log,
    sandbox: resolved.sandbox,
    sandboxName,
  };
  const preflight = resolved.bundle.preflightDoctor.preflightLifecycle("stop", input);
  if (preflight) return preflight;

  let channelsStopped = false;
  const outcome = resolved.lifecycle.stop(input, {
    beforeStop() {
      if (channelsStopped) return;
      channelsStopped = true;
      try {
        (deps.stopSandboxChannels ?? stopSandboxChannels)(sandboxName, {
          channelStopTransport: resolved.lifecycle.channelStopTransport,
          info: (message) => log(`  ${message}`),
          warn: (message) => warn(`  ${message}`),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warn(`  Warning: could not stop in-sandbox channels gracefully: ${detail}`);
      }
    },
  });
  if (outcome.exitCode !== 0) return outcome;

  unloadOllamaModelsBestEffort(resolved.sandbox, deps);

  if (outcome.state === "already-stopped") {
    log(`  Sandbox '${sandboxName}' is already stopped.`);
    teardownDashboardForwardBestEffort(
      sandboxName,
      deps.teardownSandboxDashboardForward ?? teardownSandboxDashboardForward,
      warn,
    );
    log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
    return { exitCode: 0 };
  }

  teardownDashboardForwardBestEffort(
    sandboxName,
    deps.teardownSandboxDashboardForward ?? teardownSandboxDashboardForward,
    warn,
  );
  log(`  Sandbox '${sandboxName}' stopped. Workspace state is preserved.`);
  log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
  return { exitCode: 0 };
}
