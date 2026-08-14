// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  parseOpenShellSandboxId,
  resolveOpenShellSandboxId,
} from "../adapters/openshell/sandbox-identity";
import { printSandboxCreateRecoveryHints } from "../build-context";
import { getSandboxDeleteOutcome } from "../domain/sandbox/destroy";
import { streamSandboxCreate } from "../sandbox/create-stream";
import { getReadyCheckOutputPatternsForAgent } from "../sandbox/create-stream-ready-gate";
import { getSandboxFailurePhase, isSandboxReady } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import { cliName } from "./branding";
import { reportSandboxCreateFailure } from "./created-sandbox-failure";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";
import { enforceManagedBootstrapRecoveryForSandbox } from "./managed-bootstrap/adapter";
import type { ManagedBootstrapRuntimeSnapshot } from "./managed-bootstrap/runtime-create";
import {
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "./openshell-docker-sandbox-containers";
import { printSandboxCreateFailureDiagnostics } from "./sandbox-create-failure";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";
import * as sandboxGpuPreflight from "./sandbox-gpu-preflight";
import type { CreatedSandboxReadyIdentityCheck } from "./sandbox-readiness-tracing";
import * as sandboxReadinessTracing from "./sandbox-readiness-tracing";
import { addTraceEvent } from "./tracing";

type NativeRuntimeSnapshot = ManagedBootstrapRuntimeSnapshot;

export type SandboxGpuCreateAttemptState = {
  firstCreateOutput: string;
  compatibilityArgv: string[] | null;
  allowUnbuiltCompatibilitySource: boolean;
  nativeRuntimeSnapshot: NativeRuntimeSnapshot | null;
};

// A runtime-managed container replacement can briefly observe the original
// container's stale Ready row. Require one confirmation poll before advancing
// to live validation or the GPU proof.
const REPLACEMENT_STABLE_READY_POLLS = 2;

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/gu;
const OPENSHELL_SANDBOX_NOT_READY =
  /^Error: code: 'The system is not in a state required for the operation's execution', message: "sandbox is not ready"$/iu;

type OpenShellCommandResult = ReturnType<SandboxGpuCreateFlowDeps["runOpenshell"]>;

function normalizedOpenShellCommandOutput(result: OpenShellCommandResult): string {
  return `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`
    .replace(ANSI_RE, "")
    .replace(/[×│]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

type OpenShellSandboxIdentityProbe =
  | { state: "identified"; sandboxId: string }
  | { state: "not_ready" }
  | { state: "failed" };

function probeExactOpenShellSandboxId(
  sandboxName: string,
  deps: SandboxGpuCreateFlowDeps,
): OpenShellSandboxIdentityProbe {
  const result = deps.runOpenshell(["sandbox", "get", sandboxName], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status === 0 && !result.error) {
    const sandboxId = parseOpenShellSandboxId(String(result.stdout ?? ""));
    return sandboxId ? { state: "identified", sandboxId } : { state: "failed" };
  }
  return OPENSHELL_SANDBOX_NOT_READY.test(normalizedOpenShellCommandOutput(result))
    ? { state: "not_ready" }
    : { state: "failed" };
}

function checkRecreatedSandboxReadyIdentity(
  sandboxName: string,
  expectedSandboxId: string,
  deps: SandboxGpuCreateFlowDeps,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const identity = probeExactOpenShellSandboxId(sandboxName, deps);
  if (identity.state === "not_ready") return "not_ready";
  if (identity.state === "failed") return "probe_failed";
  if (identity.sandboxId !== expectedSandboxId) return "identity_changed";
  const result = deps.runOpenshell(["sandbox", "exec", "--name", sandboxName, "--", "true"], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status === 0 && !result.error) return "ready";
  return OPENSHELL_SANDBOX_NOT_READY.test(normalizedOpenShellCommandOutput(result))
    ? "not_ready"
    : "probe_failed";
}

class ManagedBootstrapCreateStreamFailure extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof streamSandboxCreate>>) {
    super("Managed bootstrap held workload did not complete its create stream.");
  }
}

export function createSandboxGpuCreateAttemptRunner(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
) {
  const state: SandboxGpuCreateAttemptState = {
    firstCreateOutput: "",
    compatibilityArgv: null,
    allowUnbuiltCompatibilitySource: false,
    nativeRuntimeSnapshot: null,
  };
  const managedRouting = input.managedBootstrap?.runtimeProvider.bootstrap.createOnboardRouting({
    sandboxName: input.sandboxName,
    openshellArgv: deps.openshellArgv,
    nativeFallbackEnabled:
      input.initialGpuRoute === "native" && input.gpuRoutePlan === "native-with-fallback",
  });
  const nativeFallbackBaseline =
    !managedRouting &&
    input.initialGpuRoute === "native" &&
    input.gpuRoutePlan === "native-with-fallback"
      ? queryOpenShellDockerSandboxContainers(input.sandboxName)
      : null;
  const nativeFallbackHasCleanBaseline =
    managedRouting?.nativeFallbackHasCleanBaseline ??
    (nativeFallbackBaseline?.ok === true && nativeFallbackBaseline.ids.length === 0);
  const runAttempt = async (route: SelectedDockerGpuRoute) => {
    const compatibility = route === "compatibility";
    if (compatibility && input.initialGpuRoute === "native") {
      console.warn(
        "  Native OpenShell GPU onboarding did not complete; retrying once by recreating the OpenShell-managed Docker container with the legacy GPU compatibility envelope.",
      );
      console.warn(
        "  This compatibility container swap may relax container confinement compared with native injection. The retry is running only because NEMOCLAW_DOCKER_GPU_PATCH=fallback explicitly authorized it.",
      );
    }
    const hasRequiredUlimits = (input.requiredUlimits?.length ?? 0) > 0;
    const managedBootstrap = input.managedBootstrap ?? null;
    const attemptArgv = state.compatibilityArgv ?? input.createArgv;
    const managedLifecycle = managedBootstrap
      ? managedBootstrap.runtimeProvider.bootstrap.createLifecycle({
          providerId: managedBootstrap.runtimeProvider.identity.id,
          stateRoot: managedBootstrap.stateRoot,
          bootstrapIdentity: managedBootstrap.bootstrapIdentity,
          request: managedBootstrap.request,
          image: managedBootstrap.image,
          agentIdentity: managedBootstrap.agentIdentity,
          intendedWorkloadArgv: managedBootstrap.intendedWorkloadArgv,
          expectedSupervisorArgv: managedBootstrap.expectedSupervisorArgv,
          launchArgv: attemptArgv,
          heldWorkloadArgv: input.sandboxStartupCommand,
          authorityStore: managedBootstrap.authorityStore,
          ...(deps.createManagedBootstrapAdapter
            ? { adapterOverride: deps.createManagedBootstrapAdapter(managedBootstrap.stateRoot) }
            : {}),
          route,
          persistStartupCommand: input.persistStartupCommand === true,
          sandboxName: input.sandboxName,
          sandboxGpuConfig: input.sandboxGpuConfig,
          requiredLimits: input.requiredUlimits ?? [],
          timeoutSecs: input.sandboxReadyTimeoutSecs,
          network: {
            inferenceProvider: input.provider,
            gatewayUsesContainerBridge: input.dockerDriverGateway,
            gatewayPort: input.gatewayPort,
          },
          dependencies: {
            runCaptureOpenshell: deps.runCaptureOpenshell,
            runOpenshell: deps.runOpenshell,
            sleep: deps.sleep,
          },
        })
      : null;
    const inspectNativeRuntime = (): NativeRuntimeSnapshot | null => {
      const lifecycleSnapshot = managedLifecycle?.inspectNativeRuntime?.();
      if (lifecycleSnapshot !== undefined) return lifecycleSnapshot;
      if (managedRouting) return managedRouting.inspectNativeRuntime();
      const snapshot = queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName);
      return snapshot.ok ? snapshot : null;
    };
    const persistRestartSafeStartup =
      input.persistStartupCommand === true &&
      (route !== "native" || !input.terminalAgent || hasRequiredUlimits);
    const deferRestartSafeCutover =
      !managedLifecycle && !compatibility && persistRestartSafeStartup;
    const runtimePatch =
      managedLifecycle?.patch ??
      createDockerGpuSandboxCreatePatch({
        route,
        // The startup clone preserves native CDI devices, so non-terminal agents
        // keep their selected command and DCode can apply its exact required limits
        // without replacing the native GPU envelope. Native terminal agents without
        // required limits retain their create-time command.
        persistStartupCommand: persistRestartSafeStartup,
        externalRecreation: false,
        sandboxName: input.sandboxName,
        gpuDevice: input.sandboxGpuConfig.sandboxGpuDevice,
        openshellSandboxCommand: input.sandboxStartupCommand,
        requiredUlimits: input.requiredUlimits,
        timeoutSecs: input.sandboxReadyTimeoutSecs,
        backend: input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic",
        deps,
      });
    const recovery = await managedLifecycle?.recoverUnfinished();
    if (recovery) {
      enforceManagedBootstrapRecoveryForSandbox(recovery, input.sandboxName, (message) =>
        console.warn(`  ⚠ ${message}`),
      );
    }
    await managedLifecycle?.prepareNetwork();
    const [createExecutable, ...createExecutableArgs] = managedLifecycle?.launchArgv ?? attemptArgv;
    if (!createExecutable) throw new Error("Sandbox create executable is missing.");
    const streamCreate = () =>
      streamSandboxCreate(createExecutable, createExecutableArgs, input.sandboxEnv, {
        readyCheck: () => {
          const list = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
          return isSandboxReady(list, input.sandboxName);
        },
        onPoll: () => {
          if (!deferRestartSafeCutover) runtimePatch.maybeApplyDuringCreate();
        },
        readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent({
          isTerminalAgent: input.terminalAgent,
          startupRunsDuringCreate: managedLifecycle === null,
          env: input.sandboxEnv,
        }),
        failureCheck: runtimePatch.createFailureMessage,
        traceEvent: addTraceEvent,
        waitForReadyTermination: deferRestartSafeCutover,
        initialPhase:
          compatibility && (input.prebuild.imageRef || state.compatibilityArgv)
            ? "create"
            : undefined,
      });
    let createResult: Awaited<ReturnType<typeof streamSandboxCreate>>;
    let managedIncompleteCreateRecovered = false;
    if (managedBootstrap && managedLifecycle) {
      try {
        createResult = await managedLifecycle.runCreate(
          async ({ heldWorkloadArgv, bootstrapIdentity }) => {
            if (
              bootstrapIdentity !== managedBootstrap.bootstrapIdentity ||
              heldWorkloadArgv.length !== input.sandboxStartupCommand.length ||
              heldWorkloadArgv.some((value, index) => value !== input.sandboxStartupCommand[index])
            ) {
              throw new Error(
                "Managed bootstrap launch does not match the rendered identity-bound hold.",
              );
            }
            const result = await streamCreate();
            const createFailure =
              result.status === 0 ? null : classifySandboxCreateFailure(result.output);
            if (result.status !== 0 && createFailure?.kind !== "sandbox_create_incomplete") {
              throw new ManagedBootstrapCreateStreamFailure(result);
            }
            if (createFailure?.kind === "sandbox_create_incomplete") {
              const readiness = sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
                sandboxName: input.sandboxName,
                timeoutSecs: input.sandboxReadyTimeoutSecs,
                runCaptureOpenshell: deps.runCaptureOpenshell,
                isSandboxReady,
                getSandboxFailurePhase,
                stableReadyPolls: REPLACEMENT_STABLE_READY_POLLS,
                sleep: deps.sleep,
              });
              if (!readiness.ready) {
                throw new Error(
                  `Managed bootstrap incomplete create did not reach authoritative Ready state (${readiness.reason}).`,
                );
              }
            } else {
              const list = deps.runCaptureOpenshell(["sandbox", "list"], {
                ignoreError: true,
              });
              if (!isSandboxReady(list, input.sandboxName)) {
                throw new Error(
                  "Managed bootstrap create completed without an authoritative Ready sandbox.",
                );
              }
            }
            let sandboxId: string;
            try {
              sandboxId = resolveOpenShellSandboxId(input.sandboxName, deps.runCaptureOpenshell);
            } catch (error) {
              throw new Error(
                createFailure?.kind === "sandbox_create_incomplete"
                  ? "Managed bootstrap incomplete create did not return one exact durable sandbox identity after Ready."
                  : "Managed bootstrap create did not return one exact durable sandbox identity after Ready.",
                { cause: error },
              );
            }
            managedIncompleteCreateRecovered = createFailure?.kind === "sandbox_create_incomplete";
            return {
              value: result,
              receipt: {
                sandbox: {
                  sandboxName: input.sandboxName,
                  sandboxId,
                  driverId: managedBootstrap.runtimeProvider.identity.id,
                },
                ready: true,
                readyAt: new Date().toISOString(),
              },
            };
          },
        );
      } catch (error) {
        if (!(error instanceof ManagedBootstrapCreateStreamFailure)) throw error;
        createResult = error.result;
      }
    } else {
      createResult = await streamCreate();
    }
    if (!state.firstCreateOutput) state.firstCreateOutput = createResult.output;
    await runtimePatch.exitOnPatchError();
    if (createResult.status !== 0) {
      const failure = classifySandboxCreateFailure(createResult.output);
      if (failure.kind === "sandbox_create_incomplete") {
        console.warn("");
        if (managedIncompleteCreateRecovered) {
          console.warn(
            `  Create stream exited with code ${createResult.status}; the exact durable sandbox reached Ready, and onboarding is continuing with final checks.`,
          );
        } else {
          console.warn(
            `  Create stream exited with code ${createResult.status} after sandbox was created.`,
          );
          console.warn("  Checking whether the sandbox reaches Ready state...");
        }
      } else if (
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline &&
        (() => {
          if (
            managedRouting
              ? managedRouting.isNativeCreateRoutingFailure(
                  createResult.output,
                  createResult.sawProgress,
                )
              : sandboxGpuCreateAttempt.isNativeGpuCreateRoutingFailure(createResult.output, {
                  sawProgress: createResult.sawProgress,
                })
          ) {
            state.allowUnbuiltCompatibilitySource = input.prebuild.imageRef === null;
            return true;
          }
          const snapshot = inspectNativeRuntime();
          if (
            snapshot &&
            (managedRouting
              ? managedRouting.isTrustedNativeRuntimeError(snapshot.stateError)
              : sandboxGpuCreateAttempt.isTrustedNativeGpuRuntimeError(snapshot.stateError))
          ) {
            state.nativeRuntimeSnapshot = snapshot;
            return true;
          }
          return false;
        })()
      ) {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        return {
          ok: false,
          route,
          stage: "create",
          error: new Error("Native OpenShell GPU sandbox creation was rejected."),
          fallbackEligible: true,
        } as const;
      } else {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        reportSandboxCreateFailure(
          {
            sandboxName: input.sandboxName,
            createStatus: createResult.status,
            createOutput: createResult.output,
            restoreBackupPath: input.restoreBackupPath,
            createArgs: input.prebuild.createArgs,
          },
          {
            classifyCreateFailure: classifySandboxCreateFailure,
            printCreateFailureDiagnostics: printSandboxCreateFailureDiagnostics,
            printRecoveryHints: printSandboxCreateRecoveryHints,
            warn: (message) => console.warn(message),
            error: (message) => console.error(message),
            exitProcess: (code) => process.exit(code),
          },
        );
      }
    }
    const preRecreateIdentity = deferRestartSafeCutover
      ? probeExactOpenShellSandboxId(input.sandboxName, deps)
      : null;
    const expectedRecreatedSandboxId =
      preRecreateIdentity?.state === "identified" ? preRecreateIdentity.sandboxId : null;
    if (deferRestartSafeCutover && !expectedRecreatedSandboxId) {
      console.error("");
      console.error(
        `  Sandbox '${input.sandboxName}' reached Ready, but OpenShell did not return one exact durable sandbox ID before runtime recreation.`,
      );
      printSandboxCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      process.exit(createResult.status === 0 ? 1 : createResult.status);
    }
    await runtimePatch.ensureApplied();
    await runtimePatch.waitForSupervisorReconnectIfNeeded();
    console.log("  Waiting for sandbox to become ready...");
    const readiness = sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
      sandboxName: input.sandboxName,
      timeoutSecs: input.sandboxReadyTimeoutSecs,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      stableReadyPolls:
        compatibility || managedBootstrap || expectedRecreatedSandboxId
          ? REPLACEMENT_STABLE_READY_POLLS
          : 1,
      checkReadyIdentity: expectedRecreatedSandboxId
        ? () =>
            checkRecreatedSandboxReadyIdentity(input.sandboxName, expectedRecreatedSandboxId, deps)
        : undefined,
      sleep: deps.sleep,
    });
    if (!readiness.ready) {
      console.error("");
      sandboxReadinessTracing.printReadinessFailure(
        readiness,
        input.sandboxName,
        input.sandboxReadyTimeoutSecs,
      );
      const canClassifyNativeReadiness =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      const runtimeSnapshot = canClassifyNativeReadiness ? inspectNativeRuntime() : null;
      if (
        canClassifyNativeReadiness &&
        runtimeSnapshot &&
        (managedRouting
          ? managedRouting.isNativeReadinessRoutingFailure({
              failurePhase: readiness.failurePhase,
              runtimeError: runtimeSnapshot.stateError,
            })
          : sandboxGpuCreateAttempt.isNativeGpuReadinessRoutingFailure({
              failurePhase: readiness.failurePhase,
              runtimeError: runtimeSnapshot.stateError,
            }))
      ) {
        state.nativeRuntimeSnapshot = runtimeSnapshot;
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        return {
          ok: false,
          route,
          stage: "readiness",
          error: new Error(
            `Native OpenShell GPU sandbox did not become ready${readiness.failurePhase ? ` (${readiness.failurePhase})` : ""}.`,
          ),
          fallbackEligible: true,
        } as const;
      }
      await runtimePatch.rollbackManagedStartupAfterCreateFailure();
      printSandboxCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      if (compatibility) runtimePatch.printReadinessFailureIfEnabled();
      else if (expectedRecreatedSandboxId) {
        console.error(
          "  NemoClaw did not start dashboard forwarding. NemoClaw left the sandbox in place for inspection and recovery.",
        );
      } else {
        const deletion = deps.runOpenshell(["sandbox", "delete", input.sandboxName], {
          ignoreError: true,
          suppressOutput: true,
        });
        const { alreadyGone } = getSandboxDeleteOutcome({
          status: deletion.status ?? null,
          stdout: String(deletion.stdout ?? ""),
          stderr: String(deletion.stderr ?? ""),
        });
        if (Number(deletion.status ?? 1) !== 0 && !alreadyGone) {
          console.error("  The failed sandbox could not be removed automatically.");
          console.error(`  Manual cleanup: openshell sandbox delete "${input.sandboxName}"`);
        } else console.error(`  Retry: ${cliName()} onboard`);
      }
      process.exit(createResult.status === 0 ? 1 : createResult.status);
    }
    if (input.sandboxGpuConfig.sandboxGpuEnabled) {
      const deferNativeProofFailure =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      let proof: SandboxGpuProofResult;
      try {
        proof = await dockerGpuLocalInference.verifyGpuSandboxAccessAfterReady(
          input.sandboxGpuConfig,
          {
            sandboxName: input.sandboxName,
            dockerDriverGateway: input.dockerDriverGateway,
            selectedRoute: route,
            verifyDirectSandboxGpu: deps.verifyDirectSandboxGpu,
            verifyGpuOrExit: deferNativeProofFailure ? undefined : runtimePatch.verifyGpuOrExit,
            reportGpuProofFailure: !deferNativeProofFailure,
            selectedMode: runtimePatch.selectedMode,
            runCaptureOpenshell: deps.runCaptureOpenshell,
            log: console.log,
          },
        );
      } catch (error) {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        throw error;
      }
      if (deferNativeProofFailure && proof.status === "failed") {
        if (sandboxGpuPreflight.isExplicitNvidiaSmiDriverProofFailure(proof)) {
          const snapshot = inspectNativeRuntime();
          if (snapshot?.nativeGpuAttachmentState === "absent") {
            state.nativeRuntimeSnapshot = snapshot;
            await runtimePatch.rollbackManagedStartupAfterCreateFailure();
            return {
              ok: false,
              route,
              stage: "gpu-proof",
              error: new Error(
                "Native OpenShell GPU proof failed and the host confirms no GPU attachment.",
              ),
              fallbackEligible: true,
            } as const;
          }
        }
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        console.error("");
        console.error("  Native sandbox GPU proof failed.");
        console.error(
          "  Sandbox-reported GPU output without corroborating host evidence cannot authorize a less-confined compatibility retry.",
        );
        console.error(
          "  To explicitly select the compatibility route, clean up the sandbox and retry with NEMOCLAW_DOCKER_GPU_PATCH=1.",
        );
        process.exit(1);
      }
      if (proof.status === "failed") {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        throw new Error("Sandbox GPU proof returned failed status.");
      }
    }
    // GPU-enabled cutover stays reversible until the caller also proves the
    // configured host-local inference path. Non-GPU workloads have completed
    // their final authoritative Ready gate here.
    if (!input.sandboxGpuConfig.sandboxGpuEnabled) {
      await runtimePatch.commitAfterReady();
    }
    return {
      ok: true,
      route,
      value: { createResult, runtimePatch },
    } as const;
  };

  return { state, managedRouting, runAttempt };
}
