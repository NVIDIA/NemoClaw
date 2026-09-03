// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import { inspectOpenShellSandboxIdentityFingerprint } from "../../adapters/openshell/sandbox-identity-cli";
import { R, YW } from "../../cli/terminal-style";
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
import type { RuntimeProviderDestroyIdentityReceipt } from "../../onboard/runtime-provider/contract";
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
import { SandboxWorkspaceCleanupTimeoutError, wipeSandboxState } from "./wipe-state";

export function redactDestroyError(error: unknown): string {
  return redactFull(error instanceof Error ? error.message : String(error));
}

export function retirePortableLifecycleAuthority(sandboxName: string): void {
  removePortableDemoSandboxLifecycleReceipt(sandboxName);
}

export { preparePortableDemoSandboxDestroyAuthority };

type SandboxDestroyExecutionInput = {
  force: boolean;
  getSandbox?: (sandboxName: string) => SandboxEntry | null;
  listSandboxes?: () => { sandboxes: SandboxEntry[] };
  runOpenshell: DestroyRunOpenshell;
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
  verifyForwardPortsReleased?: () => boolean;
  stopInferenceResources: () => void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  deps?: {
    hostLocalInferenceLifecycleOptions?: HostLocalInferenceLifecycleOptions;
    inspectOpenShellSandboxIdentityFingerprint?: typeof inspectOpenShellSandboxIdentityFingerprint;
    wipeSandboxState?: typeof wipeSandboxState;
  };
};

export type SandboxDestroyExecutionResult =
  | {
      ok: true;
      alreadyGone: boolean;
      deleteOutput: string;
      deleteResult: ReturnType<DestroyRunOpenshell>;
      detachOutcome: DetachSandboxProvidersResult;
      forcedLocalCleanup: boolean;
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

function emptyMcpDestroyPreparation(): McpDestroyPreparation {
  return {
    entries: [],
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: false,
  };
}

async function prepareMcpDestroy(
  sandboxName: string,
  sandbox: SandboxEntry | null,
  sandboxConfirmedAbsent: boolean,
  force: boolean,
): Promise<McpDestroyPreparation> {
  if (Object.keys(sandbox?.mcp?.bridges ?? {}).length === 0) {
    return emptyMcpDestroyPreparation();
  }
  const preparation = sandboxConfirmedAbsent
    ? await prepareMcpBridgesForAbsentSandboxDestroy(sandboxName, { force })
    : await prepareMcpBridgesForDestroy(sandboxName, { force });
  if (sandboxConfirmedAbsent && preparation.entries.length > 0) {
    console.warn(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' is already absent, so its retained-volume MCP adapter entry cannot be scrubbed in place. Exact OpenShell providers will be deleted so any stale credential placeholder cannot authenticate; same-name onboarding may need to replace stale MCP adapter config.`,
    );
  }
  return preparation;
}

function wipeLiveSandbox(
  sandboxName: string,
  sandboxRuntimeConfirmedAbsent: boolean,
  deps: NonNullable<SandboxDestroyExecutionInput["deps"]> = {},
): void {
  if (sandboxRuntimeConfirmedAbsent) return;
  (deps.wipeSandboxState ?? wipeSandboxState)(sandboxName);
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

async function finalizeMcpDestroy(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  force: boolean,
): Promise<void> {
  try {
    await finalizeMcpBridgesAfterSandboxDelete(sandboxName, preparation, { force });
  } catch (error) {
    const detail = redactDestroyError(error);
    console.error(
      `  Sandbox '${sandboxName}' is gone, but authenticated MCP provider cleanup is incomplete: ${detail}`,
    );
    console.error(
      "  MCP cleanup state was preserved. Re-run destroy to finish without requiring the host MCP secret environment variable.",
    );
    throw error;
  }
}

export async function executeSandboxDestroy({
  force,
  getSandbox,
  listSandboxes,
  runOpenshell,
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
    const expectedContainerProof: DestroyContainerIdentityProof = expectedRuntimeProviderIdentity
      ? { identities: undefined, providerIdentity: expectedRuntimeProviderIdentity }
      : expectedContainerIdentities === undefined
        ? { identities: undefined }
        : { identities: expectedContainerIdentities };
    const proofFromVerdict = (
      verdict: ReturnType<typeof classifyDestroyContainerIdentity>,
    ): DestroyContainerIdentityProof | null => {
      if (verdict.status === "clear") {
        return { identities: verdict.identity === null ? [] : [verdict.identity] };
      }
      if (verdict.status === "recovery") return { identities: verdict.identities };
      return null;
    };
    const inspectPendingCreateVerificationContinuity = (): IdentityContinuity => {
      if (!pendingCreateIdentity) return { status: "match" };
      if (!getSandbox) {
        return {
          status: "probe-failed",
          subject: "Pending create sandbox identity",
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
          expectedContainerIdentities !== undefined &&
          expectedContainerIdentityFingerprint === pendingCreateIdentity.sandboxIdentityFingerprint
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
          gatewayName: pendingCreateIdentity.gatewayName,
        });
        if (
          liveFingerprint !== pendingCreateIdentity.sandboxIdentityFingerprint ||
          !isDeepStrictEqual(readCurrentCheckpoint(), pendingCreateIdentity)
        ) {
          return {
            status: "changed",
            subject: "Pending create sandbox identity",
          };
        }
        return { status: "match" };
      } catch (error) {
        return {
          status: "probe-failed",
          subject: "Pending create sandbox identity",
          detail: redactDestroyError(error),
        };
      }
    };
    const inspectIdentityContinuity = (): IdentityContinuity => {
      const pendingContinuity = inspectPendingCreateVerificationContinuity();
      if (pendingContinuity.status !== "match") return pendingContinuity;
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
          const actual = sandbox
            ? identityProvider.cleanup.captureDestroyIdentity?.({ sandbox, sandboxName })
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
        return { status: "probe-failed", detail: redactDestroyError(verdict.detail) };
      }
      if (verdict.status === "ambiguous") {
        return { status: "ambiguous", detail: redactDestroyError(verdict.reason) };
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
      mcpPreparation = await prepareMcpDestroy(sandboxName, sandbox, sandboxConfirmedAbsent, force);
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
            "No workspace wipe, provider cleanup, or sandbox deletion was attempted.",
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
    // An empty `expectedContainerIdentities` is a completed Docker identity
    // probe with zero matching containers. `undefined` means this runtime
    // does not use that probe (or Portable owns identity); skip the workspace wipe
    // only when OpenShell already proved absence. A live labeled Docker
    // identity still requires a workspace wipe even if the OpenShell list says absent.
    const sandboxRuntimeConfirmedAbsent =
      expectedContainerIdentities?.length === 0 ||
      (expectedContainerIdentities === undefined && sandboxConfirmedAbsent);
    try {
      wipeLiveSandbox(sandboxName, sandboxRuntimeConfirmedAbsent, deps);
    } catch (error) {
      const mcpRecoveryFailure = await restoreMcpForAbort();
      const workspaceTimedOut = error instanceof SandboxWorkspaceCleanupTimeoutError;
      return {
        ok: false,
        deleteOutput:
          `${redactDestroyError(error)} No provider cleanup or sandbox deletion was attempted. ` +
          "Managed inference cleanup may already be partial; inspect or restart its resources before retrying.",
        exitCode: 1,
        gatewayUnreachable: false,
        ...(workspaceTimedOut ? { timedOut: true as const } : {}),
        hostLocalInferenceOwnershipRequiresGateway: false,
        mcpOwnershipRequiresGateway: false,
        mcpRecoveryFailure,
      };
    }
    const detachProviders = (): DetachSandboxProvidersResult =>
      runSandboxProviderPreDeleteCleanup(sandboxName, { runOpenshell, redact });
    const preProviderContinuity = inspectIdentityContinuity();
    if (preProviderContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort();
      return identityRefusalResult(
        "before provider cleanup",
        preProviderContinuity,
        mcpRecoveryFailure,
        " Managed inference cleanup and workspace wipe may already have run; inspect those resources before retrying.",
      );
    }
    const detachOutcome: DetachSandboxProvidersResult = sandboxConfirmedAbsent
      ? { detached: [], failures: [] }
      : runtimeProvider?.cleanup.supported === true && sandbox
        ? runtimeProvider.cleanup.prepareDestroy({ sandbox, sandboxName }, { detachProviders })
        : detachProviders();
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
        ` Managed inference cleanup and workspace wipe may already have run; inspect those resources before retrying.${detachedDetail}`,
      );
    }
    const deleteArgs = pendingCreateIdentity
      ? ["sandbox", "delete", "-g", pendingCreateIdentity.gatewayName, sandboxName]
      : ["sandbox", "delete", sandboxName];
    // A successful preflight absence is already the required OpenShell
    // lifecycle proof. Do not issue a later mutable-name delete that could
    // target a same-name replacement created after that observation.
    const deleteResult: ReturnType<DestroyRunOpenshell> = sandboxConfirmedAbsent
      ? { status: 0, stdout: "", stderr: "" }
      : runOpenshell(deleteArgs, {
          ignoreError: true,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: SANDBOX_DESTROY_TIMEOUT_MS,
        });
    const {
      output: capturedDeleteOutput,
      alreadyGone: deleteReportedAlreadyGone,
      gatewayUnreachable,
      timedOut,
    } = getSandboxDeleteOutcome(deleteResult);
    const alreadyGone = sandboxConfirmedAbsent || deleteReportedAlreadyGone;
    const deleteOutput = timedOut
      ? `OpenShell sandbox delete timed out after ${String(SANDBOX_DESTROY_TIMEOUT_MS / 1000)} seconds. Deletion could not be confirmed.`
      : capturedDeleteOutput;
    // Exact MCP, host-local inference, and Portable lifecycle ownership must
    // survive an unconfirmed remote deletion. Force may discard only a local
    // record that retains none of those cleanup authorities.
    const forcedLocalCleanup =
      deleteResult.status !== 0 &&
      !alreadyGone &&
      gatewayUnreachable &&
      !timedOut &&
      force &&
      !hasMcpOwnership &&
      !hasHostLocalInferenceOwnership &&
      portableContainerAuthority === undefined;

    if (deleteResult.status !== 0 && !alreadyGone && !forcedLocalCleanup) {
      const mcpRecoveryFailure = sandboxConfirmedAbsent
        ? undefined
        : await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation);
      return {
        ok: false as const,
        deleteOutput,
        exitCode: deleteResult.status || 1,
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
        portsReleased = verifyForwardPortsReleased();
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
      ...(commonLlamaCppAuthorityRetired ? { commonLlamaCppAuthorityRetired: true as const } : {}),
    };
  });
}
