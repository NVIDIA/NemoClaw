// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { R, YW } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
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
} from "../../onboard/runtime-provider/access";
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
import { withTimerBoundShieldsMutationLockAsync } from "../../shields/timer-bound-lock";
import { readTimerMarker } from "../../shields/timer-control";
import type { SandboxEntry } from "../../state/registry";
import {
  classifyDestroyContainerIdentity,
  isSameDestroyContainerIdentity,
  observeDestroyContainerIdentity,
  removeExactDestroyContainerIdentity,
  type SandboxNameLabeledContainer,
} from "./destroy-presence";
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
  cleanupShieldsArtifacts: (sandboxName: string) => void;
  force: boolean;
  getSandbox?: (sandboxName: string) => SandboxEntry | null;
  listSandboxes?: () => { sandboxes: SandboxEntry[] };
  runOpenshell: DestroyRunOpenshell;
  sandbox: SandboxEntry | null;
  sandboxConfirmedAbsent: boolean;
  sandboxName: string;
  // `undefined` delegates identity gating to the runtime provider.
  // `null` records confirmed absence; an object records the one managed
  // container observed by the pre-destroy guard.
  expectedContainerIdentity?: SandboxNameLabeledContainer | null;
  portableContainerAuthority?: PreparedPortableDemoSandboxDestroyAuthority;
  stopInferenceResources: () => void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  deps?: {
    hostLocalInferenceLifecycleOptions?: HostLocalInferenceLifecycleOptions;
    readTimerMarker?: typeof readTimerMarker;
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
      workspaceTimeoutRequiresShieldsRecovery?: true;
      hostLocalInferenceOwnershipRequiresGateway: boolean;
      mcpOwnershipRequiresGateway: boolean;
      mcpRecoveryFailure?: string;
      portableLifecycleOwnershipRequiresGateway?: boolean;
      shieldsRelockRequiresGateway: boolean;
      hostLocalInferenceCleanupFailure?: string;
      deleteConfirmed?: boolean;
    };

type HardenedDeleteState = {
  hardenedForDelete: boolean;
  hardeningFailed: boolean;
  timerProcessToken?: string;
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
    : await prepareMcpBridgesForDestroy(sandboxName);
  if (sandboxConfirmedAbsent && preparation.entries.length > 0) {
    console.warn(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' is already absent, so its retained-volume MCP adapter entry cannot be scrubbed in place. Exact OpenShell providers will be deleted so any stale credential placeholder cannot authenticate; same-name onboarding may need to replace stale MCP adapter config.`,
    );
  }
  return preparation;
}

function wipeAndHardenLiveSandbox(
  sandboxName: string,
  sandboxConfirmedAbsent: boolean,
  deps: NonNullable<SandboxDestroyExecutionInput["deps"]> = {},
): HardenedDeleteState {
  if (sandboxConfirmedAbsent) return { hardenedForDelete: false, hardeningFailed: false };

  // Wipe before delete while the retained volume is still mounted. The caller
  // holds the timer-bound lock across this phase and all following teardown.
  (deps.wipeSandboxState ?? wipeSandboxState)(sandboxName);
  const timerMarker = (deps.readTimerMarker ?? readTimerMarker)(sandboxName);
  if (!timerMarker) return { hardenedForDelete: false, hardeningFailed: false };

  const timerProcessToken = /^[0-9a-f]{32}$/.test(timerMarker.processToken ?? "")
    ? timerMarker.processToken
    : undefined;
  const { shieldsUp } = require("../../shields") as typeof import("../../shields");
  try {
    shieldsUp(sandboxName, {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
  } catch (error) {
    /**
     * SOURCE_OF_TRUTH
     * Invalid state: the locked OpenClaw config pair lost its `.config-hash`
     * integrity sidecar, so the guard refuses every lock transition and the
     * sandbox cannot be re-hardened (#7727).
     * Source boundary: the sidecar is removed out of band by host root inside
     * the sandbox (the reporter used a privileged runtime command). The
     * refusal itself belongs to `scripts/openclaw-config-guard.py`, which
     * repairs an absent hash only in lock-from-mutable mode and fail-stops in
     * the locked posture on purpose.
     * Source-fix constraint: NemoClaw cannot stop host root from deleting a
     * file inside the sandbox, and regenerating the hash from the current
     * bytes in the locked posture is exactly the tamper laundering the guard
     * exists to prevent — #7727 explicitly keeps that fail-closed. So destroy
     * cannot repair this state at its source; it can only stop treating a
     * best-effort hardening step as a precondition for removal.
     * Regression proof: destroy-flow.test.ts covers delete-proceeds-after-
     * failed-hardening, the emitted warning, timer cleanup ordering, and MCP
     * restore when the delete then fails.
     * Removal condition: drop this fallback when the config guard gains a
     * supported authenticated repair for a missing sidecar in the locked
     * posture, so a pre-delete `shieldsUp` can be required again.
     *
     * Hardening before delete narrows the open shields-down window; it is not
     * a precondition for removal. Deleting removes the unguarded config along
     * with the sandbox, so report the failure and continue.
     * `hardenedForDelete: false` keeps the delete-abort path honest: it will
     * not open a bounded shields-down rollback window it never closed.
     */
    // The auto-restore timer stays authoritative until deletion succeeds, for
    // the same reason `shieldsUp` keeps it through its own commit: revoking it
    // here would turn a delete that then fails into an unbounded mutable
    // window. At the absolute deadline it may stop this exact token-bound
    // destroy owner and its subprocesses before reclaiming the transition
    // lock, then restore lockdown. The token and process identity checks make
    // a mismatched owner fail closed instead of signaling an unrelated process.
    const detail = redact(error instanceof Error ? error.message : String(error));
    console.warn(
      `  ${YW}⚠${R} Could not re-lock shields for '${sandboxName}' before delete: ${detail}`,
    );
    console.warn(
      `  Continuing with delete: '${sandboxName}' and its unguarded config are removed together. ` +
        "If sandbox deletion fails, the auto-restore timer retries the transition to lockdown within its seven-attempt recovery budget. " +
        "Waiting for a verified live sandbox mutation owner does not consume that budget. " +
        "If the budget is exhausted, durable containment blocks sandbox mutations. " +
        `Run \`nemoclaw ${sandboxName} shields status\` for exact-generation recovery guidance.`,
    );
    return { hardenedForDelete: false, hardeningFailed: true, timerProcessToken };
  }
  return { hardenedForDelete: true, hardeningFailed: false, timerProcessToken };
}

async function restoreMcpAfterDeleteAbort(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  hardened: HardenedDeleteState,
): Promise<string | undefined> {
  let recoveryFailure: string | undefined;
  let openedRollbackWindow = false;
  try {
    if (hardened.hardenedForDelete && preparation.entries.length > 0) {
      if (!hardened.timerProcessToken) {
        throw new Error(
          "Cannot open a bounded MCP rollback window because the active shields timer had no valid process token.",
        );
      }
      const { shieldsDown } = require("../../shields") as typeof import("../../shields");
      shieldsDown(sandboxName, {
        reason: "restore MCP after refused sandbox delete",
        timeout: "15m",
        throwOnError: true,
        allowLegacyHermesProtocol: true,
        deferAutoRestoreWhileOwnerAlive: true,
        processToken: hardened.timerProcessToken,
      });
      openedRollbackWindow = true;
    }
    await restoreMcpBridgesAfterDestroyAbort(sandboxName, preparation);
  } catch (error) {
    recoveryFailure = redactDestroyError(error);
  } finally {
    if (openedRollbackWindow) {
      try {
        const { shieldsUp } = require("../../shields") as typeof import("../../shields");
        shieldsUp(sandboxName, {
          throwOnError: true,
          allowLegacyHermesProtocol: true,
        });
      } catch (error) {
        const detail = redactDestroyError(error);
        recoveryFailure = recoveryFailure
          ? `${recoveryFailure}; shields re-lock failed: ${detail}`
          : `shields re-lock failed: ${detail}`;
      }
    }
  }
  return recoveryFailure;
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
  cleanupShieldsArtifacts,
  force,
  getSandbox,
  listSandboxes,
  runOpenshell,
  sandbox,
  sandboxConfirmedAbsent,
  sandboxName,
  expectedContainerIdentity,
  portableContainerAuthority,
  stopInferenceResources,
  runtimeProviders = CURRENT_RUNTIME_PROVIDER_BUNDLES,
  deps = {},
}: SandboxDestroyExecutionInput): Promise<SandboxDestroyExecutionResult> {
  return withTimerBoundShieldsMutationLockAsync(sandboxName, "destroy sandbox", async () => {
    type IdentityContinuity =
      | { status: "match" }
      | { status: "changed" }
      | { status: "ambiguous"; detail: string }
      | { status: "probe-failed"; detail: string };
    const inspectIdentityContinuity = (): IdentityContinuity => {
      if (portableContainerAuthority) {
        try {
          portableContainerAuthority.revalidate();
          return { status: "match" };
        } catch (error) {
          return { status: "probe-failed", detail: redactDestroyError(error) };
        }
      }
      if (expectedContainerIdentity === undefined) return { status: "match" };
      const verdict = classifyDestroyContainerIdentity(
        sandboxName,
        observeDestroyContainerIdentity(sandboxName),
      );
      if (isSameDestroyContainerIdentity(expectedContainerIdentity, verdict)) {
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
    ): SandboxDestroyExecutionResult => ({
      ok: false,
      deleteOutput:
        continuity.status === "probe-failed"
          ? `Container identity could not be inspected ${phase}: ${continuity.detail}. No sandbox delete was attempted.${earlierCleanupDetail}`
          : continuity.status === "ambiguous"
            ? `Container identity became ambiguous ${phase}: ${continuity.detail}. No sandbox delete was attempted.${earlierCleanupDetail}`
            : `Container identity changed ${phase}; no sandbox delete was attempted.${earlierCleanupDetail}`,
      exitCode: 1,
      gatewayUnreachable: false,
      hostLocalInferenceOwnershipRequiresGateway: false,
      mcpOwnershipRequiresGateway: false,
      mcpRecoveryFailure,
      shieldsRelockRequiresGateway: false,
    });
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
          shieldsRelockRequiresGateway: false,
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
          shieldsRelockRequiresGateway: false,
        };
      }
      throw error;
    }
    // Prepared-only/incomplete adds have no external resources and are safely
    // discarded during preparation. Remaining entries are the durable exact
    // provider ownership manifest and must survive an unconfirmed delete.
    const hasMcpOwnership = mcpPreparation.entries.length > 0;
    const notHardened: HardenedDeleteState = {
      hardenedForDelete: false,
      hardeningFailed: false,
    };
    const restoreMcpForAbort = async (
      hardenedState: HardenedDeleteState,
    ): Promise<string | undefined> =>
      sandboxConfirmedAbsent
        ? undefined
        : await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation, hardenedState);
    const preparedContinuity = inspectIdentityContinuity();
    if (preparedContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort(notHardened);
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
        const mcpRecoveryFailure = await restoreMcpForAbort(notHardened);
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
          shieldsRelockRequiresGateway: false,
        };
      }
    }
    const postInferenceContinuity = inspectIdentityContinuity();
    if (postInferenceContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort(notHardened);
      return identityRefusalResult(
        "after managed inference cleanup",
        postInferenceContinuity,
        mcpRecoveryFailure,
        " Managed inference cleanup may already be partial; inspect or restart its resources before retrying.",
      );
    }
    let hardened: HardenedDeleteState;
    try {
      hardened = wipeAndHardenLiveSandbox(sandboxName, sandboxConfirmedAbsent, deps);
    } catch (error) {
      const mcpRecoveryFailure = await restoreMcpForAbort(notHardened);
      const workspaceTimedOut = error instanceof SandboxWorkspaceCleanupTimeoutError;
      const workspaceTimeoutRequiresShieldsRecovery =
        workspaceTimedOut && (deps.readTimerMarker ?? readTimerMarker)(sandboxName) !== null;
      return {
        ok: false,
        deleteOutput:
          `${redactDestroyError(error)} No provider cleanup or sandbox deletion was attempted. ` +
          "Managed inference cleanup may already be partial; inspect or restart its resources before retrying.",
        exitCode: 1,
        gatewayUnreachable: false,
        ...(workspaceTimedOut ? { timedOut: true as const } : {}),
        ...(workspaceTimeoutRequiresShieldsRecovery
          ? { workspaceTimeoutRequiresShieldsRecovery: true as const }
          : {}),
        hostLocalInferenceOwnershipRequiresGateway: false,
        mcpOwnershipRequiresGateway: false,
        mcpRecoveryFailure,
        shieldsRelockRequiresGateway: false,
      };
    }
    const detachProviders = (): DetachSandboxProvidersResult =>
      runSandboxProviderPreDeleteCleanup(sandboxName, { runOpenshell, redact });
    const preProviderContinuity = inspectIdentityContinuity();
    if (preProviderContinuity.status !== "match") {
      const mcpRecoveryFailure = await restoreMcpForAbort(hardened);
      return identityRefusalResult(
        "before provider cleanup",
        preProviderContinuity,
        mcpRecoveryFailure,
        " Managed inference cleanup and workspace wipe or hardening may already have run; inspect those resources before retrying.",
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
      const mcpRecoveryFailure = await restoreMcpForAbort(hardened);
      return identityRefusalResult(
        "at the delete boundary",
        deleteBoundaryContinuity,
        mcpRecoveryFailure,
        ` Managed inference cleanup and workspace wipe or hardening may already have run; inspect those resources before retrying.${detachedDetail}`,
      );
    }
    const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
      ignoreError: true,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SANDBOX_DESTROY_TIMEOUT_MS,
    });
    const {
      output: capturedDeleteOutput,
      alreadyGone,
      gatewayUnreachable,
      timedOut,
    } = getSandboxDeleteOutcome(deleteResult);
    const deleteOutput = timedOut
      ? `OpenShell sandbox delete timed out after ${String(SANDBOX_DESTROY_TIMEOUT_MS / 1000)} seconds. Deletion could not be confirmed.`
      : capturedDeleteOutput;
    // #7727: a failed pre-delete re-lock leaves the auto-restore timer as the
    // only authority that can lock the config again. Discarding the local
    // record here would revoke it for a sandbox the gateway never confirmed
    // deleting. The same applies to an exact host-local inference receipt: it
    // is the only durable authority that can retire the managed runtime. Thus
    // --force must not take the local-cleanup shortcut until the gateway is
    // back and deletion is confirmed.
    const forcedLocalCleanup =
      deleteResult.status !== 0 &&
      !alreadyGone &&
      gatewayUnreachable &&
      !timedOut &&
      force &&
      !hasMcpOwnership &&
      !hasHostLocalInferenceOwnership &&
      portableContainerAuthority === undefined &&
      !hardened.hardeningFailed;

    if (deleteResult.status !== 0 && !alreadyGone && !forcedLocalCleanup) {
      const mcpRecoveryFailure = sandboxConfirmedAbsent
        ? undefined
        : await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation, hardened);
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
        shieldsRelockRequiresGateway: gatewayUnreachable && hardened.hardeningFailed,
      };
    }

    if (!forcedLocalCleanup && (portableContainerAuthority || expectedContainerIdentity)) {
      try {
        if (portableContainerAuthority) {
          portableContainerAuthority.verifyAbsent();
        } else if (expectedContainerIdentity) {
          removeExactDestroyContainerIdentity(sandboxName, expectedContainerIdentity, console.log);
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
          shieldsRelockRequiresGateway: false,
          deleteConfirmed: true,
        };
      }
    }

    // The sandbox is confirmed gone, or --force is discarding only a local
    // record that has no retained exact ownership. Keep this under the
    // lifecycle lock so stale timer state cannot target a same-name
    // replacement.
    cleanupShieldsArtifacts(sandboxName);
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
            shieldsRelockRequiresGateway: false,
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
          shieldsRelockRequiresGateway: false,
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
