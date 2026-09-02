// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import type { RebuildRecreateOnboardOpts } from "../../src/lib/actions/sandbox/rebuild-gpu-opt-out";
import {
  agentDefs,
  agentForwardStop,
  agentOnboard,
  agentRuntime,
  buildContextFingerprint,
  captureResolvedRebuildFixture,
  createHarnessTempDir,
  createRebuildFlowSession,
  destroy,
  dockerImage,
  dockerInspect,
  gatewayDrift,
  gatewayRuntime,
  gatewayState,
  gatewayTeardownAuthority,
  hermesProviderAuth,
  installTerminalStepFailureMock,
  listHarnessRebuildBackups,
  loadRebuildSandbox,
  mcpBridge,
  messaging,
  messagingHostForwardLifecycle,
  nim,
  onboardCredentialEnv,
  onboardSession,
  openshellRuntime,
  policies,
  policyGet,
  policyState,
  processRecovery,
  purgeRebuildModule,
  type RebuildFlowHarness,
  type RebuildFlowOverrides,
  rebuildCustomImagePreflight,
  rebuildFlowHelpers,
  rebuildInference,
  rebuildManagedImage,
  rebuildMessagingConflict,
  rebuildOnboardDependencies,
  rebuildPreparedImageContext,
  rebuildRoutePreflight,
  rebuildShields,
  rebuildUsageNotice,
  registry,
  registryPersistence,
  registerHarnessRebuildBackup,
  resolve,
  sandboxList,
  sandboxSession,
  sandboxState,
  sandboxVersion,
  shields,
  sourceSandboxGateway,
} from "./rebuild-flow-harness";

export {
  createHarnessTempDir,
  installRebuildFlowTestHooks,
  originalSandboxName,
  policies,
  policyGet,
  portableAgentLifecycle,
  snapshotEnv,
  tempFiles,
} from "./rebuild-flow-harness";
export { makePreparedRecoveryManifest };
export type { RebuildFlowHarness, RebuildFlowOverrides } from "./rebuild-flow-harness";

function expectPolicyCaptureOptions() {
  return {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  };
}

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  purgeRebuildModule();

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const backupPath = createHarnessTempDir("nemoclaw-rebuild-backup-");
  let latestValidatedRecoveryManifest: Record<string, unknown> | null = null;
  vi.spyOn(policyGet, "getSandboxPolicy").mockReturnValue({
    yaml: "version: 1\nnetwork_policies:\n  host_preserved: {}\n",
  });
  vi.spyOn(policies, "captureRecordedSandboxBasePolicy").mockImplementation(
    (...captureArgs: unknown[]) => {
      const sandboxName = String(captureArgs[0]);
      const gatewayName =
        typeof overrides.sandboxEntry?.gatewayName === "string"
          ? overrides.sandboxEntry.gatewayName
          : "nemoclaw";
      const options = expectPolicyCaptureOptions();
      for (const args of [
        ["policy", "get", "-g", gatewayName, "--full", "--output", "json", sandboxName],
        ["policy", "get", "-g", gatewayName, "--base", sandboxName],
      ]) {
        const captured = openshellRuntime.captureResolvedOpenshell(args, options);
        if (captured.status !== 0) {
          throw new policyState.PolicyObservationError(
            "OpenShell sandbox policy inspection failed. Policy-dependent operations must stop.",
            {
              policyReadError: {
                kind: "transport",
                reason: "unreachable",
                message: "The OpenShell sandbox policy gateway is unreachable.",
              },
            },
          );
        }
        if (args.includes("--base")) {
          const output = String(captured.stdout ?? captured.output ?? "");
          return (output.split(/(?:^|\n)---[ \t]*(?:\n|$)/u).at(-1) ?? "").trim();
        }
      }
      throw new Error("The rebuild policy fixture did not return a base policy document");
    },
  );

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  const agentName =
    overrides.agentName ??
    (typeof overrides.sandboxEntry?.agent === "string" ? overrides.sandboxEntry.agent : "openclaw");
  const agentDisplayName =
    agentName === "langchain-deepagents-code"
      ? "Deep Agents Code"
      : agentName === "hermes"
        ? "Hermes Agent"
        : "OpenClaw";
  const agentBaseImageId = `sha256:${"a".repeat(64)}`;
  const agentBaseImageRef = `nemoclaw-${agentName}-sandbox-base-local:image-${agentBaseImageId.slice("sha256:".length)}`;
  let policyAdditionsPath: string | null = null;
  if (typeof overrides.agentPolicyAdditionsContent === "string") {
    const policyDir = createHarnessTempDir("nemoclaw-rebuild-agent-policy-");
    policyAdditionsPath = path.join(policyDir, "policy-additions.yaml");
    fs.writeFileSync(policyAdditionsPath, overrides.agentPolicyAdditionsContent);
  }
  const agentDef = {
    name: agentName,
    displayName: agentDisplayName,
    expectedVersion: "0.2.0",
    policyAdditionsPath,
    dockerfileBasePath: "/tmp/Dockerfile.base",
    runtime: { kind: "terminal" },
  };
  const resolveGatewayAuthority = ({
    gatewayName,
    gatewayPort,
  }: {
    gatewayName: string;
    gatewayPort: number;
  }) => ({
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  });

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayTeardownAuthority").mockImplementation(
    resolveGatewayAuthority,
  );
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayRebuildAuthority").mockImplementation(
    resolveGatewayAuthority,
  );
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: {
      ok: true,
      value:
        overrides.sandboxInventory ??
        (overrides.staleRecovery
          ? { sandboxes: [] }
          : {
              sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
            }),
    },
    recoveryAttempted: false,
    recoverySucceeded: false,
  });
  vi.spyOn(gatewayState, "getReconciledSandboxGatewayState").mockResolvedValue(
    overrides.reconciledSandboxGatewayState ?? {
      state: overrides.staleRecovery ? "missing" : "present",
      output: "",
    },
  );
  const ensureRebuildAgentBaseImageSpy = vi
    .spyOn(rebuildFlowHelpers, "ensureRebuildAgentBaseImage")
    .mockReturnValue(
      overrides.baseImagePreflight ?? { ok: true, imageRef: null, overrideEnvVar: null },
    );
  const imageIdsByRef = new Map([
    [agentBaseImageRef, agentBaseImageId],
    [agentBaseImageId, agentBaseImageId],
  ]);
  const dcodeBaseImageIds = [...(overrides.dcodeBaseImageIds ?? [])];
  vi.spyOn(dockerInspect, "dockerImageInspectFormat").mockImplementation((...args: unknown[]) => {
    if (args[0] === "{{json .Config.Labels}}") {
      return overrides.sandboxBaseImageLabelsOutput ?? "";
    }
    if (args[0] === "{{.Id}}") {
      const imageRef = String(args[1]);
      if (imageRef === agentBaseImageRef && dcodeBaseImageIds.length > 0) {
        return dcodeBaseImageIds.shift()!;
      }
      const imageId = imageIdsByRef.get(imageRef);
      if (imageId) return imageId;
    }
    return dcodeBaseImageIds.shift() ?? "sha256:dcode-base";
  });
  vi.spyOn(dockerImage, "dockerBuild").mockReturnValue({ status: 0 });
  const dockerRmiSpy = vi.spyOn(dockerImage, "dockerRmi").mockReturnValue({ status: 0 });
  vi.spyOn(dockerImage, "dockerTag").mockImplementation((source: unknown, target: unknown) => {
    const sourceRef = String(source);
    const sourceId =
      imageIdsByRef.get(sourceRef) ?? (sourceRef.startsWith("sha256:") ? sourceRef : null);
    if (sourceId) imageIdsByRef.set(String(target), sourceId);
    return { status: 0 };
  });
  const trustedLocalOverride = {
    ref: agentBaseImageRef,
    provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
  };
  const ensureAgentBaseImageSpy = vi.spyOn(agentOnboard, "ensureAgentBaseImage").mockReturnValue({
    imageTag: agentBaseImageRef,
    built: true,
    resolutionMetadata: {
      schema: 1,
      key: `${agentName}-rebuild-base`,
      imageName: `ghcr.io/nvidia/nemoclaw/${agentName}-sandbox-base`,
      ref: agentBaseImageRef,
      digest: null,
      source: "local" as const,
      imageId: agentBaseImageId,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    },
    trustedLocalOverride,
  });
  const restoreTrustedAgentBaseImageOverrideSpy = vi.fn();
  const pinTrustedAgentBaseImageOverrideForOperationSpy = vi
    .spyOn(agentOnboard, "pinTrustedAgentBaseImageOverrideForOperation")
    .mockReturnValue(restoreTrustedAgentBaseImageOverrideSpy);
  const restoreTrustedAgentRemoteBaseImageOverrideSpy = vi.fn();
  const pinTrustedAgentRemoteBaseImageOverrideForOperationSpy = vi
    .spyOn(agentOnboard, "pinTrustedAgentRemoteBaseImageOverrideForOperation")
    .mockReturnValue(restoreTrustedAgentRemoteBaseImageOverrideSpy);
  const ensureTargetGatewaySpy = vi
    .spyOn(rebuildFlowHelpers, "ensureRebuildTargetGatewaySelected")
    .mockImplementation(() =>
      overrides.gatewayRecoveryResult?.recovered === false
        ? Promise.reject(new Error("Could not select healthy gateway 'nemoclaw'"))
        : Promise.resolve(true),
    );
  const preparedBuildCtx = createHarnessTempDir("nemoclaw-rebuild-flow-image-");
  const preparedDockerfile = path.join(preparedBuildCtx, "Dockerfile");
  fs.writeFileSync(preparedDockerfile, "FROM scratch\n");
  const rebuildAgent =
    typeof overrides.sandboxEntry?.agent === "string" ? overrides.sandboxEntry.agent : null;
  const fromDockerfile =
    typeof overrides.sandboxEntry?.fromDockerfile === "string"
      ? path.resolve(overrides.sandboxEntry.fromDockerfile)
      : null;
  const defaultImagePreflight = {
    ok: true as const,
    imageTag: "nemoclaw-rebuild-preflight:test",
    prepared: {
      buildCtx: preparedBuildCtx,
      stagedDockerfile: preparedDockerfile,
      cleanupBuildCtx: () => {
        fs.rmSync(preparedBuildCtx, { recursive: true, force: true });
        return true;
      },
      buildId: "rebuild-flow-prepared",
      contextFingerprint: buildContextFingerprint.fingerprintBuildContext(preparedBuildCtx),
      verifyBuildCtx: rebuildPreparedImageContext.createBuildContextVerifier(
        preparedBuildCtx,
        buildContextFingerprint.fingerprintBuildContext(preparedBuildCtx),
      ),
      rebuildTarget: {
        agentName: rebuildAgent && rebuildAgent !== "openclaw" ? rebuildAgent : null,
        fromDockerfile,
      },
    },
  };
  vi.spyOn(rebuildCustomImagePreflight, "preflightRebuildImage").mockResolvedValue(
    overrides.customImagePreflight ?? defaultImagePreflight,
  );
  const finalizePreparedImageSpy = vi
    .spyOn(rebuildCustomImagePreflight, "finalizePreparedRebuildImageMessagingPlan")
    .mockImplementation(
      (overrides.finalizePreparedImage ??
        ((prepared: typeof defaultImagePreflight.prepared) => ({
          ok: true as const,
          imageTag: "nemoclaw-rebuild-finalize:test",
          prepared,
        }))) as never,
    );
  vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true);
  const warnUnpreservedUserManagedFilesSpy = vi
    .spyOn(rebuildFlowHelpers, "warnUnpreservedUserManagedFiles")
    .mockImplementation(() => undefined);
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentForwardStop, "settleAgentForwardPortsForRebuild").mockReturnValue(true);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  const sessionAgentName =
    overrides.sessionAgentName === undefined ? agentName : overrides.sessionAgentName;
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(
    sessionAgentName === null || sessionAgentName === "openclaw"
      ? null
      : ({ name: sessionAgentName } as never),
  );
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue(agentDisplayName);
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockImplementation(
    async (...args: unknown[]) => {
      const gatewayName =
        (args[0] as { gatewayName?: string } | undefined)?.gatewayName ?? "nemoclaw";
      const state = { state: "healthy_named", activeGateway: gatewayName };
      return (
        overrides.gatewayRecoveryResult ?? {
          recovered: true,
          attempted: false,
          before: state,
          after: state,
        }
      );
    },
  );
  const defaultHydrateCredentialEnv =
    onboardCredentialEnv.hydrateCredentialEnv.bind(onboardCredentialEnv);
  const hydrateCredentialEnvSpy = vi
    .spyOn(rebuildOnboardDependencies, "hydrateCredentialEnv")
    .mockImplementation((...args: unknown[]) => {
      const credentialEnv = String(args[0] ?? "");
      return overrides.hydrateCredentialEnv
        ? overrides.hydrateCredentialEnv(credentialEnv)
        : defaultHydrateCredentialEnv(credentialEnv);
    });
  vi.spyOn(onboardCredentialEnv, "hydrateCredentialEnv").mockImplementation(
    (...args: unknown[]) => {
      const credentialEnv = String(args[0] ?? "");
      return overrides.hydrateCredentialEnv
        ? overrides.hydrateCredentialEnv(credentialEnv)
        : defaultHydrateCredentialEnv(credentialEnv);
    },
  );
  let hermesProviderExists = overrides.hermesProviderExists ?? true;
  let hermesCredentialKeys = hermesProviderExists
    ? (overrides.hermesCredentialKeys ?? ["OPENAI_API_KEY"])
    : null;
  vi.spyOn(hermesProviderAuth, "inspectHermesProviderBinding").mockImplementation(() => ({
    exists: hermesProviderExists,
    credentialKeys: hermesCredentialKeys,
  }));
  const registerHermesInferenceProviderSpy = vi
    .spyOn(hermesProviderAuth, "registerHermesInferenceProvider")
    .mockImplementation((...args: unknown[]) => {
      hermesProviderExists = true;
      hermesCredentialKeys = [String(args[2] ?? "OPENAI_API_KEY")];
    });
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(session);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    overrides.updateSession?.();
    if (typeof mutator !== "function") {
      throw new TypeError("updateSession expected a mutator function");
    }
    (mutator as (value: typeof session) => typeof session | void)(session);
    return session;
  });
  vi.spyOn(onboardSession, "compareAndSwapSession").mockImplementation((...args: unknown[]) => {
    const [matches, mutator] = args as [
      (current: typeof session) => boolean,
      (current: typeof session) => unknown,
    ];
    return matches(session) ? (mutator(session), "updated") : "mismatch";
  });
  const releaseOnboardLockSpy = vi
    .spyOn(onboardSession, "releaseOnboardLock")
    .mockImplementation(() => undefined);
  vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true });
  const finalizeIncompleteOnboardStepSpy = installTerminalStepFailureMock(onboardSession, session);
  session.sandboxName = overrides.sessionSandboxName ?? session.sandboxName;
  const modelsCustomOpenClawImage =
    typeof overrides.sandboxEntry?.fromDockerfile === "string" &&
    (!overrides.sandboxEntry.agent || overrides.sandboxEntry.agent === "openclaw");
  const customOpenClawPluginProvenance = modelsCustomOpenClawImage
    ? { openclawImagePluginInstalls: [] }
    : {};
  const currentSandboxEntry = {
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    policies: ["npm"],
    agent: null,
    agentVersion: "0.1.0",
    nimContainer: null,
    nemoclawVersion: "0.1.0",
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...customOpenClawPluginProvenance,
    ...(overrides.sandboxEntry ?? {}),
  };
  const readCurrentSandboxEntry = () => structuredClone(currentSandboxEntry);
  let sandboxEntryReadCount = 0;
  vi.spyOn(registry, "getSandbox").mockImplementation(() => {
    const configuredReads = overrides.sandboxEntryReads ?? [];
    return (
      sandboxEntryReadCount < configuredReads.length
        ? configuredReads[sandboxEntryReadCount++]
        : readCurrentSandboxEntry()
    ) as never;
  });
  const initialDefaultSandbox = overrides.defaultSandbox ?? null;
  const preDeleteDefaultSandbox =
    overrides.preDeleteDefaultSandbox !== undefined
      ? overrides.preDeleteDefaultSandbox
      : initialDefaultSandbox;
  const initialDefaultSelectionRevision = overrides.defaultSelectionRevision ?? 10;
  const preDeleteDefaultSelectionRevision =
    overrides.preDeleteDefaultSelectionRevision ?? initialDefaultSelectionRevision;
  const preDeleteSandboxEntry = overrides.preDeleteSandboxEntry ?? currentSandboxEntry;
  let currentDefaultSandbox = initialDefaultSandbox;
  let currentDefaultSelectionRevision = initialDefaultSelectionRevision;
  const currentRegistryEntryNames = new Set([String(currentSandboxEntry.name)]);
  if (initialDefaultSandbox) currentRegistryEntryNames.add(initialDefaultSandbox);
  if (preDeleteDefaultSandbox) currentRegistryEntryNames.add(preDeleteDefaultSandbox);
  vi.spyOn(registry, "getDefault").mockImplementation(() => currentDefaultSandbox);
  const setDefaultSpy = vi
    .spyOn(registry, "setDefault")
    .mockImplementation((...args: unknown[]) => {
      currentDefaultSandbox = String(args[0]);
      currentDefaultSelectionRevision++;
      return true;
    });
  let registryLoadCount = 0;
  vi.spyOn(registryPersistence, "load").mockImplementation(() => {
    const isPreDeleteRead = registryLoadCount > 0;
    registryLoadCount++;
    const defaultSandbox = isPreDeleteRead ? preDeleteDefaultSandbox : initialDefaultSandbox;
    const defaultSelectionRevision = isPreDeleteRead
      ? preDeleteDefaultSelectionRevision
      : initialDefaultSelectionRevision;
    const selectedEntry = isPreDeleteRead ? preDeleteSandboxEntry : currentSandboxEntry;
    return {
      sandboxes: {
        alpha: structuredClone(selectedEntry),
        ...(defaultSandbox && defaultSandbox !== "alpha"
          ? { [defaultSandbox]: { name: defaultSandbox } }
          : {}),
      },
      defaultSandbox,
      defaultSelectionRevision,
    };
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const registryUpdateSpy = vi
    .spyOn(registry, "updateSandbox")
    .mockImplementation((_name, updates) => {
      Object.assign(currentSandboxEntry, updates);
      return true;
    });
  vi.spyOn(rebuildRoutePreflight, "commitRebuildRoutePreflight").mockImplementation(
    (...args: unknown[]) => {
      const input = args[0] as {
        sandboxName: string;
        gatewayName: string;
        targetUpdate: Record<string, unknown>;
      };
      if (!registry.updateSandbox(input.sandboxName, input.targetUpdate)) {
        return {
          ok: false,
          message: "Sandbox registry entry disappeared during rebuild route preflight.",
        };
      }
      return {
        ok: true,
        receipt: {
          sandboxName: input.sandboxName,
          gatewayName: input.gatewayName,
          route: {
            provider: input.targetUpdate.provider ?? null,
            model: input.targetUpdate.model ?? null,
            endpointUrl: input.targetUpdate.endpointUrl ?? null,
            preferredInferenceApi: input.targetUpdate.preferredInferenceApi ?? null,
            credentialEnv: input.targetUpdate.credentialEnv ?? null,
          },
          migratedSandboxNames: [],
        },
      };
    },
  );
  vi.spyOn(rebuildRoutePreflight, "revalidateRebuildRouteBeforeDelete").mockImplementation(
    (...args: unknown[]) => {
      const receipt = args[0] as Record<string, unknown>;
      return overrides.revalidateRebuildRouteBeforeDelete?.(receipt) ?? { ok: true, receipt };
    },
  );
  const restoreSandboxEntrySpy = vi
    .spyOn(registry, "restoreSandboxEntry")
    .mockImplementation((...args: unknown[]) => {
      currentRegistryEntryNames.add(String((args[0] as { name: string }).name));
      const options = (args[1] ?? {}) as Record<string, unknown>;
      const transition = options.defaultTransition as
        | { from: string | null; to: string; expectedRevision: number }
        | undefined;
      if (
        transition &&
        currentDefaultSandbox === transition.from &&
        currentDefaultSelectionRevision === transition.expectedRevision
      ) {
        currentDefaultSandbox = transition.to;
        currentDefaultSelectionRevision++;
      }
    });
  const restoreSandboxEntryIfMissingSpy = vi
    .spyOn(registry, "restoreSandboxEntryIfMissing")
    .mockImplementation((...args: unknown[]) => {
      const receipt = args[0] as Record<string, unknown>;
      const entryName = String((receipt.entry as { name: string }).name);
      if (currentRegistryEntryNames.has(entryName)) return false;
      currentRegistryEntryNames.add(entryName);
      const shouldReclaimDefault =
        receipt.wasDefault === true &&
        currentDefaultSandbox === receipt.fallbackDefault &&
        currentDefaultSelectionRevision === receipt.postRemovalDefaultSelectionRevision;
      const currentDefaultIsValid =
        currentDefaultSandbox !== null && currentRegistryEntryNames.has(currentDefaultSandbox);
      if (shouldReclaimDefault || !currentDefaultIsValid) {
        currentDefaultSandbox = entryName;
        currentDefaultSelectionRevision++;
      }
      return true;
    });
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: false,
    sessions: [],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockImplementation(() => {
    Object.assign(currentSandboxEntry, overrides.entryUpdatesAfterVersionCheck ?? {});
    return (
      overrides.versionCheck ?? {
        expectedVersion: "0.2.0",
        sandboxVersion: "0.1.0",
        isStale: true,
        verificationFailed: false,
        detectionMethod: "registry",
      }
    );
  });
  vi.spyOn(nim, "detectGpu").mockReturnValue(null);
  const routeResults = [...(overrides.dcodeRouteResults ?? [{ ok: true }])];
  const preflightDcodeRouteSpy = vi
    .spyOn(rebuildInference, "probeSandboxInferenceInvocation")
    .mockImplementation(() => routeResults.shift() ?? { ok: true });
  const preparedDcodeBuildContext = {
    buildCtx: "/tmp/dcode-rebuild-context",
    stagedDockerfile: "/tmp/dcode-rebuild-context/Dockerfile",
    buildId: "dcode-build",
    contextFingerprint: "dcode-context",
    dockerGpuPatchNetwork: null,
    cleanupBuildCtx: vi.fn(() => true),
  };
  const prepareManagedDcodeRebuildImageSpy = vi
    .spyOn(rebuildManagedImage, "prepareManagedDcodeRebuildImage")
    .mockImplementation(
      async () =>
        (overrides.dcodeImageResult ?? {
          ok: true,
          prepared: preparedDcodeBuildContext,
        }) as never,
    );
  const disposePreparedDcodeRebuildImageSpy = vi
    .spyOn(rebuildManagedImage, "disposePreparedDcodeRebuildImage")
    .mockImplementation((prepared: unknown) =>
      (prepared as { cleanupBuildCtx: () => boolean }).cleanupBuildCtx(),
    );
  const imageVerificationResults = [...(overrides.dcodeImageVerificationResults ?? [true])];
  vi.spyOn(rebuildManagedImage, "verifyPreparedDcodeRebuildImage").mockImplementation(
    () => imageVerificationResults.shift() ?? true,
  );
  const openShieldsSpy = vi
    .spyOn(rebuildShields, "openRebuildShieldsWindow")
    .mockImplementation(overrides.openShieldsWindow ?? (() => rebuildShieldsWindow));
  const relockSpy = vi
    .spyOn(rebuildShields, "relockRebuildShieldsWindow")
    .mockImplementation((...args: unknown[]) => {
      const window = args[1] as typeof rebuildShieldsWindow;
      window.relocked = true;
      return true;
    });
  const backupSandboxStateSpy = vi
    .spyOn(sandboxState, "backupSandboxState")
    .mockImplementation(() => {
      overrides.beforeBackup?.();
      const manifest = {
        agentType:
          typeof overrides.sandboxEntry?.agent === "string"
            ? overrides.sandboxEntry.agent
            : "openclaw",
        dir: "/sandbox/.openclaw",
        backupPath,
        timestamp: "2026-06-01T00:00:00.000Z",
        ...(overrides.backupPreservedEnv
          ? { preservedEnv: structuredClone(overrides.backupPreservedEnv) }
          : {}),
        ...(modelsCustomOpenClawImage
          ? {
              reconcileOpenClawImagePluginProvenance: true,
              openclawImagePluginInstalls: structuredClone(
                currentSandboxEntry.openclawImagePluginInstalls,
              ),
            }
          : {}),
      };
      registerHarnessRebuildBackup(manifest as ReturnType<typeof sandboxState.listBackups>[number]);
      return {
        success: true,
        backedUpDirs: ["workspace"],
        backedUpFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
        manifest,
      };
    });
  vi.spyOn(sandboxState, "validateRebuildRecoveryManifest").mockImplementation(
    (...args: unknown[]) => {
      const manifest = args[2] as Record<string, unknown>;
      const persistedPath = path.join(String(manifest.backupPath), "rebuild-manifest.json");
      const persistedManifest = fs.existsSync(persistedPath)
        ? (JSON.parse(fs.readFileSync(persistedPath, "utf8")) as Record<string, unknown>)
        : manifest;
      const result = overrides.recoveryManifestValidation?.(manifest) ?? {
        ok: true,
        manifest: persistedManifest,
      };
      if (result.ok) {
        latestValidatedRecoveryManifest = result.manifest;
        registerHarnessRebuildBackup(
          result.manifest as ReturnType<typeof sandboxState.listBackups>[number],
        );
      }
      return result;
    },
  );
  vi.spyOn(sandboxState, "getLatestBackup").mockImplementation(() => {
    const manifest =
      overrides.preDeleteLatestManifest === undefined
        ? (latestValidatedRecoveryManifest ?? listHarnessRebuildBackups().at(-1) ?? null)
        : overrides.preDeleteLatestManifest;
    if (manifest) {
      registerHarnessRebuildBackup(manifest as ReturnType<typeof sandboxState.listBackups>[number]);
    }
    return manifest as ReturnType<typeof sandboxState.getLatestBackup>;
  });
  vi.spyOn(sandboxState, "listBackups").mockImplementation(listHarnessRebuildBackups);
  vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence").mockReturnValue(
    overrides.managedImageEvidence ?? true,
  );
  const restoreSandboxStateSpy = vi
    .spyOn(sandboxState, "restoreRecreatedSandboxState")
    .mockImplementation(
      overrides.restoreSandboxState ??
        (() => ({
          success: true,
          restoredDirs: ["workspace"],
          restoredFiles: ["user.md"],
          failedDirs: [],
          failedFiles: [],
        })),
    );
  const deletedSourceGateways = new Set<string>();
  const runOpenshellSpy = vi
    .spyOn(openshellRuntime, "runOpenshell")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      const overrideResult = overrides.runOpenshell?.(argv);
      if (overrideResult) return overrideResult;
      const deleteGateway = sourceSandboxGateway(argv, "delete");
      if (deleteGateway) {
        deletedSourceGateways.add(deleteGateway);
        return { status: 0, output: "" };
      }
      if (
        argv.join(" ") === "sandbox get alpha" ||
        argv.join(" ") === "sandbox get -g nemoclaw alpha"
      ) {
        return {
          status: 1,
          output: "sandbox alpha not found",
          stdout: "",
          stderr: "sandbox alpha not found",
        };
      }
      return argv[0] === "provider" && argv[1] === "get"
        ? {
            status: 0,
            stdout:
              "Name: compatible-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL\n",
            stderr: "",
          }
        : { status: 0, output: "" };
    });
  const captureOpenshellSpy = vi
    .spyOn(openshellRuntime, "captureOpenshell")
    .mockImplementation((args: unknown, options?: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      if (overrides.captureOpenshell) {
        return overrides.captureOpenshell(argv, options as Record<string, unknown> | undefined);
      }
      const probedGateway = sourceSandboxGateway(argv, "get");
      const liveSource = "Name: alpha\nId: sbx-alpha-source\nPhase: Ready\n";
      return probedGateway && !deletedSourceGateways.has(probedGateway)
        ? { status: 0, output: liveSource, stdout: liveSource, stderr: "" }
        : { status: 1, output: "", stderr: "Error: sandbox alpha not found" };
    });
  const captureResolvedOpenshellSpy = vi
    .spyOn(openshellRuntime, "captureResolvedOpenshell")
    .mockImplementation((args: unknown, options?: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      if (overrides.captureResolvedOpenshell) {
        return overrides.captureResolvedOpenshell(
          argv,
          options as Record<string, unknown> | undefined,
        );
      }
      return captureResolvedRebuildFixture(argv, deletedSourceGateways);
    });
  const defaultRemovalReceipt = {
    entry: preDeleteSandboxEntry,
    wasDefault: preDeleteDefaultSandbox === "alpha",
    fallbackDefault:
      preDeleteDefaultSandbox && preDeleteDefaultSandbox !== "alpha"
        ? preDeleteDefaultSandbox
        : null,
    postRemovalDefaultSelectionRevision:
      preDeleteDefaultSelectionRevision + (preDeleteDefaultSandbox === "alpha" ? 1 : 0),
  };
  const removeSandboxRegistryEntryWithReceiptSpy = vi
    .spyOn(destroy, "removeSandboxRegistryEntryWithReceipt")
    .mockImplementation(() => {
      const overridden = overrides.removeSandboxRegistryEntryWithReceipt?.();
      const receipt =
        overridden !== undefined
          ? overridden
          : overrides.removalReceipt === undefined
            ? defaultRemovalReceipt
            : overrides.removalReceipt;
      if (receipt) {
        currentRegistryEntryNames.delete(String(receipt.entry.name));
        if (receipt.fallbackDefault) currentRegistryEntryNames.add(receipt.fallbackDefault);
        currentDefaultSandbox = receipt.wasDefault
          ? receipt.fallbackDefault
          : currentDefaultSandbox;
        currentDefaultSelectionRevision = receipt.postRemovalDefaultSelectionRevision;
      }
      return receipt;
    });
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined);
  const onboardSpy = vi
    .spyOn(rebuildOnboardDependencies, "onboard")
    .mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as RebuildRecreateOnboardOpts;
      await overrides.onboard?.(session, options);
    });
  const preflightAuthoritativeRebuildTargetSpy = vi
    .spyOn(rebuildOnboardDependencies, "preflightAuthoritativeRebuildTarget")
    .mockImplementation(async (options: unknown) => {
      const preflightOptions = (options ?? {}) as Record<string, unknown>;
      if (overrides.preflightWithProductionBaselineResolver) {
        policies.resolveSandboxBaselinePolicy(String(preflightOptions.sandboxName ?? ""));
      }
      await overrides.preflightAuthoritativeRebuildTarget?.(preflightOptions);
      return {
        gatewayName: String(preflightOptions.targetGatewayName ?? "nemoclaw"),
        gatewayPort: Number(preflightOptions.targetGatewayPort ?? 8080),
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      };
    });
  const ensureValidatedBraveSearchCredentialSpy = vi
    .spyOn(rebuildOnboardDependencies, "ensureValidatedWebSearchCredential")
    .mockImplementation(
      overrides.ensureValidatedWebSearchCredential ??
        overrides.ensureValidatedBraveSearchCredential ??
        (async () => "web-search-key"),
    );
  const livePolicyPresets = new Set(overrides.gatewayPresets ?? []);
  const managedObservabilityPreset = "observability-otlp-local";
  const managedObservabilityContent =
    "network_policies:\n  observability-otlp-local:\n    name: observability-otlp-local\n";
  let liveManagedObservabilityContent = livePolicyPresets.has(managedObservabilityPreset)
    ? managedObservabilityContent
    : null;
  let policyRemovalObserved = false;
  const applyPresetSpy = vi
    .spyOn(policies, "applyPreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const normalizedPresetName = String(presetName);
      let applied: boolean;
      if (overrides.applyPreset) {
        applied = overrides.applyPreset(normalizedPresetName);
      } else if (normalizedPresetName === "throw") {
        throw new Error("preset boom");
      } else {
        applied = normalizedPresetName === "npm";
      }
      if (applied) {
        livePolicyPresets.add(normalizedPresetName);
        if (normalizedPresetName === managedObservabilityPreset) {
          liveManagedObservabilityContent = managedObservabilityContent;
        }
      }
      return applied;
    });
  const applyPresetContentSpy = vi
    .spyOn(policies, "applyPresetContent")
    .mockImplementation((_sandboxName: unknown, presetName: unknown, presetContent: unknown) => {
      livePolicyPresets.add(String(presetName));
      const content = String(presetContent);
      if (policies.parsePresetPolicyKeys(content).includes(managedObservabilityPreset)) {
        liveManagedObservabilityContent = content;
      }
      return true;
    });
  vi.spyOn(policies, "loadPresetForSandbox").mockImplementation(
    (_sandboxName: unknown, presetName: unknown) =>
      String(presetName) === managedObservabilityPreset ? managedObservabilityContent : null,
  );
  vi.spyOn(policies, "getPresetContentGatewayState").mockImplementation(
    (_sandboxName: unknown, presetContent: unknown) => {
      if (overrides.verificationUnavailableAfterPresetRemoval && policyRemovalObserved) return null;
      const content = String(presetContent);
      if (!policies.parsePresetPolicyKeys(content).includes(managedObservabilityPreset)) {
        return "absent";
      }
      if (liveManagedObservabilityContent === null) return "absent";
      return liveManagedObservabilityContent === content ? "match" : "drift";
    },
  );
  vi.spyOn(policies, "getGatewayPresets").mockImplementation(() =>
    overrides.verificationUnavailableAfterPresetRemoval && policyRemovalObserved
      ? null
      : [...livePolicyPresets],
  );
  const removePresetSpy = vi
    .spyOn(policies, "removePreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const removed = livePolicyPresets.delete(String(presetName));
      if (
        String(presetName) === managedObservabilityPreset &&
        liveManagedObservabilityContent === managedObservabilityContent
      ) {
        liveManagedObservabilityContent = null;
      }
      if (removed) policyRemovalObserved = true;
      return removed;
    });
  const executeSandboxCommandSpy = vi
    .spyOn(processRecovery, "executeSandboxCommand")
    .mockImplementation(
      overrides.executeSandboxCommand ?? (() => ({ status: 0, stdout: "doctor ok", stderr: "" })),
    );
  const executeSandboxExecCommandSpy = vi
    .spyOn(processRecovery, "executeSandboxExecCommand")
    .mockImplementation(
      overrides.executeSandboxExecCommand ??
        (() => ({ status: 0, stdout: "doctor ok", stderr: "" })),
    );
  const checkAndRecoverSandboxProcessesSpy = vi
    .spyOn(processRecovery, "checkAndRecoverSandboxProcesses")
    .mockImplementation(
      overrides.checkAndRecoverSandboxProcesses ??
        (() => ({
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
        })),
    );
  const restartSandboxGatewaySpy = vi
    .spyOn(processRecovery, "restartSandboxGateway")
    .mockImplementation(
      overrides.restartSandboxGateway ??
        (() => ({
          ok: true,
          restarted: true,
          healthPassed: true,
          forwardRecovered: false,
        })),
    );
  vi.spyOn(shields, "repairMutableConfigPerms").mockImplementation(
    overrides.repairMutableConfigPerms ?? (() => ({ applied: true, verified: true, errors: [] })),
  );
  vi.spyOn(shields, "isShieldsDown").mockReturnValue(true);
  vi.spyOn(shields, "clearShieldsState").mockImplementation(
    overrides.clearShieldsState ?? (() => undefined),
  );
  const preflightMessagingConflictsSpy = vi
    .spyOn(rebuildMessagingConflict, "preflightRebuildMessagingConflicts")
    .mockImplementation(async () => {
      await overrides.preflightMessagingConflicts?.();
    });
  const messagingRebuildPlanSpy = vi
    .spyOn(messaging.MessagingWorkflowPlanner.prototype, "buildRebuildPlanFromSandboxEntry")
    .mockImplementation(overrides.buildMessagingRebuildPlan ?? (() => null));
  const ensureMessagingHostForwardAfterRebuildSpy = vi
    .spyOn(messagingHostForwardLifecycle, "ensureMessagingHostForwardAfterRebuild")
    .mockReturnValue(true);
  const prepareMcpBridgesForRebuildSpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForRebuild")
    .mockResolvedValue(
      overrides.mcpPreparation ?? {
        entries: [],
        detachedProviderEntries: [],
      },
    );
  const prepareMcpBridgesForAbsentSandboxRebuildSpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForAbsentSandboxRebuild")
    .mockResolvedValue(
      overrides.mcpPreparation ?? {
        entries: [],
        detachedProviderEntries: [],
        scrubbedAdapterEntries: [],
      },
    );
  const reattachMcpProvidersAfterRebuildAbortSpy = vi
    .spyOn(mcpBridge, "reattachMcpProvidersAfterRebuildAbort")
    .mockResolvedValue(undefined);
  const restoreMcpBridgesAfterRebuildSpy = vi
    .spyOn(mcpBridge, "restoreMcpBridgesAfterRebuild")
    .mockImplementation(overrides.restoreMcpBridgesAfterRebuild ?? (() => Promise.resolve()));

  errorSpy.mockClear();
  logSpy.mockClear();
  warnSpy.mockClear();

  return {
    backupPath,
    rebuildSandbox: loadRebuildSandbox(),
    applyPresetSpy,
    applyPresetContentSpy,
    backupSandboxStateSpy,
    checkAndRecoverSandboxProcessesSpy,
    restartSandboxGatewaySpy,
    errorSpy,
    executeSandboxCommandSpy,
    executeSandboxExecCommandSpy,
    ensureMessagingHostForwardAfterRebuildSpy,
    ensureRebuildAgentBaseImageSpy,
    ensureAgentBaseImageSpy,
    pinTrustedAgentBaseImageOverrideForOperationSpy,
    pinTrustedAgentRemoteBaseImageOverrideForOperationSpy,
    restoreTrustedAgentBaseImageOverrideSpy,
    restoreTrustedAgentRemoteBaseImageOverrideSpy,
    disposePreparedDcodeRebuildImageSpy,
    dockerRmiSpy,
    ensureTargetGatewaySpy,
    ensureValidatedBraveSearchCredentialSpy,
    hydrateCredentialEnvSpy,
    logSpy,
    finalizeIncompleteOnboardStepSpy,
    onboardSpy,
    openShieldsSpy,
    preflightAuthoritativeRebuildTargetSpy,
    preflightMessagingConflictsSpy,
    preflightDcodeRouteSpy,
    prepareManagedDcodeRebuildImageSpy,
    preparedDcodeBuildContext,
    registryUpdateSpy,
    setDefaultSpy,
    setDefault: (name: string) => registry.setDefault(name),
    registerHermesInferenceProviderSpy,
    registerSandboxEntry: (name: string) => {
      currentRegistryEntryNames.add(name);
      if (currentDefaultSandbox === null) {
        currentDefaultSandbox = name;
        currentDefaultSelectionRevision++;
      }
    },
    getDefaultSelectionState: () => ({
      defaultSandbox: currentDefaultSandbox,
      defaultSelectionRevision: currentDefaultSelectionRevision,
    }),
    releaseOnboardLockSpy,
    relockSpy,
    restoreSandboxStateSpy,
    captureOpenshellSpy,
    captureResolvedOpenshellSpy,
    runOpenshellSpy,
    messagingRebuildPlanSpy,
    prepareMcpBridgesForAbsentSandboxRebuildSpy,
    prepareMcpBridgesForRebuildSpy,
    reattachMcpProvidersAfterRebuildAbortSpy,
    removeSandboxRegistryEntryWithReceiptSpy,
    removeSandboxRegistryEntrySpy: removeSandboxRegistryEntryWithReceiptSpy,
    removePresetSpy,
    restoreSandboxEntrySpy,
    restoreSandboxEntryIfMissingSpy,
    restoreMcpBridgesAfterRebuildSpy,
    warnUnpreservedUserManagedFilesSpy,
    finalizePreparedImageSpy,
    session,
  };
}
