// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildSelectedOpenShellSubprocessEnv } from "../../adapters/openshell/command-argv";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { resolveRegisteredAgentDefinition } from "../../agent/runtime";
import {
  createCliOpenShellSandboxLifecycleFromRunner,
  createCliOpenShellSandboxLookupFromRunner,
  type SandboxDeleteConvergenceResult,
  waitForSandboxDeleteAbsence,
} from "../../adapters/openshell/sandbox-lifecycle-cli";
import type { OpenShellSandboxDeleteSubmission } from "../../adapters/openshell/sandbox-lifecycle";
import { inspectOpenShellSandboxIdentityFingerprint } from "../../adapters/openshell/sandbox-identity-cli";
import {
  type PreparedPortableDemoSandboxDestroyAuthority,
  preparePortableDemoSandboxDestroyAuthority,
  removePortableDemoSandboxLifecycleReceipt,
} from "../../onboard/experimental/portable-demo-lifecycle";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  requireRuntimeProviderDestructiveCleanupAuthority,
  resolveRuntimeProviderBundle,
} from "../../onboard/runtime-provider/access";
import type {
  RuntimeProviderDestroyIdentityReceipt,
  RuntimeProviderPrivilegedSandboxCommandResult,
  RuntimeProviderStoppedSandboxStateCleanupResult,
} from "../../onboard/runtime-provider/contract";
import {
  type HostLocalInferenceLifecycleOptions,
  type PreparedHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceDestroyAuthority,
  retirePreparedHostLocalInferenceAuthority,
} from "../../onboard/runtime-provider/host-local-inference-lifecycle";
import {
  type DetachSandboxProvidersResult,
  runSandboxProviderPreDeleteCleanup,
} from "../../onboard/sandbox-provider-cleanup";
import { redact, redactFull } from "../../security/redact";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import type { SandboxEntry } from "../../state/registry";
import {
  classifyDestroyContainerIdentity,
  isSameDestroyContainerIdentityProof,
  observeDestroyContainerIdentity,
  type DestroyContainerIdentityProof,
  type SandboxNameLabeledContainer,
} from "./destroy-presence";
import { removeExactOpenShellDockerSandboxContainers } from "../../onboard/openshell-docker-sandbox-containers";
import { type DestroyRunOpenshell, SANDBOX_DESTROY_TIMEOUT_MS } from "./destroy-gateway";
import {
  finalizeMcpBridgesAfterSandboxDelete,
  McpBridgeError,
  type McpDestroyPreparation,
  prepareMcpBridgesForAbsentSandboxDestroy,
  prepareMcpBridgesForDestroy,
  restoreMcpBridgesAfterDestroyAbort,
} from "./mcp-bridge";

export function redactDestroyError(error: unknown): string {
  return redactFull(error instanceof Error ? error.message : String(error));
}

const SANDBOX_NATIVE_ROOT = "/sandbox";
const COMPLETE_NATIVE_HOME_AGENTS = new Set(["hermes", "langchain-deepagents-code", "openclaw"]);

function requireNormalizedNativeRoot(agentName: string, configuredRoot: string): string {
  const normalized = path.posix.normalize(configuredRoot);
  if (
    normalized !== configuredRoot ||
    !path.posix.isAbsolute(configuredRoot) ||
    !normalized.startsWith(`${SANDBOX_NATIVE_ROOT}/`) ||
    !/^\/sandbox\/[A-Za-z0-9._/-]+$/u.test(normalized)
  ) {
    throw new Error(
      `Agent '${agentName}' has an unsafe native-home root; registry or manifest repair is required.`,
    );
  }
  return normalized;
}

function requireProtectedNativePath(relativePath: string, agentName: string): string {
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath ||
    path.posix.isAbsolute(relativePath) ||
    normalized === "." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      `Agent '${agentName}' has an unsafe user-managed path; registry or manifest repair is required.`,
    );
  }
  return `${SANDBOX_NATIVE_ROOT}/${normalized}`;
}

function protectedNativeHomeEntries(
  agentName: string,
  nativeRoot: string,
  userManagedFiles: readonly string[],
  hostMounts: SandboxEntry["hostMounts"],
): string[] {
  const protectedEntries = new Set<string>();
  for (const relativePath of userManagedFiles) {
    const managedPath = requireProtectedNativePath(relativePath, agentName);
    if (managedPath === nativeRoot || managedPath.startsWith(`${nativeRoot}/`)) {
      protectedEntries.add(managedPath);
    }
  }
  if (agentName === "langchain-deepagents-code") {
    for (const mount of hostMounts ?? []) {
      if (typeof mount.target !== "string") {
        throw new Error("Deep Agents host-mount target is invalid; registry repair is required.");
      }
      const normalized = path.posix.normalize(mount.target);
      const prefix = `${SANDBOX_NATIVE_ROOT}/`;
      if (normalized !== mount.target || !normalized.startsWith(prefix)) {
        throw new Error("Deep Agents host-mount target is invalid; registry repair is required.");
      }
      protectedEntries.add(normalized);
    }
  }
  return [...protectedEntries].sort();
}

export function wipeAgentNativeHome(
  sandboxName: string,
  agentName: string,
  runOpenshell: DestroyRunOpenshell,
  hostMounts: SandboxEntry["hostMounts"],
  runPrivileged?: (command: readonly string[]) => RuntimeProviderPrivilegedSandboxCommandResult,
  clearStoppedNativeHome?: (
    root: string,
    protectedPaths: readonly string[],
  ) => RuntimeProviderStoppedSandboxStateCleanupResult,
): void {
  if (!COMPLETE_NATIVE_HOME_AGENTS.has(agentName)) return;
  const agent = resolveRegisteredAgentDefinition({ agent: agentName });
  if (!agent) {
    throw new Error(
      `Agent '${agentName}' could not be resolved for native-home cleanup; registry or manifest repair is required.`,
    );
  }
  const nativeRoot =
    agentName === "langchain-deepagents-code"
      ? SANDBOX_NATIVE_ROOT
      : requireNormalizedNativeRoot(agentName, agent.configPaths.dir);
  const protectedEntries = protectedNativeHomeEntries(
    agentName,
    nativeRoot,
    agent.userManagedFiles,
    hostMounts,
  );
  const script = [
    "set -eu",
    `root='${nativeRoot}'`,
    'if [ ! -e "$root" ]; then exit 0; fi',
    'if [ ! -d "$root" ] || [ -L "$root" ]; then echo "unsafe agent native root" >&2; exit 20; fi',
    "is_exact_keep() {",
    '  candidate="$1"; shift',
    '  for keep in "$@"; do [ "$candidate" != "$keep" ] || return 0; done',
    "  return 1",
    "}",
    "is_keep_parent() {",
    '  candidate="$1"; shift',
    '  for keep in "$@"; do [ "${keep#"$candidate"/}" = "$keep" ] || return 0; done',
    "  return 1",
    "}",
    "clean_dir() {",
    "  local directory entry",
    '  directory="$1"; shift',
    '  for entry in "$directory"/.[!.]* "$directory"/..?* "$directory"/*; do',
    '    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '    if is_exact_keep "$entry" "$@"; then continue; fi',
    '    if is_keep_parent "$entry" "$@"; then',
    '      if [ ! -d "$entry" ] || [ -L "$entry" ]; then',
    '        echo "unsafe protected native-home ancestor" >&2',
    "        exit 21",
    "      fi",
    '      clean_dir "$entry" "$@"',
    "    else",
    '      rm -rf -- "$entry"',
    "    fi",
    "  done",
    "}",
    "verify_dir() {",
    "  local directory entry",
    '  directory="$1"; shift',
    '  for entry in "$directory"/.[!.]* "$directory"/..?* "$directory"/*; do',
    '    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '    if is_exact_keep "$entry" "$@"; then continue; fi',
    '    if is_keep_parent "$entry" "$@"; then',
    '      if [ ! -d "$entry" ] || [ -L "$entry" ]; then return 1; fi',
    '      verify_dir "$entry" "$@" || return 1',
    "    else",
    "      return 1",
    "    fi",
    "  done",
    "}",
    'clean_dir "$root" "$@"',
    'if ! verify_dir "$root" "$@"; then',
    '  echo "agent native root retains sandbox-owned state" >&2',
    "  exit 22",
    "fi",
  ].join("\n");
  const command = ["sh", "-c", script, "nemoclaw-native-home-cleanup", ...protectedEntries];
  let result: {
    readonly status: number | null;
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly error?: Error;
  } = runOpenshell(["sandbox", "exec", "--name", sandboxName, "--", ...command], {
    ignoreError: true,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SANDBOX_DESTROY_TIMEOUT_MS,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(
      `${agent.displayName} native-home cleanup timed out after ${String(SANDBOX_DESTROY_TIMEOUT_MS / 1000)} seconds; its result is unknown.`,
    );
  }
  if (result.status !== 0 && result.status !== 20 && result.status !== 21 && runPrivileged) {
    try {
      result = runPrivileged(command);
    } catch (error) {
      if (clearStoppedNativeHome?.(nativeRoot, protectedEntries).cleared) return;
      throw error;
    }
  }
  if (
    result.status !== 0 &&
    result.status !== 20 &&
    result.status !== 21 &&
    clearStoppedNativeHome
  ) {
    const stoppedCleanup = clearStoppedNativeHome(nativeRoot, protectedEntries);
    if (stoppedCleanup.cleared) return;
  }
  if (result.status !== 0 || result.error) {
    const detail = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 500);
    throw new Error(
      `Could not remove the sandbox-owned ${agent.displayName} native home before sandbox deletion${detail ? `: ${detail}` : "."}`,
    );
  }
}

export function retirePortableLifecycleAuthority(sandboxName: string): void {
  removePortableDemoSandboxLifecycleReceipt(sandboxName);
}

export { preparePortableDemoSandboxDestroyAuthority };

type SandboxDestroyExecutionInput = {
  force: boolean;
  getSandbox?: (sandboxName: string) => SandboxEntry | null;
  listSandboxes?: () => { sandboxes: SandboxEntry[] };
  deleteGatewayName: string;
  runOpenshell: DestroyRunOpenshell;
  mcpRuntimeSelection?: McpDestroyPreparation["runtimeSelection"];
  sandbox: SandboxEntry | null;
  sandboxConfirmedAbsent: boolean;
  sandboxName: string;
  // `undefined` delegates identity gating to the runtime provider. An empty
  // array records confirmed absence; other arrays contain the immutable
  // Docker IDs qualified before destroy preparation.
  expectedContainerIdentities?: readonly SandboxNameLabeledContainer[];
  expectedContainerIdentityFingerprint?: string;
  expectedRuntimeProviderIdentity?: RuntimeProviderDestroyIdentityReceipt;
  portableContainerAuthority?: PreparedPortableDemoSandboxDestroyAuthority;
  verifyForwardPortsReleased?: () => boolean | Promise<boolean>;
  stopInferenceResources: () => void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  deps?: {
    hostLocalInferenceLifecycleOptions?: HostLocalInferenceLifecycleOptions;
    inspectOpenShellSandboxIdentityFingerprint?: typeof inspectOpenShellSandboxIdentityFingerprint;
    wipeAgentNativeHome?: typeof wipeAgentNativeHome;
    deleteConvergence?: {
      now?: () => number;
      sleep?: (milliseconds: number) => void;
    };
  };
};

export type SandboxDestroyExecutionResult =
  | {
      ok: true;
      alreadyGone: boolean;
      deleteOutput: string;
      deleteResult: OpenShellSandboxDeleteSubmission;
      detachOutcome: DetachSandboxProvidersResult;
      forcedLocalCleanup: boolean;
      runtimeSelection?: OpenShellRuntimeSelection;
      /** Common lifecycle conclusively retired this row's explicit llama.cpp claim. */
      commonLlamaCppAuthorityRetired?: true;
    }
  | {
      ok: false;
      deleteOutput: string;
      exitCode: number;
      gatewayUnreachable: boolean;
      timedOut?: true;
      hostLocalInferenceOwnershipRequiresGateway: boolean;
      mcpOwnershipRequiresGateway: boolean;
      mcpRecoveryFailure?: string;
      portableLifecycleOwnershipRequiresGateway?: boolean;
      hostLocalInferenceCleanupFailure?: string;
      deleteConfirmed?: boolean;
    };

function emptyMcpDestroyPreparation(
  runtimeSelection?: McpDestroyPreparation["runtimeSelection"],
): McpDestroyPreparation {
  return {
    entries: [],
    ...(runtimeSelection ? { runtimeSelection } : {}),
  };
}

async function prepareMcpDestroy(
  sandboxName: string,
  sandbox: SandboxEntry | null,
  sandboxConfirmedAbsent: boolean,
  force: boolean,
  runtimeSelection?: McpDestroyPreparation["runtimeSelection"],
): Promise<McpDestroyPreparation> {
  if (!sandbox) {
    return emptyMcpDestroyPreparation(runtimeSelection);
  }
  const preparation = sandboxConfirmedAbsent
    ? await prepareMcpBridgesForAbsentSandboxDestroy(sandboxName, {
        force,
        ...(runtimeSelection ? { runtimeSelection } : {}),
      })
    : await prepareMcpBridgesForDestroy(sandboxName, {
        force,
        sandbox,
        ...(runtimeSelection ? { runtimeSelection } : {}),
      });
  return preparation;
}

async function restoreMcpAfterDeleteAbort(
  sandboxName: string,
  preparation: McpDestroyPreparation,
): Promise<string | undefined> {
  try {
    await restoreMcpBridgesAfterDestroyAbort(sandboxName, preparation);
    return undefined;
  } catch (error) {
    return redactDestroyError(error);
  }
}

function describeAcceptedDeleteConvergenceFailure(
  sandboxName: string,
  gatewayName: string,
  convergence: SandboxDeleteConvergenceResult,
): Readonly<{
  deleteOutput: string;
  gatewayUnreachable: boolean;
  timedOut: boolean;
}> {
  const observation = convergence.lastObservation;
  const prefix = `OpenShell accepted deletion of sandbox '${sandboxName}', but`;
  const preserved = "Local recovery state was preserved.";
  if (observation?.ok && observation.value.state === "present") {
    const phase = observation.value.sandbox.phase ?? "unknown";
    return {
      deleteOutput:
        `${prefix} the final probe still observed it in phase '${phase}' on gateway '${gatewayName}'. ` +
        `${preserved} Inspect the sandbox on that gateway, then retry destroy.`,
      gatewayUnreachable: false,
      timedOut: false,
    };
  }
  if (observation?.ok === false && observation.error.kind === "transport") {
    return {
      deleteOutput:
        `${prefix} the final absence probe could not reach gateway '${gatewayName}': ` +
        `${observation.error.message} ${preserved} Restore gateway access, then retry destroy.`,
      gatewayUnreachable: true,
      timedOut: false,
    };
  }
  if (observation?.ok === false && observation.error.kind === "timeout") {
    return {
      deleteOutput:
        `${prefix} the final absence probe timed out on gateway '${gatewayName}'. ` +
        `${preserved} Check or start that gateway, then retry destroy.`,
      gatewayUnreachable: false,
      timedOut: true,
    };
  }
  if (observation?.ok === false) {
    return {
      deleteOutput:
        `${prefix} the final absence probe failed on gateway '${gatewayName}': ` +
        `${observation.error.message} ${preserved} Fix the reported gateway or CLI issue, then retry destroy.`,
      gatewayUnreachable: false,
      timedOut: false,
    };
  }
  return {
    deleteOutput:
      `${prefix} the final absence probe did not return a classified observation from gateway '${gatewayName}'. ` +
      `${preserved} Restore gateway access, then retry destroy.`,
    gatewayUnreachable: false,
    timedOut: false,
  };
}

async function finalizeMcpDestroy(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  force: boolean,
): Promise<void> {
  await finalizeMcpBridgesAfterSandboxDelete(sandboxName, preparation, {
    force,
  });
}

export async function executeSandboxDestroy({
  force,
  getSandbox,
  listSandboxes,
  deleteGatewayName,
  runOpenshell,
  mcpRuntimeSelection,
  sandbox,
  sandboxConfirmedAbsent,
  sandboxName,
  expectedContainerIdentities,
  expectedContainerIdentityFingerprint,
  expectedRuntimeProviderIdentity,
  portableContainerAuthority,
  verifyForwardPortsReleased = () => true,
  stopInferenceResources,
  runtimeProviders = CURRENT_RUNTIME_PROVIDER_BUNDLES,
  deps = {},
}: SandboxDestroyExecutionInput): Promise<SandboxDestroyExecutionResult> {
  return withMcpLifecycleLock(sandboxName, async () => {
    let destroyRuntimeSelection = mcpRuntimeSelection;
    type IdentityContinuity =
      | { status: "match" }
      | { status: "changed"; subject?: string }
      | { status: "ambiguous"; detail: string; subject?: string }
      | { status: "probe-failed"; detail: string; subject?: string };
    const identityProvider = resolveRuntimeProviderBundle(
      sandbox?.openshellDriver ?? expectedRuntimeProviderIdentity?.providerId,
      runtimeProviders,
    );
    const pendingCreateIdentity = sandbox?.pendingCreateIdentity;
    const expectedSandboxIdentityFingerprint =
      pendingCreateIdentity?.sandboxIdentityFingerprint ?? expectedContainerIdentityFingerprint;
    const expectedContainerProof: DestroyContainerIdentityProof = expectedRuntimeProviderIdentity
      ? {
          identities: undefined,
          providerIdentity: expectedRuntimeProviderIdentity,
        }
      : expectedContainerIdentities === undefined
        ? { identities: undefined }
        : { identities: expectedContainerIdentities };
    const proofFromVerdict = (
      verdict: ReturnType<typeof classifyDestroyContainerIdentity>,
    ): DestroyContainerIdentityProof | null => {
      if (verdict.status === "clear") {
        return {
          identities: verdict.identity === null ? [] : [verdict.identity],
        };
      }
      if (verdict.status === "recovery") return { identities: verdict.identities };
      return null;
    };
    const inspectSandboxIdentityContinuity = (): IdentityContinuity => {
      if (!expectedSandboxIdentityFingerprint) return { status: "match" };
      const subject = pendingCreateIdentity
        ? "Pending create sandbox identity"
        : "Retained sandbox identity";
      if (!getSandbox) {
        return {
          status: "probe-failed",
          subject,
          detail: "an exact registry reader is unavailable",
        };
      }
      const readCurrentCheckpoint = () => getSandbox(sandboxName)?.pendingCreateIdentity;
      try {
        if (!isDeepStrictEqual(readCurrentCheckpoint(), pendingCreateIdentity)) {
          return { status: "changed", subject: "Pending create identity" };
        }
        if (
          sandboxConfirmedAbsent &&
          (!pendingCreateIdentity ||
            (expectedContainerIdentities !== undefined &&
              expectedContainerIdentityFingerprint ===
                pendingCreateIdentity.sandboxIdentityFingerprint))
        ) {
          return isDeepStrictEqual(readCurrentCheckpoint(), pendingCreateIdentity)
            ? { status: "match" }
            : { status: "changed", subject: "Pending create identity" };
        }
        const inspectIdentity =
          deps.inspectOpenShellSandboxIdentityFingerprint ??
          inspectOpenShellSandboxIdentityFingerprint;
        const liveFingerprint = inspectIdentity({
          sandboxName,
          gatewayName: pendingCreateIdentity?.gatewayName ?? deleteGatewayName,
          ...(destroyRuntimeSelection ? { runtimeSelection: destroyRuntimeSelection } : {}),
        });
        if (
          liveFingerprint !== expectedSandboxIdentityFingerprint ||
          !isDeepStrictEqual(readCurrentCheckpoint(), pendingCreateIdentity)
        ) {
          return {
            status: "changed",
            subject,
          };
        }
        return { status: "match" };
      } catch (error) {
        return {
          status: "probe-failed",
          subject,
          detail: redactDestroyError(error),
        };
      }
    };
    const inspectIdentityContinuity = (): IdentityContinuity => {
      const sandboxContinuity = inspectSandboxIdentityContinuity();
      if (sandboxContinuity.status !== "match") return sandboxContinuity;
      if (portableContainerAuthority) {
        try {
          portableContainerAuthority.revalidate();
          return { status: "match" };
        } catch (error) {
          return { status: "probe-failed", detail: redactDestroyError(error) };
        }
      }
      if (expectedRuntimeProviderIdentity) {
        if (identityProvider?.cleanup.supported !== true) {
          return {
            status: "probe-failed",
            detail: "the selected runtime provider has no destroy identity observer",
          };
        }
        try {
          const captureBySandbox = identityProvider.cleanup.captureDestroyIdentity;
          const actual =
            sandbox?.openshellDriver?.trim() && captureBySandbox
              ? captureBySandbox({ sandbox, sandboxName })
              : identityProvider.cleanup.captureDestroyIdentityByName?.(sandboxName);
          if (!actual) {
            return {
              status: "probe-failed",
              detail: "the selected runtime provider has no destroy identity observer",
            };
          }
          return actual.schemaVersion === expectedRuntimeProviderIdentity.schemaVersion &&
            actual.providerId === expectedRuntimeProviderIdentity.providerId &&
            actual.resourceHandle === expectedRuntimeProviderIdentity.resourceHandle &&
            actual.ownershipSha256 === expectedRuntimeProviderIdentity.ownershipSha256
            ? { status: "match" }
            : { status: "changed" };
        } catch (error) {
          return { status: "probe-failed", detail: redactDestroyError(error) };
        }
      }
      if (expectedContainerIdentities === undefined) return { status: "match" };
      const verdict = classifyDestroyContainerIdentity(
        sandboxName,
        observeDestroyContainerIdentity(sandboxName),
        expectedContainerIdentityFingerprint,
      );
      const actualContainerProof = proofFromVerdict(verdict);
      if (
        actualContainerProof &&
        isSameDestroyContainerIdentityProof(expectedContainerProof, actualContainerProof)
      ) {
        return { status: "match" };
      }
      if (verdict.status === "probe-failed") {
        return {
          status: "probe-failed",
          detail: redactDestroyError(verdict.detail),
        };
      }
      if (verdict.status === "ambiguous") {
        return {
          status: "ambiguous",
          detail: redactDestroyError(verdict.reason),
        };
      }
      return { status: "changed" };
    };
    const identityRefusalResult = (
      phase: string,
      continuity: Exclude<IdentityContinuity, { status: "match" }>,
      mcpRecoveryFailure?: string,
      earlierCleanupDetail = "",
    ): SandboxDestroyExecutionResult => {
      const subject = continuity.subject ?? "Container identity";
      return {
        ok: false,
        deleteOutput:
          continuity.status === "probe-failed"
            ? `${subject} could not be inspected ${phase}: ${continuity.detail}. No sandbox delete was attempted.${earlierCleanupDetail}`
            : continuity.status === "ambiguous"
              ? `${subject} became ambiguous ${phase}: ${continuity.detail}. No sandbox delete was attempted.${earlierCleanupDetail}`
              : `${subject} changed ${phase}; no sandbox delete was attempted.${earlierCleanupDetail}`,
        exitCode: 1,
        gatewayUnreachable: false,
        hostLocalInferenceOwnershipRequiresGateway: false,
        mcpOwnershipRequiresGateway: false,
        mcpRecoveryFailure,
      };
    };
    const initialContinuity = inspectIdentityContinuity();
    if (initialContinuity.status !== "match") {
      return identityRefusalResult("before destroy preparation", initialContinuity);
    }
    // A receipt alone is not a llama.cpp lifecycle discriminator. Explicit
    // provenance selects the common coordinator; an unmarked schema-v1 receipt
    // remains on its established cleanup path.
    const hasHostLocalInferenceOwnership = typeof sandbox?.hostLocalInferenceReceipt === "string";
    let runtimeProvider: RuntimeProviderBundle | null = null;
    let hostLocalInferenceAuthority: PreparedHostLocalInferenceAuthority | null = null;
    let commonLlamaCppAuthorityRetired = false;
    if (sandbox) {
      try {
        runtimeProvider = requireRuntimeProviderDestructiveCleanupAuthority(
          sandboxName,
          sandbox,
          runtimeProviders,
        ).provider;
        hostLocalInferenceAuthority = prepareSandboxHostLocalInferenceDestroyAuthority(
          runtimeProvider,
          sandbox,
          deps.hostLocalInferenceLifecycleOptions,
        );
        if (hasHostLocalInferenceOwnership && (!getSandbox || !listSandboxes)) {
          throw new Error(
            "Exact registry readers are required to retire durable host-local inference authority.",
          );
        }
      } catch (error) {
        return {
          ok: false as const,
          deleteOutput: redactDestroyError(error),
          exitCode: 1,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
        };
      }
    }
    let mcpPreparation: McpDestroyPreparation;
    try {
      mcpPreparation = await prepareMcpDestroy(
        sandboxName,
        sandbox,
        sandboxConfirmedAbsent,
        force,
        mcpRuntimeSelection,
      );
    } catch (error) {
      if (error instanceof McpBridgeError) {
        return {
          ok: false as const,
          deleteOutput: redactDestroyError(error),
          exitCode: error.exitCode,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
        };
      }
      throw error;
    }
    if (
      mcpRuntimeSelection &&
      !isDeepStrictEqual(mcpPreparation.runtimeSelection, mcpRuntimeSelection)
    ) {
      return {
        ok: false as const,
        deleteOutput: "MCP destroy target changed after preflight.",
        exitCode: 1,
        gatewayUnreachable: false,
        hostLocalInferenceOwnershipRequiresGateway: false,
        mcpOwnershipRequiresGateway: false,
      };
    }
    destroyRuntimeSelection = mcpPreparation.runtimeSelection;
    const selectedRunOpenshell: DestroyRunOpenshell = destroyRuntimeSelection
      ? (args, options = {}) =>
          runOpenshell(args, {
            ...options,
            env: buildSelectedOpenShellSubprocessEnv(destroyRuntimeSelection!),
            replaceEnv: true,
          })
      : runOpenshell;
    // Prepared-only/incomplete adds have no external resources and are safely
    // discarded during preparation. Remaining entries are the durable exact
    // provider ownership manifest and must survive an unconfirmed delete.
    const hasMcpOwnership = mcpPreparation.entries.length > 0;
    const restoreMcpForAbort = async (): Promise<string | undefined> =>
      sandboxConfirmedAbsent
        ? undefined
        : await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation);
    const preparedContinuity = inspectIdentityContinuity();
    if (preparedContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort();
      return identityRefusalResult(
        "during destroy preparation",
        preparedContinuity,
        mcpRecoveryFailure,
      );
    }
    if (!hasHostLocalInferenceOwnership) {
      try {
        stopInferenceResources();
      } catch (error) {
        const mcpRecoveryFailure = await restoreMcpForAbort();
        return {
          ok: false,
          deleteOutput:
            `Could not stop managed inference resources before sandbox deletion: ${redactDestroyError(error)}. ` +
            "No provider cleanup or sandbox deletion was attempted.",
          exitCode: 1,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
          mcpRecoveryFailure,
        };
      }
    }
    const postInferenceContinuity = inspectIdentityContinuity();
    if (postInferenceContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort();
      return identityRefusalResult(
        "after managed inference cleanup",
        postInferenceContinuity,
        mcpRecoveryFailure,
        " Managed inference cleanup may already be partial; inspect or restart its resources before retrying.",
      );
    }
    const sandboxRuntimeConfirmedAbsent =
      expectedContainerIdentities?.length === 0 ||
      (expectedContainerIdentities === undefined && sandboxConfirmedAbsent);
    if (sandbox && !sandboxRuntimeConfirmedAbsent) {
      try {
        const registeredSandboxNames = new Set([sandboxName]);
        for (const entry of listSandboxes?.().sandboxes ?? []) {
          if (typeof entry.name === "string" && entry.name) registeredSandboxNames.add(entry.name);
        }
        let runPrivileged:
          | ((command: readonly string[]) => RuntimeProviderPrivilegedSandboxCommandResult)
          | undefined;
        let clearStoppedNativeHome:
          | ((
              root: string,
              protectedPaths: readonly string[],
            ) => RuntimeProviderStoppedSandboxStateCleanupResult)
          | undefined;
        if (runtimeProvider?.lifecycle.supported === true) {
          const control = runtimeProvider.lifecycle.privilegedSandboxControl;
          runPrivileged = (command) =>
            control.execute({
              sandbox,
              sandboxName,
              registeredSandboxNames: [...registeredSandboxNames],
              command,
              sanitizeEnvironment: true,
              timeoutMs: SANDBOX_DESTROY_TIMEOUT_MS,
              maxOutputBytes: 1024 * 1024,
              ...(expectedRuntimeProviderIdentity?.resourceHandle
                ? { expectedResourceHandle: expectedRuntimeProviderIdentity.resourceHandle }
                : {}),
            });
          if (control.clearStoppedNativeHome) {
            clearStoppedNativeHome = (root, protectedPaths) =>
              control.clearStoppedNativeHome!({
                sandbox,
                sandboxName,
                registeredSandboxNames: [...registeredSandboxNames],
                ...(expectedRuntimeProviderIdentity?.resourceHandle
                  ? { expectedResourceHandle: expectedRuntimeProviderIdentity.resourceHandle }
                  : {}),
                root,
                protectedPaths,
              });
          }
        }
        (deps.wipeAgentNativeHome ?? wipeAgentNativeHome)(
          sandboxName,
          sandbox.agent || "openclaw",
          selectedRunOpenshell,
          sandbox.hostMounts,
          runPrivileged,
          clearStoppedNativeHome,
        );
      } catch (error) {
        const mcpRecoveryFailure = await restoreMcpForAbort();
        return {
          ok: false,
          deleteOutput:
            `${redactDestroyError(error)} No provider cleanup or sandbox deletion was attempted. ` +
            "The sandbox registry entry was preserved so exact cleanup can be retried.",
          exitCode: 1,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
          mcpRecoveryFailure,
        };
      }
    }
    const detachProviders = (): Promise<DetachSandboxProvidersResult> =>
      runSandboxProviderPreDeleteCleanup(sandboxName, {
        runOpenshell: selectedRunOpenshell,
        redact,
      });
    const preProviderContinuity = inspectIdentityContinuity();
    if (preProviderContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort();
      return identityRefusalResult(
        "before provider cleanup",
        preProviderContinuity,
        mcpRecoveryFailure,
        " Managed inference cleanup may already have run; inspect those resources before retrying.",
      );
    }
    const detachOutcome: DetachSandboxProvidersResult = sandboxConfirmedAbsent
      ? { detached: [], failures: [] }
      : runtimeProvider?.cleanup.supported === true && sandbox
        ? await runtimeProvider.cleanup.prepareDestroy(
            { sandbox, sandboxName },
            { detachProviders },
          )
        : await detachProviders();
    // The final identity proof runs immediately before OpenShell delete. A
    // runtime administrator remains a trusted host authority; this closes the
    // multi-step window without claiming a cross-runtime transaction.
    const deleteBoundaryContinuity = inspectIdentityContinuity();
    if (deleteBoundaryContinuity.status !== "match") {
      const detachedDetail =
        detachOutcome.detached.length > 0
          ? ` Provider cleanup detached ${detachOutcome.detached.join(", ")}; rerun the owning setup workflow to restore those attachments.`
          : "";
      const mcpRecoveryFailure = await restoreMcpForAbort();
      return identityRefusalResult(
        "at the delete boundary",
        deleteBoundaryContinuity,
        mcpRecoveryFailure,
        ` Managed inference cleanup may already have run; inspect those resources before retrying.${detachedDetail}`,
      );
    }
    if (
      pendingCreateIdentity &&
      destroyRuntimeSelection &&
      pendingCreateIdentity.gatewayName !== destroyRuntimeSelection.gatewayName
    ) {
      const mcpRecoveryFailure = await restoreMcpForAbort();
      return {
        ok: false as const,
        deleteOutput: "Sandbox delete target changed during destroy preparation.",
        exitCode: 1,
        gatewayUnreachable: false,
        hostLocalInferenceOwnershipRequiresGateway: false,
        mcpOwnershipRequiresGateway: false,
        mcpRecoveryFailure,
      };
    }
    const effectiveDeleteGatewayName =
      pendingCreateIdentity?.gatewayName ??
      destroyRuntimeSelection?.gatewayName ??
      deleteGatewayName;
    // A successful preflight absence is already the required OpenShell
    // lifecycle proof. Do not issue a later mutable-name delete that could
    // target a same-name replacement created after that observation.
    const deleteResult: OpenShellSandboxDeleteSubmission = sandboxConfirmedAbsent
      ? { kind: "absent", diagnostic: "", exitCode: 1 }
      : await createCliOpenShellSandboxLifecycleFromRunner(runOpenshell).deleteSandbox({
          sandboxName,
          target: { kind: "named", gatewayName: effectiveDeleteGatewayName },
          ...(destroyRuntimeSelection ? { runtimeSelection: destroyRuntimeSelection } : {}),
          timeoutMs: SANDBOX_DESTROY_TIMEOUT_MS,
        });
    let alreadyGone = sandboxConfirmedAbsent || deleteResult.kind === "absent";
    const gatewayUnreachable =
      deleteResult.kind === "failed" && deleteResult.error.kind === "transport";
    const timedOut = deleteResult.kind === "failed" && deleteResult.error.kind === "timeout";
    const deleteOutput =
      deleteResult.kind === "failed"
        ? deleteResult.diagnostic || deleteResult.error.message
        : deleteResult.diagnostic;
    if (
      !alreadyGone &&
      (deleteResult.kind === "accepted" ||
        (deleteResult.kind === "failed" && deleteResult.ambiguous))
    ) {
      const convergence = await waitForSandboxDeleteAbsence(
        sandboxName,
        effectiveDeleteGatewayName,
        createCliOpenShellSandboxLookupFromRunner(selectedRunOpenshell),
        () => undefined,
        deps.deleteConvergence,
      );
      alreadyGone = convergence.confirmed;
      if (!alreadyGone && deleteResult.kind === "accepted") {
        const mcpRecoveryFailure = await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation);
        const convergenceFailure = describeAcceptedDeleteConvergenceFailure(
          sandboxName,
          effectiveDeleteGatewayName,
          convergence,
        );
        return {
          ok: false as const,
          deleteOutput: convergenceFailure.deleteOutput,
          exitCode: 1,
          gatewayUnreachable: convergenceFailure.gatewayUnreachable,
          ...(convergenceFailure.timedOut ? { timedOut: true as const } : {}),
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
          mcpRecoveryFailure,
        };
      }
    }
    const deleteFailed = deleteResult.kind === "failed" && !alreadyGone;
    // Exact MCP, host-local inference, and Portable lifecycle ownership must
    // survive an unconfirmed remote deletion. Force may discard only a local
    // record that retains none of those cleanup authorities.
    const forcedLocalCleanup =
      deleteFailed &&
      deleteResult.kind === "failed" &&
      !deleteResult.ambiguous &&
      !alreadyGone &&
      gatewayUnreachable &&
      !timedOut &&
      force &&
      !hasMcpOwnership &&
      !hasHostLocalInferenceOwnership &&
      portableContainerAuthority === undefined;

    if (deleteFailed && !forcedLocalCleanup) {
      const mcpRecoveryFailure = sandboxConfirmedAbsent
        ? undefined
        : await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation);
      return {
        ok: false as const,
        deleteOutput,
        exitCode: deleteResult.exitCode || 1,
        gatewayUnreachable,
        ...(timedOut ? { timedOut: true as const } : {}),
        hostLocalInferenceOwnershipRequiresGateway:
          gatewayUnreachable && hasHostLocalInferenceOwnership,
        mcpOwnershipRequiresGateway: gatewayUnreachable && hasMcpOwnership,
        mcpRecoveryFailure,
        portableLifecycleOwnershipRequiresGateway:
          gatewayUnreachable && portableContainerAuthority !== undefined,
      };
    }

    if (!forcedLocalCleanup) {
      let portsReleased = false;
      try {
        portsReleased = await verifyForwardPortsReleased();
      } catch {
        portsReleased = false;
      }
      if (!portsReleased) {
        return {
          ok: false as const,
          deleteOutput:
            `OpenShell deleted sandbox '${sandboxName}', but its host forward ports did not release. ` +
            "The local sandbox record was preserved for recovery.",
          exitCode: 1,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
          shieldsRelockRequiresGateway: false,
          deleteConfirmed: true,
        };
      }
    }

    if (
      !forcedLocalCleanup &&
      (portableContainerAuthority || expectedContainerIdentities !== undefined)
    ) {
      try {
        if (portableContainerAuthority) {
          portableContainerAuthority.verifyAbsent();
        } else if (expectedContainerIdentities !== undefined) {
          removeExactOpenShellDockerSandboxContainers(
            sandboxName,
            expectedContainerIdentities.map(({ id }) => id),
            console.log,
          );
        }
      } catch (error) {
        const detail = redactDestroyError(error);
        return {
          ok: false as const,
          deleteOutput:
            `OpenShell reported sandbox '${sandboxName}' absent, but exact runtime ` +
            `cleanup failed: ${detail}. The local sandbox record was preserved for retry.`,
          exitCode: 1,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
          deleteConfirmed: true,
        };
      }
    }

    // The sandbox is confirmed gone, or --force is discarding only a local
    // record that has no retained exact ownership.
    if (!forcedLocalCleanup) {
      try {
        await finalizeMcpDestroy(sandboxName, mcpPreparation, force);
      } catch (error) {
        if (error instanceof McpBridgeError) {
          return {
            ok: false as const,
            deleteOutput: redactDestroyError(error),
            exitCode: error.exitCode,
            gatewayUnreachable: false,
            hostLocalInferenceOwnershipRequiresGateway: false,
            mcpOwnershipRequiresGateway: false,
          };
        }
        throw error;
      }
    }
    if (!forcedLocalCleanup && runtimeProvider && sandbox && hostLocalInferenceAuthority) {
      // Keep retirement after confirmed sandbox deletion: retiring first could
      // leave a still-live sandbox without inference when its delete fails.
      // The registry row is the durable cleanup journal. A retirement failure
      // returns before that row is removed, and a retry takes the already-gone
      // path to converge the provider's idempotent exact-runtime teardown.
      try {
        const current = getSandbox!(sandboxName);
        if (!current) {
          throw new Error(`sandbox '${sandboxName}' is no longer registered`);
        }
        retirePreparedHostLocalInferenceAuthority(
          runtimeProvider,
          current,
          hostLocalInferenceAuthority,
          listSandboxes!().sandboxes,
        );
        commonLlamaCppAuthorityRetired =
          hostLocalInferenceAuthority.receipt.service === "llama-cpp";
      } catch (error) {
        return {
          ok: false as const,
          deleteOutput,
          exitCode: 1,
          gatewayUnreachable: false,
          hostLocalInferenceOwnershipRequiresGateway: false,
          mcpOwnershipRequiresGateway: false,
          hostLocalInferenceCleanupFailure: redactDestroyError(error),
          deleteConfirmed: true,
        };
      }
    }
    return {
      ok: true as const,
      detachOutcome,
      deleteOutput,
      deleteResult,
      alreadyGone,
      forcedLocalCleanup,
      ...(destroyRuntimeSelection ? { runtimeSelection: destroyRuntimeSelection } : {}),
      ...(commonLlamaCppAuthorityRetired ? { commonLlamaCppAuthorityRetired: true as const } : {}),
    };
  });
}
