// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import "./helpers/onboard-script-mocks.cjs";

import type { HermesPortableOpenShellExecutableAuthority } from "../src/lib/adapters/openshell/resolve-shared";
import { loadAgent } from "../src/lib/agent/defs";
import { normalizeInferenceSelection } from "../src/lib/inference/selection";
import { withMcpLifecycleLock } from "../src/lib/state/mcp-lifecycle-lock-acquisition";
import { createSession } from "../src/lib/state/onboard-session";
import type { SandboxEntry } from "../src/lib/state/registry/types";
import {
  isCurrentSandboxInferenceRouteReservation,
  normalizeSandboxInferenceRouteSelection,
  sandboxRegistrationMatchesInferenceRouteReservation,
} from "../src/lib/state/registry/route-reservation";
import { createHermesPortableBuildContextPlan } from "../src/lib/onboard/experimental/hermes-portable-build-context";
import type { HermesPortablePodmanExecutableAuthority } from "../src/lib/onboard/experimental/hermes-portable-podman-authority";
import { readHermesPortableLifecycleReceipt } from "../src/lib/onboard/experimental/hermes-portable-receipt";
import { runHermesPortableOnboardingTransaction } from "../src/lib/onboard/experimental/hermes-portable-onboarding";
import { materializeHermesPortableCreatePlan } from "../src/lib/onboard/sandbox-create-plan-materialization";
import { resolveSandboxCreateIntent } from "../src/lib/onboard/sandbox-create-intent";
import { createPortableOnboardEnvironmentScope } from "../src/lib/onboard/session-bootstrap";
import { INSTALLER_PAYLOAD } from "./helpers/installer-sourced-env";
import { testTimeoutOptions } from "./helpers/timeouts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CURL_PIPE_INSTALLER = path.join(ROOT, "install.sh");
const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = "b".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const LIVE_IDENTITY_FINGERPRINT = "live-identity-1";

const BUILD_SETTINGS = {
  model: "qwen3-vl:4b",
  provider: "ollama-local",
  preferredInferenceApi: "openai-completions",
  toolDisclosure: "direct",
} as const;

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

function makeCheckoutPrivate(root: string): void {
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    switch (true) {
      case stat.isSymbolicLink():
        return;
      case stat.isDirectory():
        for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
        fs.chmodSync(target, 0o700);
        return;
      case stat.isFile():
        fs.chmodSync(target, (stat.mode & 0o111) === 0 ? 0o600 : 0o700);
    }
  };
  visit(root);
}

function executableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.101",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "f".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanAuthority(): HermesPortablePodmanExecutableAuthority {
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: "2048",
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: "9".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function allDescendantNames(root: string): string[] {
  return fs.existsSync(root)
    ? fs.readdirSync(root, { recursive: true, encoding: "utf8" }).map(String)
    : [];
}

describe("Hermes portable installer admission", testTimeoutOptions(60_000), () => {
  it("activates one schema-5 receipt after an installer checkout changes to accepted private modes (#9211)", async () => {
    const repositoryRoot = fs.realpathSync(ROOT);
    const fixtureRoot = fs.mkdtempSync(path.join(repositoryRoot, ".hermes-portable-admission-"));
    fs.chmodSync(fixtureRoot, 0o700);
    const stateDir = path.join(fixtureRoot, "state");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const homeDir = path.join(fixtureRoot, "home");
    fs.mkdirSync(homeDir, { mode: 0o700 });
    vi.stubEnv("HOME", homeDir);
    vi.resetModules();
    const registry = await import("../src/lib/state/registry");
    const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).stdout.trim();
    const sandboxName = `hermes-install-${process.pid}`;
    const gatewayName = "nemoclaw";
    const payloadCheckout = path.join(fixtureRoot, "payload-checkout");
    const curlPipeCheckout = path.join(fixtureRoot, "curl-pipe-checkout");

    try {
      cloneWithInstaller(INSTALLER_PAYLOAD, sourceRevision, payloadCheckout, "0022");
      cloneWithInstaller(CURL_PIPE_INSTALLER, sourceRevision, curlPipeCheckout, "0077");
      expect(
        spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: payloadCheckout,
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(sourceRevision);
      expect(
        spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: curlPipeCheckout,
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(sourceRevision);

      makeCheckoutPrivate(curlPipeCheckout);
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
      const producedReservation = registry.getSandbox(sandboxName);
      expect(producedReservation).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: session.sessionId,
        endpointSource: null,
      });
      const selection = normalizeInferenceSelection(producedReservation);
      const basePolicyPath = path.join(
        curlPipeCheckout,
        "nemoclaw-blueprint",
        "policies",
        "openclaw-sandbox.yaml",
      );
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
        sandboxGpuConfig: { sandboxGpuEnabled: false, hostGpuDetected: false },
        gpuCreateArgs: [],
        gpuRoutePlan: "none",
        sandboxGpuLogMessage: null,
        agentName: "hermes",
        policyTier: null,
      });
      const createPlan = materializeHermesPortableCreatePlan({
        intent,
        fromRef: activeBuildContext.sourceDockerfilePath,
      });
      const policyBytes = createPlan.initialSandboxPolicy.sourceBytes;
      expect(policyBytes).toBeInstanceOf(Buffer);

      let sandboxPresent = false;
      let restartPolicy = "no";
      const labels = {
        "openshell.managed": "true",
        "openshell.ai/sandbox-id": SANDBOX_ID,
        "openshell.ai/sandbox-name": sandboxName,
        "openshell.ai/sandbox-namespace": "",
        "openshell.ai/sandbox-workspace": "default",
      };
      const podman = vi.fn((args: readonly string[]) => {
        const operation = args[0] === "ps" ? "ps" : args.slice(0, 2).join(" ");
        switch (operation) {
          case "ps":
            return { status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
          case "container inspect":
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: CONTAINER_ID,
                  Image: IMAGE_ID,
                  Name: `openshell-default--${sandboxName}-${SANDBOX_ID}`,
                  Config: { Labels: labels },
                  State: { Running: true, Paused: false, Status: "running" },
                  HostConfig: { RestartPolicy: { Name: restartPolicy } },
                },
              ]),
              stderr: "",
            };
          case "container update":
            restartPolicy = "unless-stopped";
            return { status: 0, stdout: "", stderr: "" };
          case "container exec":
            return { status: 0, stdout: "200\n", stderr: "" };
          default:
            throw new Error(`unexpected Podman arguments: ${args.join(" ")}`);
        }
      });
      const startupArgv = [
        "env",
        "NEMOCLAW_HERMES_API_PORT=8642",
        `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
        "/usr/local/bin/nemoclaw-start",
      ];
      const createArgv = [
        "/usr/bin/openshell",
        "sandbox",
        "create",
        "-g",
        gatewayName,
        ...createPlan.createArgs,
        "--",
        ...startupArgv,
      ];

      const completed = await runHermesPortableOnboardingTransaction(
        {
          sandboxName,
          gatewayName,
          lifecycleGeneration: "generation-1",
          runtimeAuthority,
          openshellExecutableAuthority: executableAuthority(),
          stateDir,
          createArgv,
          createPolicyPath: createPlan.initialSandboxPolicy.policyPath,
          createPolicySourceBytes: policyBytes,
          buildContext: activeBuildContext,
          startup: {
            agent: loadAgent("hermes"),
            sandboxName,
            startupArgv,
          },
          inferenceRouteReservation: {
            sessionId: producedReservation!.reservationSessionId!,
            selection,
          },
        },
        {
          withLifecycleLock: (name, operation) =>
            withMcpLifecycleLock(name, operation, { stateDir: path.join(stateDir, "state") }),
          captureSocketAuthority: (socketPath) => ({
            device: "1",
            inode: "2",
            mode: "49536",
            ownerUid: String(uid),
            socketPath,
            directoryChain: directoryChain(path.dirname(socketPath)).map((directory, index) => ({
              device: "1",
              inode: String(index + 3),
              mode: String(index === 0 ? 0o40700 : 0o40755),
              ownerUid: String(index === 0 ? uid : 0),
              path: directory,
            })),
          }),
          capturePodmanExecutableAuthority: () => podmanAuthority(),
          container: { podman, assertSocketAuthority: vi.fn() },
          assertOpenShellExecutableAuthority: vi.fn(),
          capturePolicy: () => ({
            status: 0,
            stdout: Buffer.from(policyBytes!),
            stderr: Buffer.alloc(0),
          }),
          observeSandbox: () =>
            sandboxPresent
              ? {
                  kind: "present" as const,
                  sandboxId: SANDBOX_ID,
                  liveIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
                }
              : { kind: "absent" as const },
          createSandbox: async (argv, buildContextPath) => {
            expect(buildContextPath).toContain(
              path.join(stateDir, "hermes-portable-build-context"),
            );
            expect(argv[argv.indexOf("--from") + 1]).toBe(
              path.join(buildContextPath, "agents", "hermes", "Dockerfile"),
            );
            expect(argv[argv.indexOf("--policy") + 1]).not.toBe(basePolicyPath);
            sandboxPresent = true;
            return { sandboxName };
          },
          readRegistry: () => registry.getSandbox(sandboxName),
          registerSandbox: (
            _created,
            receipt,
            liveIdentityFingerprint,
            revalidate,
            reservation,
          ) => {
            expect(
              isCurrentSandboxInferenceRouteReservation(
                reservation,
                registry.getSandbox(sandboxName),
              ),
            ).toBe(true);
            expect(revalidate()).toBe(liveIdentityFingerprint);
            expect(
              registry.updateSandbox(sandboxName, {
                pendingRouteReservation: undefined,
                reservationSessionId: undefined,
                agent: "hermes",
                gatewayName,
                lifecycleGeneration: receipt.lifecycleGeneration,
                lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
                openshellDriver: "docker",
                openshellVersion: receipt.openshellExecutableAuthority.version,
              }),
            ).toBe(true);
            const registered = registry.getSandbox(sandboxName)!;
            expect(
              sandboxRegistrationMatchesInferenceRouteReservation(registered, reservation),
            ).toBe(true);
            return registered;
          },
        },
      );

      expect(completed).toMatchObject({
        created: true,
        active: { receipt: { schemaVersion: 5, phase: "active", sandboxName } },
      });
      const registered = registry.getSandbox(sandboxName) as SandboxEntry;
      expect(registered).toMatchObject({
        agent: "hermes",
        endpointSource: null,
        gatewayName,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
      });
      expect(registered).not.toHaveProperty("pendingRouteReservation");
      expect(registered).not.toHaveProperty("reservationSessionId");

      expect(readHermesPortableLifecycleReceipt(sandboxName, stateDir)).toEqual(completed.active);
      const buildArtifacts = allDescendantNames(
        path.join(stateDir, "hermes-portable-build-context"),
      );
      expect(buildArtifacts.some((name) => path.basename(name).startsWith("retired."))).toBe(true);
      expect(buildArtifacts.some((name) => path.basename(name).startsWith("context."))).toBe(false);

      environmentScope.restore();
      expect(selectorEnv).toEqual({
        DOCKER_CONTEXT: "ambient-docker",
        DOCKER_HOST: "unix:///ambient-docker.sock",
        CONTAINER_HOST: "unix:///ambient-podman.sock",
      });
    } finally {
      try {
        const registry = await import("../src/lib/state/registry");
        registry.removeSandbox(sandboxName);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  });
});
