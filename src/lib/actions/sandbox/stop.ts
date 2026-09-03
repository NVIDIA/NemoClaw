// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import {
  decideOllamaModelOwnership,
  matchingOllamaModelPeers,
} from "../../inference/ollama/model-ownership";
import type { OllamaUnloadResult } from "../../inference/ollama/proxy";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import { parseLiveSandboxEntries } from "../../runtime-recovery";
import * as registry from "../../state/registry";
import { stopSandboxChannels } from "../../tunnel/sandbox-gateway-stop";
import { teardownSandboxDashboardForward } from "./forward-recovery";
import {
  captureSandboxOwnershipPhases,
  resolvePersistedSandboxOwnershipGateway,
  withSandboxLifecycleLockSync,
} from "./gateway-state";
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

function defaultUnloadOllamaModels(onlyModels: readonly string[]): OllamaUnloadResult {
  const { unloadOllamaModels } = require("../../inference/ollama/proxy") as {
    unloadOllamaModels: (onlyModels?: readonly string[]) => OllamaUnloadResult;
  };
  return unloadOllamaModels(onlyModels);
}

export type OllamaActiveOwnershipDiscovery =
  | {
      readonly ok: true;
      readonly activeSandboxNames: ReadonlySet<string>;
      readonly gatewayChecks: readonly {
        readonly activeSandboxes: readonly string[];
        readonly gateway: string;
      }[];
    }
  | { readonly ok: false; readonly message: string };

type OllamaStopReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

type OllamaOwnershipDiscoveryDeps = {
  readonly captureSandboxOwnershipPhases?: typeof captureSandboxOwnershipPhases;
  readonly parseLiveSandboxEntries?: typeof parseLiveSandboxEntries;
  readonly resolvePersistedSandboxOwnershipGateway?: typeof resolvePersistedSandboxOwnershipGateway;
};

export function discoverActiveOllamaSandboxNames(
  peers: readonly registry.SandboxEntry[],
  environment: NodeJS.ProcessEnv,
  deps: OllamaOwnershipDiscoveryDeps = {},
): OllamaActiveOwnershipDiscovery {
  const capturePhases = deps.captureSandboxOwnershipPhases ?? captureSandboxOwnershipPhases;
  const parseEntries = deps.parseLiveSandboxEntries ?? parseLiveSandboxEntries;
  const resolveGateway =
    deps.resolvePersistedSandboxOwnershipGateway ?? resolvePersistedSandboxOwnershipGateway;
  if (peers.length === 0) {
    return { ok: true, activeSandboxNames: new Set(), gatewayChecks: [] };
  }

  const peersByGateway = new Map<string, Set<string>>();
  try {
    for (const peer of peers) {
      const gateway = resolveGateway(peer);
      const names = peersByGateway.get(gateway) ?? new Set<string>();
      names.add(peer.name);
      peersByGateway.set(gateway, names);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `could not resolve a sibling gateway: ${detail}` };
  }

  const activeSandboxNames = new Set<string>();
  const gatewayChecks: Array<{ activeSandboxes: string[]; gateway: string }> = [];
  for (const [gateway, peerNames] of peersByGateway) {
    let result;
    try {
      result = capturePhases(gateway, environment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `OpenShell could not list gateway '${gateway}': ${detail}` };
    }
    if (result.status !== 0) {
      const detail = result.output.trim().replace(/\s+/g, " ").slice(0, 300);
      return {
        ok: false,
        message: `OpenShell could not list sandbox phases on gateway '${gateway}'${
          detail ? `: ${detail}` : ""
        }`,
      };
    }
    const phases = new Map(
      parseEntries(result.output).map((entry) => [entry.name, entry.phase]),
    );
    const activeSandboxes: string[] = [];
    for (const peerName of peerNames) {
      const phase = phases.get(peerName);
      if (phase === undefined || phase === "Error" || phase === "Failed" || phase === "Evicted") {
        continue;
      }
      if (phase === null || phase === "Unknown") {
        return {
          ok: false,
          message: `OpenShell returned no usable phase for sibling '${peerName}' on gateway '${gateway}'`,
        };
      }
      activeSandboxNames.add(peerName);
      activeSandboxes.push(peerName);
    }
    gatewayChecks.push({ activeSandboxes, gateway });
  }
  return { ok: true, activeSandboxNames, gatewayChecks };
}

function releaseStoppedSandboxOllamaModel(
  sandbox: registry.SandboxEntry,
  deps: SandboxStopDeps,
  log: (message: string) => void,
): OllamaStopReleaseResult {
  if (!sandbox.provider?.includes("ollama")) return { ok: true };

  try {
    const withOwnershipLock =
      deps.withOllamaModelOwnershipLock ??
      (require("../../inference/ollama/proxy") as typeof import("../../inference/ollama/proxy"))
        .withOllamaModelOwnershipLock;
    return withOwnershipLock(() => {
      const { sandboxes } = (deps.listSandboxes ?? registry.listSandboxes)();
      const matchingPeers = matchingOllamaModelPeers(sandbox, sandboxes);
      const discovery = (
        deps.discoverActiveOllamaSandboxNames ?? discoverActiveOllamaSandboxNames
      )(matchingPeers, deps.environment ?? process.env);
      if (!discovery.ok) {
        return {
          ok: false,
          message:
            `Sandbox '${sandbox.name}' stopped, but Ollama model ownership could not be verified: ` +
            `${discovery.message}. No model was unloaded; verify sibling sandbox state and retry ` +
            `'${CLI_NAME} ${sandbox.name} stop'.`,
        };
      }

      const ownership = (deps.decideOllamaModelOwnership ?? decideOllamaModelOwnership)(
        sandbox,
        sandboxes,
        discovery.activeSandboxNames,
      );
      if (ownership.kind === "missing-model") {
        log("  Ollama model release skipped: the sandbox registry has no model.");
        return { ok: true };
      }
      if (ownership.kind === "shared-active") {
        log(
          `  Ollama model '${ownership.model}' remains loaded for active sandbox${
            ownership.activePeers.length === 1 ? "" : "es"
          }: ${ownership.activePeers.join(", ")}.`,
        );
        return { ok: true };
      }
      if (ownership.stalePeers.length > 0) {
        log(
          `  Ollama ownership ignored stopped or incomplete registry row${
            ownership.stalePeers.length === 1 ? "" : "s"
          }: ${ownership.stalePeers.join(", ")}.`,
        );
      }

      const unload = (deps.unloadOllamaModels ?? defaultUnloadOllamaModels)([ownership.model]);
      if (!unload.ok) {
        const attempts = Math.max(
          unload.discoveries.reduce((maximum, evidence) => Math.max(maximum, evidence.attempt), 0),
          unload.requests.reduce((maximum, evidence) => Math.max(maximum, evidence.attempt), 0),
        );
        return {
          ok: false,
          message:
            `Sandbox '${sandbox.name}' stopped, but Ollama model '${ownership.model}' was not ` +
            `released from ${unload.endpoint} after ${String(attempts)} bounded attempt${
              attempts === 1 ? "" : "s"
            } (${unload.outcome}: ${unload.message ?? "no detail"}). ` +
            `Run 'ollama stop ${ownership.model}' or repair host Ollama, then retry ` +
            `'${CLI_NAME} ${sandbox.name} stop'.`,
        };
      }
      log(
        unload.outcome === "not-resident"
          ? `  Ollama model '${ownership.model}' was not resident in ${unload.endpoint}/api/ps.`
          : `  Ollama model release verified: '${ownership.model}' is absent from ` +
              `${unload.endpoint}/api/ps.`,
      );
      return { ok: true };
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        `Sandbox '${sandbox.name}' stopped, but Ollama model release failed: ${detail}. ` +
        `Verify host Ollama and retry '${CLI_NAME} ${sandbox.name} stop'.`,
    };
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
  discoverActiveOllamaSandboxNames?: (
    peers: readonly registry.SandboxEntry[],
    environment: NodeJS.ProcessEnv,
  ) => OllamaActiveOwnershipDiscovery;
  unloadOllamaModels?: (onlyModels: readonly string[]) => OllamaUnloadResult;
  decideOllamaModelOwnership?: typeof decideOllamaModelOwnership;
  withOllamaModelOwnershipLock?: typeof import("../../inference/ollama/proxy").withOllamaModelOwnershipLock;
  withLifecycleLockSync?: typeof withSandboxLifecycleLockSync;
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
  return (deps.withLifecycleLockSync ?? withSandboxLifecycleLockSync)(sandboxName, () =>
    stopSandboxWithinLifecycleFence(sandboxName, deps),
  );
}

function stopSandboxWithinLifecycleFence(
  sandboxName: string,
  deps: SandboxStopDeps,
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
  const hermesPortableVerified =
    "hermesPortableVerified" in outcome && outcome.hermesPortableVerified === true;
  const ollamaRelease = releaseStoppedSandboxOllamaModel(resolved.sandbox, deps, log);
  if (!hermesPortableVerified) {
    teardownDashboardForwardBestEffort(
      sandboxName,
      deps.teardownSandboxDashboardForward ?? teardownSandboxDashboardForward,
      warn,
    );
  }
  if (!ollamaRelease.ok) return { exitCode: 1, message: ollamaRelease.message };
  if (hermesPortableVerified) {
    log(
      outcome.state === "already-stopped"
        ? `  Sandbox '${sandboxName}' is already stopped.`
        : `  Sandbox '${sandboxName}' stopped. Workspace state is preserved.`,
    );
    log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
    return { exitCode: 0 };
  }

  if (outcome.state === "already-stopped") {
    log(`  Sandbox '${sandboxName}' is already stopped.`);
    log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
    return { exitCode: 0 };
  }

  log(`  Sandbox '${sandboxName}' stopped. Workspace state is preserved.`);
  log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
  return { exitCode: 0 };
}
