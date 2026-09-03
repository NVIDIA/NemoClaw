// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import "../helpers/onboard-script-mocks.cjs";

import { loadAgent } from "../../src/lib/agent/defs";
import { normalizeInferenceSelection } from "../../src/lib/inference/selection";
import { createSession } from "../../src/lib/state/onboard-session";
import type { SandboxEntry } from "../../src/lib/state/registry/types";
import { createHermesPortableBuildContextPlan } from "../../src/lib/onboard/experimental/hermes-portable-build-context";
import { readHermesPortableLifecycleReceipt } from "../../src/lib/onboard/experimental/hermes-portable-receipt";
import { runHermesPortableOnboardingTransaction } from "../../src/lib/onboard/experimental/hermes-portable-onboarding";
import { getHermesPortableSandboxRuntimeRegistryFields } from "../../src/lib/onboard/sandbox-registry-metadata";
import { resolveSandboxGpuConfig } from "../../src/lib/onboard/sandbox-gpu-mode";
import { completeHermesPortableSandboxRegistration } from "../../src/lib/onboard/sandbox-create/orchestration";
import { pendingSandboxCreateIdentityForBoundary } from "../../src/lib/onboard/sandbox-create/identity-boundary";
import { materializeHermesPortableCreatePlan } from "../../src/lib/onboard/sandbox-create-plan-materialization";
import { resolveSandboxCreateIntent } from "../../src/lib/onboard/sandbox-create-intent";
import { createPortableOnboardEnvironmentScope } from "../../src/lib/onboard/session-bootstrap";
import {
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_LIVE_IDENTITY,
  hermesPortableDescendantNames,
  hermesPortableTestOpenShellAuthority,
  makeHermesPortableCheckoutPrivate,
} from "../helpers/hermes-portable-onboarding-fixture";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";
import { testTimeoutOptions } from "../helpers/timeouts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CURL_PIPE_INSTALLER = path.join(ROOT, "install.sh");
const BUILD_SETTINGS = {
  model: "qwen3-vl:4b",
  provider: "ollama-local",
  preferredInferenceApi: "openai-completions",
  toolDisclosure: "direct",
} as const;

function createPrivateFixtureRoot(): string {
  const homeDir = fs.realpathSync(os.homedir());
  const fixtureRoot = fs.mkdtempSync(path.join(homeDir, ".nemoclaw-hermes-admission-"));
  fs.chmodSync(fixtureRoot, 0o700);
  return fixtureRoot;
}

function cloneWithInstaller(
  installer: string,
  ref: string,
  destination: string,
  callerUmask: string,
): void {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'umask "$CALLER_UMASK"\nsource "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref "$REF" "$DESTINATION"',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CALLER_UMASK: callerUmask,
        DESTINATION: destination,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${ROOT}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/NVIDIA/NemoClaw.git",
        INSTALLER_UNDER_TEST: installer,
        REF: ref,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
}

describe("Hermes portable installer admission", testTimeoutOptions(60_000), () => {
  it.each([
    { access: "group", mode: 0o720 },
    { access: "other", mode: 0o702 },
  ])(
    "rejects a source beneath a $access-writable GitHub workspace ancestor (#9211)",
    ({ mode }) => {
      const fixtureRoot = createPrivateFixtureRoot();
      const githubWorkRoot = path.join(fixtureRoot, "home", "runner", "work");
      const workspaceRoot = path.join(githubWorkRoot, "NemoClaw", "NemoClaw");
      const checkout = path.join(workspaceRoot, "source");

      try {
        fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
        const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
        }).stdout.trim();
        cloneWithInstaller(CURL_PIPE_INSTALLER, sourceRevision, checkout, "0077");
        makeHermesPortableCheckoutPrivate(checkout);
        const sourceRoot = fs.realpathSync(checkout);
        expect(
          createHermesPortableBuildContextPlan(sourceRoot, BUILD_SETTINGS).authority.sourceRevision,
        ).toBe(sourceRevision);
        fs.chmodSync(githubWorkRoot, mode);
        expect(() => createHermesPortableBuildContextPlan(sourceRoot, BUILD_SETTINGS)).toThrow(
          "Hermes portable build context source root directory chain is unsafe",
        );
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("activates one schema-7 receipt from a private checkout and validates both installer sources (#9211)", async () => {
    const fixtureRoot = createPrivateFixtureRoot();
    const stateDir = path.join(fixtureRoot, "state");
    const homeDir = path.join(fixtureRoot, "home");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.mkdirSync(homeDir, { mode: 0o700 });
    vi.stubEnv("HOME", homeDir);
    vi.resetModules();
    const registry = await import("../../src/lib/state/registry");
    const { registerCreatedSandbox } = await import("../../src/lib/onboard/sandbox-registration");
    const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout.trim();
    const sandboxName = `hermes-install-${process.pid}`;
    const gatewayName = "nemoclaw";
    const payloadCheckout = path.join(fixtureRoot, "payload-checkout");
    const curlPipeCheckout = path.join(fixtureRoot, "curl-pipe-checkout");
    let restoreEnvironment: (() => void) | null = null;

    try {
      cloneWithInstaller(INSTALLER_PAYLOAD, sourceRevision, payloadCheckout, "0022");
      cloneWithInstaller(CURL_PIPE_INSTALLER, sourceRevision, curlPipeCheckout, "0077");
      makeHermesPortableCheckoutPrivate(curlPipeCheckout);

      const payloadBuildContext = createHermesPortableBuildContextPlan(
        fs.realpathSync(payloadCheckout),
        BUILD_SETTINGS,
      );
      const activeBuildContext = createHermesPortableBuildContextPlan(
        fs.realpathSync(curlPipeCheckout),
        BUILD_SETTINGS,
      );
      expect(payloadBuildContext.authority.sourceRevision).toBe(sourceRevision);
      expect(activeBuildContext.authority.sourceRevision).toBe(sourceRevision);
      payloadBuildContext.assertCurrentSource();

      const uid = process.getuid!();
      const runtimeAuthority = {
        schemaVersion: 1 as const,
        kind: "podman" as const,
        ownership: "current-user" as const,
        uid,
        homeDir,
        configHome: path.join(homeDir, ".config"),
        runtimeDir: `/run/user/${String(uid)}`,
        socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
      };
      const selectorEnv: NodeJS.ProcessEnv = {
        DOCKER_CONTEXT: "ambient-docker",
        DOCKER_HOST: "unix:///ambient-docker.sock",
        CONTAINER_HOST: "unix:///ambient-podman.sock",
      };
      const environmentScope = createPortableOnboardEnvironmentScope(selectorEnv, null);
      restoreEnvironment = environmentScope.restore;
      const containersConf = path.join(
        runtimeAuthority.configHome,
        "nemoclaw",
        "portable",
        "containers.conf",
      );
      environmentScope.installRuntime({ containersConf, socketPath: runtimeAuthority.socketPath });
      const podmanSourceEnv =
        environmentScope.createHermesPortablePodmanSourceEnvironment(runtimeAuthority);
      expect(podmanSourceEnv).not.toHaveProperty("DOCKER_CONTEXT");
      expect(podmanSourceEnv).not.toHaveProperty("DOCKER_HOST");
      expect(podmanSourceEnv).not.toHaveProperty("CONTAINER_HOST");
      expect(selectorEnv).toMatchObject({
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: BUILD_SETTINGS.model,
        CONTAINERS_CONF: containersConf,
        DOCKER_HOST: `unix://${runtimeAuthority.socketPath}`,
      });

      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
      const session = createSession();
      const lifecycleGeneration = "11111111-1111-4111-8111-111111111111";
      expect(
        registry.reserveSandboxInferenceRoute(sandboxName, {
          provider: BUILD_SETTINGS.provider,
          model: BUILD_SETTINGS.model,
          endpointUrl: "http://inference.local/v1",
          endpointSource: null,
          credentialEnv: null,
          preferredInferenceApi: BUILD_SETTINGS.preferredInferenceApi,
          gatewayName,
          reservationSessionId: session.sessionId,
        }),
      ).toBe(true);
      const producedReservation = registry.getSandbox(sandboxName)!;
      expect(producedReservation).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: session.sessionId,
        endpointSource: null,
      });
      const selection = normalizeInferenceSelection(producedReservation);
      const createReservation = registry.qualifyPendingSandboxCreateReservation(
        {
          sandboxName,
          gatewayName,
          sessionId: session.sessionId,
          selection,
        },
        registry.getSandbox(sandboxName),
      );
      const basePolicyPath = path.join(
        curlPipeCheckout,
        "nemoclaw-blueprint",
        "policies",
        "openclaw-sandbox.yaml",
      );
      const sandboxGpuConfig = resolveSandboxGpuConfig(null, { env: {} });
      const intent = resolveSandboxCreateIntent({
        basePolicyPath,
        sandboxName,
        inferenceProvider: selection.provider,
        channels: [],
        enabledChannels: [],
        disabledChannelNames: new Set(),
        messagingProviderRequests: [],
        primaryMessagingCredentialEnvKeys: [],
        reusableMessagingChannels: [],
        reusableMessagingProviders: [],
        hermesToolGateways: [],
        sandboxGpuConfig,
        gpuCreateArgs: [],
        gpuRoutePlan: "none",
        sandboxGpuLogMessage: null,
        agentName: "hermes",
      });
      const createPlan = materializeHermesPortableCreatePlan({
        intent,
        fromRef: activeBuildContext.sourceDockerfilePath,
      });
      const startupArgv = [
        "env",
        "NEMOCLAW_HERMES_API_PORT=8642",
        `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
        "/usr/local/bin/nemoclaw-start",
      ];
      const transactionInput = {
        sandboxName,
        gatewayName,
        lifecycleGeneration,
        runtimeAuthority,
        openshellExecutableAuthority: hermesPortableTestOpenShellAuthority(),
        stateDir,
        createArgv: [
          "/usr/bin/openshell",
          "sandbox",
          "create",
          "-g",
          gatewayName,
          ...createPlan.createArgs,
          "--",
          ...startupArgv,
        ],
        createPolicyPath: createPlan.initialSandboxPolicy.policyPath,
        createPolicySourceBytes: createPlan.initialSandboxPolicy.sourceBytes,
        buildContext: activeBuildContext,
        startup: { agent: loadAgent("hermes"), sandboxName, startupArgv },
        inferenceRouteReservation: { sessionId: session.sessionId, selection },
      };
      const checkpoint = pendingSandboxCreateIdentityForBoundary({
        sandboxName,
        gatewayName,
        gatewayPort: 8080,
        lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
        route: "native" as const,
      });
      const fixture = createHermesPortableTransactionFixture(transactionInput, {
        omitCleanup: true,
        policySource: createPlan.initialSandboxPolicy.sourceBytes,
        readRegistry: () => registry.getSandbox(sandboxName),
        createSandbox: async (argv, buildContextPath) => {
          expect(buildContextPath).toContain(path.join(stateDir, "hermes-portable-build-context"));
          expect(argv[argv.indexOf("--from") + 1]).toBe(path.join(buildContextPath, "Dockerfile"));
          expect(argv[argv.indexOf("--policy") + 1]).not.toBe(basePolicyPath);
          registry.recordPendingSandboxCreateIdentity(createReservation, checkpoint);
          return { ready: true };
        },
        revalidatePendingCreateRegistry: () =>
          registry.requireCurrentPendingSandboxCreateIdentity(createReservation, checkpoint),
        registerSandbox: async (
          _created,
          receipt,
          liveIdentityFingerprint,
          revalidate,
          reservation,
        ) => {
          expect(revalidate()).toBe(liveIdentityFingerprint);
          expect(reservation.authority).toEqual(createReservation.authority);
          registry.requireCurrentPendingSandboxCreateIdentity(createReservation, checkpoint);
          return completeHermesPortableSandboxRegistration({
            sandboxName,
            completeRegistration: async () => {
              registerCreatedSandbox({
                sandboxName,
                inferenceSelection: createReservation.authority.selection,
                runtimeFields: getHermesPortableSandboxRuntimeRegistryFields(
                  sandboxGpuConfig,
                  receipt.openshellExecutableAuthority.version,
                ),
                agent: loadAgent("hermes"),
                agentVersionKnown: true,
                imageTag: null,
                plannedMessagingState: undefined,
                hermesToolGateways: [],
                hermesDashboardState: { enabled: false, config: null },
                hermesPortableLifecycle: true,
                dashboardPort: 0,
                lifecycleGeneration: receipt.lifecycleGeneration,
                lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
                gatewayName,
                gatewayPort: 8080,
                inferenceRouteReservation: createReservation,
                verifiedCreate: { reservation: createReservation, checkpoint },
              });
            },
            readRegistry: registry.getSandbox,
          });
        },
      });

      const completed = await runHermesPortableOnboardingTransaction(
        transactionInput,
        fixture.value,
      );
      expect(completed).toMatchObject({
        created: true,
        active: { receipt: { schemaVersion: 7, phase: "active", sandboxName } },
      });
      const registered = registry.getSandbox(sandboxName) as SandboxEntry;
      expect(registered).toMatchObject({
        agent: "hermes",
        endpointSource: null,
        gatewayName,
        lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
      });
      expect(registered).not.toHaveProperty("pendingRouteReservation");
      expect(registered).not.toHaveProperty("reservationSessionId");
      expect(readHermesPortableLifecycleReceipt(sandboxName, stateDir)).toEqual(completed.active);

      const buildArtifacts = hermesPortableDescendantNames(
        path.join(stateDir, "hermes-portable-build-context"),
      );
      expect(buildArtifacts.some((name) => path.basename(name).startsWith("retired."))).toBe(true);
      expect(buildArtifacts.some((name) => path.basename(name).startsWith("context."))).toBe(false);
      environmentScope.restore();
      restoreEnvironment = null;
      expect(selectorEnv).toEqual({
        DOCKER_CONTEXT: "ambient-docker",
        DOCKER_HOST: "unix:///ambient-docker.sock",
        CONTAINER_HOST: "unix:///ambient-podman.sock",
      });
    } finally {
      restoreEnvironment?.();
      registry.removeSandbox(sandboxName);
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
