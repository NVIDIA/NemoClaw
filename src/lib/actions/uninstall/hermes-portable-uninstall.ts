// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { runHermesPortableUninstallOpenShell } from "../../adapters/openshell/hermes-portable-uninstall";
import type { GatewayRegistryDocument } from "../../state/gateway-registry";
import {
  hermesPortableInferenceStateDirectory as inferenceDirectory,
  hermesPortableUninstallDigest as digest,
  hermesPortableUninstallPathDigest as pathDigest,
  hermesPortableUninstallSandboxStem as sandboxStem,
  hermesPortableUninstallTextSha256,
  inspectHermesPortableUninstallDirectoryAuthority as directoryAuthoritySha256,
  readHermesPortableUninstallRegistry as exactRegistry,
  retireHermesPortableUninstallDirectory as retireExactDirectory,
  retireHermesPortableUninstallRegistryRows as retireRegistryRows,
  verifyHermesPortableUninstallRegistryRetired as verifyRegistryRetired,
} from "../../state/hermes-portable-uninstall/authority";
import type { SandboxEntry } from "../../state/registry/types";
import {
  inspectPortableRetirementRecovery,
  readPortableAuthorityDirectory,
} from "../../state/portable-uninstall-retirement";
import {
  buildHermesPortableOpenShellCommandAuthority,
  prepareHermesPortableSandboxRemoval,
  type HermesPortableLifecycleCommandResult,
  type HermesPortableLifecycleDeps,
  type PreparedHermesPortableSandboxRemoval,
} from "../../onboard/experimental/hermes-portable-lifecycle";
import {
  prepareHermesPortableOllamaProviderRetirement,
  type HermesPortableOllamaGatewayRunner,
  type PreparedHermesPortableOllamaProviderRetirement,
} from "../../onboard/experimental/hermes-portable-ollama-gateway-transaction";
import {
  createHermesPortableOllamaRuntimeAuthority,
  type HermesPortableOllamaRuntimeAuthority,
} from "../../onboard/experimental/hermes-portable-ollama-inference";
import type { HermesPortablePodmanAuthorityDeps } from "../../onboard/experimental/hermes-portable-podman-authority";
import {
  HERMES_PORTABLE_RECEIPT_DIRECTORY,
  hermesPortableReceiptDirectory,
  readHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
} from "../../onboard/experimental/hermes-portable-receipt";
import { scopeGatewayOpenshellArgs } from "../../onboard/setup-inference";
import {
  assertPreparedHostLocalInferenceRuntimePresent,
  inspectPreparedHostLocalInferenceSharingAuthority,
  prepareSandboxHostLocalInferenceDestroyAuthority,
  retirePreparedHostLocalInferenceAuthority,
  type HostLocalInferenceLifecycleSandbox,
  type PreparedHostLocalInferenceAuthority,
} from "../../onboard/runtime-provider/host-local-inference-lifecycle";
import {
  runHermesPortableUninstallTransaction,
  inspectHermesPortableUninstallJournal,
  type HermesPortableUninstallAuthority,
  type HermesPortableUninstallPhase,
  type HermesPortableUninstallTargetAuthority,
  type HermesPortableUninstallTransactionResult,
} from "./hermes-portable-uninstall-transaction";

export interface HermesPortableUninstallInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly registryFile: string;
  readonly stateDir: string;
}

export interface HermesPortableUninstallDeps {
  readonly lifecycle?: Omit<HermesPortableLifecycleDeps, "env" | "readRegistry" | "stateDir">;
  readonly podmanAuthorityDeps?: HermesPortablePodmanAuthorityDeps;
  readonly captureGpuDevices?: () => readonly string[];
  readonly captureCdiDevices?: () => readonly string[];
  readonly runOpenShell?: (
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => HermesPortableLifecycleCommandResult;
  readonly afterPhaseAction?: (phase: HermesPortableUninstallPhase) => void;
}

interface LoadedTarget {
  readonly row: SandboxEntry;
  readonly inferenceRow: HostLocalInferenceLifecycleSandbox;
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly sandbox: PreparedHermesPortableSandboxRemoval;
  readonly provider: PreparedHermesPortableOllamaProviderRetirement;
  readonly runtime: HermesPortableOllamaRuntimeAuthority;
  readonly inference: PreparedHostLocalInferenceAuthority;
  readonly inferencePeers: readonly HostLocalInferenceLifecycleSandbox[];
  readonly authority: HermesPortableUninstallTargetAuthority;
}

interface LoadedAuthority {
  readonly authority: HermesPortableUninstallAuthority;
  readonly registry: GatewayRegistryDocument;
  readonly targets: readonly LoadedTarget[];
}

interface AdmittedResourceAbsence {
  readonly sandbox: boolean;
  readonly provider: boolean;
  readonly inference: boolean;
}

interface ProviderSharingAuthority {
  readonly disposition: "exclusive" | "shared";
  readonly sha256: string;
}

const NO_RESOURCE_ABSENCE: AdmittedResourceAbsence = Object.freeze({
  sandbox: false,
  provider: false,
  inference: false,
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function schema5SandboxNames(input: HermesPortableUninstallInput): string[] {
  const root = path.join(input.stateDir, HERMES_PORTABLE_RECEIPT_DIRECTORY);
  const directory = readPortableAuthorityDirectory(root, false);
  if (directory.entries.length === 0) return [];
  const registry = exactRegistry(input);
  const targets = Object.values(registry.sandboxes)
    .filter(
      (row) =>
        row.agent === "hermes" &&
        row.openshellDriver === "docker" &&
        typeof row.lifecycleGeneration === "string",
    )
    .map((row) => row.name)
    .filter(
      (sandboxName) => readHermesPortableLifecycleReceipt(sandboxName, input.stateDir) !== null,
    )
    .sort(compareCodeUnits);
  const stems = targets.map(sandboxStem).sort();
  if (!isDeepStrictEqual(stems, directory.entries)) {
    throw new Error("Hermes Portable uninstall lifecycle receipts and registry ownership disagree");
  }
  return targets;
}

/** Detect exact schema-5 work or a durable schema-5 recovery journal. */
export function inspectHermesPortableUninstallSandboxNames(
  input: HermesPortableUninstallInput,
): string[] | null {
  const state = readPortableAuthorityDirectory(input.stateDir, false);
  if (state.identity === null) return null;
  const journal = inspectHermesPortableUninstallJournal(input.stateDir);
  const currentNames = journal?.phase === "completed" ? schema5SandboxNames(input) : [];
  const names =
    currentNames.length > 0
      ? currentNames
      : journal
        ? journal.authority.targets.map(({ sandboxName }) => sandboxName)
        : schema5SandboxNames(input);
  if (names.length === 0) return null;
  const legacyReceipts = readPortableAuthorityDirectory(
    path.join(input.stateDir, "portable-demo-lifecycle"),
    false,
  );
  if (legacyReceipts.entries.length > 0 || inspectPortableRetirementRecovery(input.homeDir)) {
    throw new Error("Hermes Portable uninstall found ambiguous schema-4 and schema-5 authority");
  }
  return [...names];
}

function gatewayRunner(
  receipt: HermesPortableConfiguredReceipt,
  input: HermesPortableUninstallInput,
  deps: HermesPortableUninstallDeps,
): HermesPortableOllamaGatewayRunner {
  const run = deps.runOpenShell ?? runHermesPortableUninstallOpenShell;
  return (args, options) => {
    const command = buildHermesPortableOpenShellCommandAuthority(
      receipt,
      input.env,
      deps.lifecycle?.assertOpenShellExecutableAuthority,
    );
    const commandEnv = { ...command.env, ...(options.env ?? {}) };
    return run(
      command.executablePath,
      scopeGatewayOpenshellArgs(args, receipt.gatewayName),
      commandEnv,
      options.timeout,
    );
  };
}

function requireSandboxRow(row: SandboxEntry, receipt: HermesPortableConfiguredReceipt): void {
  if (
    row.name !== receipt.sandboxName ||
    row.agent !== "hermes" ||
    row.openshellDriver !== "docker" ||
    row.openshellVersion !== receipt.openshellExecutableAuthority.version ||
    row.gatewayName !== receipt.gatewayName ||
    row.lifecycleGeneration !== receipt.lifecycleGeneration ||
    row.provider !== "ollama-local" ||
    typeof row.model !== "string" ||
    typeof row.credentialEnv !== "string" ||
    typeof row.hostLocalInferenceReceipt !== "string" ||
    !row.hostLocalInferenceProvenance
  ) {
    throw new Error(
      `Hermes Portable uninstall registry row '${receipt.sandboxName}' is incomplete`,
    );
  }
}

function inferenceLifecycleRow(
  row: SandboxEntry,
  providerId: string,
): HostLocalInferenceLifecycleSandbox {
  return Object.freeze({ ...row, openshellDriver: providerId });
}

function admittedResourceAbsence(phase: HermesPortableUninstallPhase): AdmittedResourceAbsence {
  switch (phase) {
    case "prepared":
      return Object.freeze({ sandbox: true, provider: false, inference: false });
    case "sandboxes-retired":
      return Object.freeze({ sandbox: true, provider: true, inference: false });
    case "providers-retired":
    case "inference-retired":
      return Object.freeze({ sandbox: true, provider: true, inference: true });
    default:
      throw new Error(`Hermes Portable uninstall cannot revalidate resources in phase '${phase}'`);
  }
}

function inspectProviderSharingAuthority(
  row: SandboxEntry,
  peers: readonly SandboxEntry[],
): ProviderSharingAuthority {
  const owners = peers
    .filter(
      (peer) =>
        peer.name === row.name ||
        (peer.gatewayName === row.gatewayName && peer.provider === row.provider),
    )
    .map((peer) => ({ name: peer.name, registryRowSha256: digest(peer) }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  if (owners.filter(({ name }) => name === row.name).length !== 1) {
    throw new Error("Hermes Portable provider custody lacks one exact target registry row");
  }
  return Object.freeze({
    disposition: owners.length === 1 ? "exclusive" : "shared",
    sha256: digest(owners),
  });
}

function targetAuthority(input: {
  readonly input: HermesPortableUninstallInput;
  readonly row: SandboxEntry;
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly snapshotSha256: string;
  readonly sandbox: PreparedHermesPortableSandboxRemoval;
  readonly provider: PreparedHermesPortableOllamaProviderRetirement;
  readonly providerSharing: ProviderSharingAuthority;
  readonly runtime: HermesPortableOllamaRuntimeAuthority;
  readonly inference: PreparedHostLocalInferenceAuthority;
  readonly sharing: ReturnType<typeof inspectPreparedHostLocalInferenceSharingAuthority>;
}): HermesPortableUninstallTargetAuthority {
  const lifecycleDirectorySha256 = directoryAuthoritySha256(
    hermesPortableReceiptDirectory(input.receipt.sandboxName, input.input.stateDir),
  );
  const inferenceDirectorySha256 = directoryAuthoritySha256(input.runtime.inferenceStateDir);
  const runtime = input.inference.receipt.runtime;
  const endpoint = input.inference.receipt.endpoint;
  if (
    lifecycleDirectorySha256 === null ||
    inferenceDirectorySha256 === null ||
    runtime.kind !== "container" ||
    !("networkId" in endpoint) ||
    !("networkAuthoritySha256" in endpoint) ||
    !input.inference.receipt.publication
  ) {
    throw new Error("Hermes Portable uninstall inference authority is incomplete");
  }
  const providerDisposition =
    input.providerSharing.disposition === "shared" ? "preserve-shared" : "remove";
  const inferenceDisposition =
    input.sharing.disposition === "shared" ? "preserve-shared" : "remove";
  return Object.freeze({
    sandboxName: input.receipt.sandboxName,
    gatewayName: input.receipt.gatewayName,
    lifecycleGeneration: input.receipt.lifecycleGeneration,
    registryRowSha256: digest(input.row),
    lifecycleReceiptSha256: input.snapshotSha256,
    lifecycleDirectorySha256,
    runtimeAuthoritySha256: digest(input.receipt.runtimeAuthority),
    openshellExecutableAuthoritySha256: digest(input.receipt.openshellExecutableAuthority),
    podmanExecutableAuthoritySha256: digest(input.receipt.podmanExecutableAuthority),
    socketAuthoritySha256: digest(input.receipt.socketAuthority),
    sandboxId: input.receipt.container.sandboxId,
    sandboxContainerId: input.receipt.container.containerId,
    sandboxContainerName: input.receipt.container.name,
    sandboxContainerLabelsSha256: input.receipt.container.labelsSha256,
    provider: Object.freeze({
      disposition: providerDisposition,
      ...input.provider.authority,
      sharingAuthoritySha256: input.providerSharing.sha256,
    }),
    inference: Object.freeze({
      disposition: inferenceDisposition,
      providerId: input.inference.providerId,
      receiptSha256: hermesPortableUninstallTextSha256(input.inference.serializedReceipt),
      sharingAuthoritySha256: input.sharing.sha256,
      directorySha256: inferenceDirectorySha256,
      runtimeId: runtime.runtimeId,
      containerName: runtime.name,
      networkId: endpoint.networkId,
      networkAuthoritySha256: endpoint.networkAuthoritySha256,
    }),
  });
}

function loadAuthority(
  input: HermesPortableUninstallInput,
  deps: HermesPortableUninstallDeps,
  expected: HermesPortableUninstallAuthority | null,
  admittedAbsence: AdmittedResourceAbsence,
): LoadedAuthority {
  if (
    expected &&
    (expected.registryPathSha256 !== pathDigest(input.registryFile) ||
      expected.statePathSha256 !== pathDigest(input.stateDir))
  ) {
    throw new Error("Hermes Portable uninstall state or registry path authority changed");
  }
  const names = expected
    ? expected.targets.map(({ sandboxName }) => sandboxName)
    : schema5SandboxNames(input);
  if (names.length === 0) throw new Error("Hermes Portable uninstall has no schema-5 targets");
  const registry = exactRegistry(input);
  const targetNames = new Set(names);
  const loaded = names.map((sandboxName): LoadedTarget => {
    const snapshot = readHermesPortableLifecycleReceipt(sandboxName, input.stateDir);
    if (!snapshot || snapshot.receipt.phase !== "active") {
      throw new Error(
        `Hermes Portable uninstall receipt '${sandboxName}' is missing or incomplete`,
      );
    }
    const receipt = snapshot.receipt;
    const row = registry.sandboxes[sandboxName] as SandboxEntry | undefined;
    if (!row) throw new Error(`Hermes Portable uninstall registry row '${sandboxName}' is missing`);
    requireSandboxRow(row, receipt);
    const expectedTarget = expected?.targets.find((target) => target.sandboxName === sandboxName);
    const lifecycleDeps: HermesPortableLifecycleDeps = {
      ...deps.lifecycle,
      env: input.env,
      stateDir: input.stateDir,
      readRegistry: (name) =>
        name === sandboxName ? (exactRegistry(input).sandboxes[name] as SandboxEntry) : null,
      ...(deps.podmanAuthorityDeps ? { podmanAuthorityDeps: deps.podmanAuthorityDeps } : {}),
    };
    const sandbox = prepareHermesPortableSandboxRemoval(
      sandboxName,
      {
        agent: "hermes",
        openshellDriver: "docker",
        gatewayName: receipt.gatewayName,
        lifecycleGeneration: receipt.lifecycleGeneration,
      },
      lifecycleDeps,
      {
        allowAbsent: admittedAbsence.sandbox,
        ...(expectedTarget ? { expectedReceiptSha256: expectedTarget.lifecycleReceiptSha256 } : {}),
      },
    );
    const runtime = createHermesPortableOllamaRuntimeAuthority({
      receipt,
      stateDir: input.stateDir,
      env: input.env,
      ...(deps.podmanAuthorityDeps ? { podmanAuthorityDeps: deps.podmanAuthorityDeps } : {}),
      ...(deps.captureGpuDevices ? { captureGpuDevices: deps.captureGpuDevices } : {}),
      ...(deps.captureCdiDevices ? { captureCdiDevices: deps.captureCdiDevices } : {}),
    });
    const inferenceRow = inferenceLifecycleRow(row, runtime.bundle.identity.id);
    const inference = prepareSandboxHostLocalInferenceDestroyAuthority(
      runtime.bundle,
      inferenceRow,
      {
        environment: input.env,
        homeDir: input.homeDir,
      },
    );
    if (!inference || !inference.receipt.publication) {
      throw new Error("Hermes Portable uninstall host-local inference authority is missing");
    }
    const registryPeers = [
      row,
      ...Object.values(registry.sandboxes)
        .filter((peer) => peer.name !== sandboxName && !targetNames.has(peer.name))
        .map((peer) => peer as SandboxEntry),
    ];
    const inferencePeers = registryPeers.map((peer) =>
      inferenceLifecycleRow(peer, runtime.bundle.identity.id),
    );
    const sharing = inspectPreparedHostLocalInferenceSharingAuthority(
      runtime.bundle,
      inferenceRow,
      inference,
      inferencePeers,
    );
    if (!admittedAbsence.inference || sharing.disposition === "shared") {
      assertPreparedHostLocalInferenceRuntimePresent(runtime.bundle, inferenceRow, inference);
    }
    const provider = prepareHermesPortableOllamaProviderRetirement({
      directory: runtime.inferenceStateDir,
      transactionId: inference.receipt.publication.transactionId,
      targetSha256: inference.receipt.publication.targetSha256,
      sandboxName,
      model: row.model!,
      credentialEnv: row.credentialEnv!,
      runGatewayOpenshell: gatewayRunner(receipt, input, deps),
      allowAbsent: admittedAbsence.provider,
    });
    const providerSharing = inspectProviderSharingAuthority(row, registryPeers);
    if (providerSharing.disposition === "shared" && !provider.present) {
      throw new Error("Hermes Portable shared gateway provider authority disappeared");
    }
    const authority = targetAuthority({
      input,
      row,
      receipt,
      snapshotSha256: snapshot.sha256,
      sandbox,
      provider,
      providerSharing,
      runtime,
      inference,
      sharing,
    });
    if (expectedTarget && !isDeepStrictEqual(authority, expectedTarget)) {
      throw new Error(`Hermes Portable uninstall authority drifted for '${sandboxName}'`);
    }
    return Object.freeze({
      row,
      inferenceRow,
      receipt,
      sandbox,
      provider,
      runtime,
      inference,
      inferencePeers,
      authority,
    });
  });
  const authority = Object.freeze({
    registryPathSha256: pathDigest(input.registryFile),
    statePathSha256: pathDigest(input.stateDir),
    targets: Object.freeze(loaded.map(({ authority }) => authority)),
  });
  if (expected && !isDeepStrictEqual(authority, expected)) {
    throw new Error("Hermes Portable uninstall transaction authority drifted");
  }
  return Object.freeze({ authority, registry, targets: Object.freeze(loaded) });
}

function requireCache(cache: LoadedAuthority | null): LoadedAuthority {
  if (!cache) throw new Error("Hermes Portable uninstall did not revalidate its authority");
  return cache;
}

/** Run schema-5 cleanup after the host fence, sorted lifecycle locks, and registry lock. */
export function runHermesPortableUninstall(
  input: HermesPortableUninstallInput,
  deps: HermesPortableUninstallDeps = {},
): HermesPortableUninstallTransactionResult {
  let cache: LoadedAuthority | null = null;
  return runHermesPortableUninstallTransaction(input.stateDir, {
    prepare: () => {
      cache = loadAuthority(input, deps, null, NO_RESOURCE_ABSENCE);
      return cache.authority;
    },
    prepareReplacement: () => {
      if (schema5SandboxNames(input).length === 0) return null;
      cache = loadAuthority(input, deps, null, NO_RESOURCE_ABSENCE);
      return cache.authority;
    },
    revalidateResources: (authority, phase) => {
      cache = loadAuthority(input, deps, authority, admittedResourceAbsence(phase));
    },
    reconcileSandboxes: () => {
      let removed = 0;
      for (const target of requireCache(cache).targets) {
        target.sandbox.removeAndVerify();
        if (target.sandbox.present) removed += 1;
      }
      return removed;
    },
    reconcileProviders: () => {
      for (const target of requireCache(cache).targets) {
        if (target.authority.provider.disposition === "remove") {
          target.provider.removeAndVerify();
        }
      }
    },
    reconcileInference: () => {
      for (const target of requireCache(cache).targets) {
        if (target.authority.inference.disposition === "preserve-shared") {
          assertPreparedHostLocalInferenceRuntimePresent(
            target.runtime.bundle,
            target.inferenceRow,
            target.inference,
          );
          continue;
        }
        const result = retirePreparedHostLocalInferenceAuthority(
          target.runtime.bundle,
          target.inferenceRow,
          target.inference,
          target.inferencePeers,
        );
        if (result.status === "shared" || result.status === "retained") {
          throw new Error("Hermes Portable inference retirement changed custody");
        }
      }
    },
    verifyResourcesAbsent: () => {
      for (const target of requireCache(cache).targets) {
        target.sandbox.verifyAbsent();
        if (target.authority.provider.disposition === "remove") target.provider.verifyAbsent();
        else if (!target.provider.present) {
          throw new Error("Hermes Portable shared provider disappeared during uninstall");
        }
        if (target.authority.inference.disposition === "preserve-shared") {
          assertPreparedHostLocalInferenceRuntimePresent(
            target.runtime.bundle,
            target.inferenceRow,
            target.inference,
          );
        }
      }
    },
    retireRegistry: (authority) => retireRegistryRows(input, authority),
    retireLifecycleReceipts: (authority) => {
      verifyRegistryRetired(input, authority);
      for (const target of authority.targets) {
        retireExactDirectory(
          hermesPortableReceiptDirectory(target.sandboxName, input.stateDir),
          target.lifecycleDirectorySha256,
        );
      }
    },
    retirePrivateInferenceState: (authority) => {
      verifyRegistryRetired(input, authority);
      for (const target of authority.targets) {
        const currentReceipt = readHermesPortableLifecycleReceipt(
          target.sandboxName,
          input.stateDir,
        );
        if (currentReceipt) {
          throw new Error(
            `Hermes Portable lifecycle receipt '${target.sandboxName}' remained after retirement`,
          );
        }
        if (target.provider.disposition === "remove" && target.inference.disposition === "remove") {
          retireExactDirectory(
            inferenceDirectory(target.sandboxName, input.stateDir),
            target.inference.directorySha256,
          );
        }
      }
    },
    verifyCompleted: (authority) => {
      verifyRegistryRetired(input, authority);
      for (const target of authority.targets) {
        if (readHermesPortableLifecycleReceipt(target.sandboxName, input.stateDir)) {
          throw new Error(
            `Hermes Portable completed journal found receipt replacement '${target.sandboxName}'`,
          );
        }
        const privateState = directoryAuthoritySha256(
          inferenceDirectory(target.sandboxName, input.stateDir),
        );
        if (
          target.provider.disposition === "remove" &&
          target.inference.disposition === "remove" &&
          privateState !== null
        ) {
          throw new Error(
            `Hermes Portable completed journal found inference state replacement '${target.sandboxName}'`,
          );
        }
        if (
          (target.provider.disposition === "preserve-shared" ||
            target.inference.disposition === "preserve-shared") &&
          privateState !== target.inference.directorySha256
        ) {
          throw new Error(
            `Hermes Portable completed journal found shared recovery authority drift '${target.sandboxName}'`,
          );
        }
      }
    },
    ...(deps.afterPhaseAction ? { afterPhaseAction: deps.afterPhaseAction } : {}),
  });
}
