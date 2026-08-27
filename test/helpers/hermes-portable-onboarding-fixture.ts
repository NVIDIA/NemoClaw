// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { expect, vi } from "vitest";

import type {
  PodmanSocketAuthority,
  PodmanSocketAuthorityDeps,
} from "../../src/lib/adapters/podman";
import type { HermesPortableOpenShellExecutableAuthority } from "../../src/lib/adapters/openshell/resolve-shared";
import { loadAgent } from "../../src/lib/agent/defs";
import { withMcpLifecycleLock } from "../../src/lib/state/mcp-lifecycle-lock-acquisition";
import type { SandboxEntry } from "../../src/lib/state/registry";
import {
  isCurrentSandboxInferenceRouteReservation,
  normalizeSandboxInferenceRouteSelection,
} from "../../src/lib/state/registry/route-reservation";
import type { HermesPortablePodmanExecutableAuthority } from "../../src/lib/onboard/experimental/hermes-portable-podman-authority";
import type {
  HermesPortableOnboardingDeps,
  HermesPortableOnboardingInput,
} from "../../src/lib/onboard/experimental/hermes-portable-onboarding";
import { registryEntryGatewayPort } from "../../src/lib/state/gateway-registry";

export const HERMES_PORTABLE_TEST_POLICY = "version: 1\nnetwork_policies: {}\n";

const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = "b".repeat(64);
export const HERMES_PORTABLE_TEST_SANDBOX_ID = "sandbox-id-1";
export const HERMES_PORTABLE_TEST_LIVE_IDENTITY = createHash("sha256")
  .update(HERMES_PORTABLE_TEST_SANDBOX_ID)
  .digest("hex");
const ROUTE_SESSION_ID = "session-alpha";

export function makeHermesPortableCheckoutPrivate(root: string): void {
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
      fs.chmodSync(target, 0o700);
    } else if (stat.isFile()) {
      fs.chmodSync(target, (stat.mode & 0o111) === 0 ? 0o600 : 0o700);
    }
  };
  visit(root);
}

export function hermesPortableDescendantNames(root: string): string[] {
  return fs.existsSync(root)
    ? fs.readdirSync(root, { recursive: true, encoding: "utf8" }).map(String)
    : [];
}

function result(stdout: string, status = 0) {
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

export function createHermesPortableContainerInspectResult(
  restartPolicy: string,
  sandboxName = "alpha",
) {
  return {
    status: 0,
    stdout: JSON.stringify([
      {
        Id: CONTAINER_ID,
        Image: IMAGE_ID,
        Name: `openshell-default--${sandboxName}-${HERMES_PORTABLE_TEST_SANDBOX_ID}`,
        Config: {
          Labels: {
            "openshell.managed": "true",
            "openshell.ai/sandbox-id": HERMES_PORTABLE_TEST_SANDBOX_ID,
            "openshell.ai/sandbox-name": sandboxName,
            "openshell.ai/sandbox-namespace": "",
            "openshell.ai/sandbox-workspace": "default",
          },
        },
        State: { Running: true, Paused: false, Status: "running" },
        HostConfig: { RestartPolicy: { Name: restartPolicy } },
      },
    ]),
    stderr: "",
  };
}

function startupArgv(sandboxName = "alpha") {
  return [
    "env",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
    "/usr/local/bin/nemoclaw-start",
  ];
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

export function unexpectedHermesPortablePodmanArgs(args: readonly string[]): never {
  throw new Error(`unexpected podman args: ${args.join(" ")}`);
}

export function hermesPortableTestOpenShellAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.106",
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

export function hermesPortableTestPodmanAuthority(): HermesPortablePodmanExecutableAuthority {
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

function routeSelection() {
  return {
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    endpointUrl: null,
    endpointSource: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  } as const;
}

function matchingRegistryEntry(
  input: HermesPortableOnboardingInput,
  options: {
    openshellVersion?: string | null;
    liveFingerprint?: string;
    omitGatewayPort?: boolean;
  } = {},
): SandboxEntry {
  const gatewayPort = registryEntryGatewayPort({
    name: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  return {
    name: input.sandboxName,
    agent: "hermes",
    ...normalizeSandboxInferenceRouteSelection(input.inferenceRouteReservation.selection),
    gatewayName: input.gatewayName,
    ...(options.omitGatewayPort ? {} : { gatewayPort }),
    lifecycleGeneration: input.lifecycleGeneration,
    openshellDriver: "docker",
    lifecycleLiveIdentityFingerprint: options.liveFingerprint ?? HERMES_PORTABLE_TEST_LIVE_IDENTITY,
    openshellVersion:
      "openshellVersion" in options
        ? options.openshellVersion
        : input.openshellExecutableAuthority.version,
  };
}

export function createHermesPortableTestInput(stateDir: string, policyPath: string) {
  const uid = process.getuid!();
  const sourceDockerfilePath = `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`;
  return {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    stateDir,
    createPolicyPath: policyPath,
    createArgv: [
      "/usr/bin/openshell",
      "sandbox",
      "create",
      "-g",
      "nemoclaw",
      "--from",
      sourceDockerfilePath,
      "--name",
      "alpha",
      "--policy",
      policyPath,
      "--",
      ...startupArgv(),
    ],
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir: "/home/test",
      configHome: "/home/test/.config",
      runtimeDir: `/run/user/${String(uid)}`,
      socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
    },
    openshellExecutableAuthority: hermesPortableTestOpenShellAuthority(),
    buildContext: {
      authority: {
        schemaVersion: 1,
        sourceRevision: "1".repeat(40),
        dockerfileRelativePath: "Dockerfile",
        sourceManifestSha256: "2".repeat(64),
        contextManifestSha256: "3".repeat(64),
      },
      sourceDockerfilePath,
      assertCurrentSource: vi.fn(),
      materialize: vi.fn(() => ({
        buildContextPath: "/private/staged-hermes",
        dockerfilePath: "/private/staged-hermes/Dockerfile",
        assertCurrent: vi.fn(),
      })),
      retire: vi.fn(() => true),
    },
    startup: {
      agent: loadAgent("hermes"),
      sandboxName: "alpha",
      startupArgv: startupArgv(),
    },
    inferenceRouteReservation: {
      sessionId: ROUTE_SESSION_ID,
      selection: routeSelection(),
    },
  } satisfies HermesPortableOnboardingInput;
}

export function hermesPortableReservationForOnboarding(
  input: HermesPortableOnboardingInput,
): SandboxEntry {
  return {
    name: input.sandboxName,
    pendingRouteReservation: true,
    reservationSessionId: input.inferenceRouteReservation.sessionId,
    ...normalizeSandboxInferenceRouteSelection(input.inferenceRouteReservation.selection),
    gatewayName: input.gatewayName,
    hostLocalInferenceReceipt: "receipt-1",
  };
}

export interface HermesPortableTransactionFixtureOptions {
  existingSandbox?: boolean;
  updateFails?: boolean;
  failAfterRegistry?: boolean;
  cleanupFails?: boolean;
  omitCleanup?: boolean;
  assertSocketAuthority?: (
    expected: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
  assertOpenShellExecutableAuthority?: () => void;
  afterRegistryCommit?: () => void | Promise<void>;
  observeSandbox?: HermesPortableOnboardingDeps<{ ready: true }>["observeSandbox"];
  delaySandboxReadyPublicationPoll?: HermesPortableOnboardingDeps<{
    ready: true;
  }>["delaySandboxReadyPublicationPoll"];
  readSandboxReadyPublicationClockMs?: HermesPortableOnboardingDeps<{
    ready: true;
  }>["readSandboxReadyPublicationClockMs"];
  registryOpenShellVersion?: string | null;
  registryLiveFingerprint?: string;
  omitRegistryGatewayPort?: boolean;
  existingRegistry?: boolean;
  registryEntry?: SandboxEntry | null;
  replaceRegistryBeforeRegistration?: SandboxEntry | null;
  beforeCompareAndSetRegistryGatewayPort?: (entry: SandboxEntry | null) => SandboxEntry | null;
  podmanAuthority?: HermesPortablePodmanExecutableAuthority;
  readRegistry?: () => SandboxEntry | null;
  revalidatePendingCreateRegistry?: HermesPortableOnboardingDeps<{
    ready: true;
  }>["revalidatePendingCreateRegistry"];
  compareAndSetRegistryGatewayPort?: HermesPortableOnboardingDeps<{
    ready: true;
  }>["compareAndSetRegistryGatewayPort"];
  registerSandbox?: HermesPortableOnboardingDeps<{ ready: true }>["registerSandbox"];
  createSandbox?: HermesPortableOnboardingDeps<{ ready: true }>["createSandbox"];
  expectedBuildContextPath?: string;
  expectedDockerfilePath?: string;
  policySource?: string | Buffer;
}

export function createHermesPortableTransactionFixture(
  input: HermesPortableOnboardingInput,
  options: HermesPortableTransactionFixtureOptions = {},
) {
  let present = options.existingSandbox === true;
  let restartPolicy = "no";
  let registryEntry =
    "registryEntry" in options
      ? (options.registryEntry ?? null)
      : options.existingRegistry === true
        ? matchingRegistryEntry(input, {
            ...("registryOpenShellVersion" in options
              ? { openshellVersion: options.registryOpenShellVersion }
              : {}),
            liveFingerprint: options.registryLiveFingerprint,
            omitGatewayPort: options.omitRegistryGatewayPort,
          })
        : hermesPortableReservationForOnboarding(input);
  const registryFailures = options.failAfterRegistry
    ? [new Error("simulated registry-to-active exit")]
    : [];
  const events: string[] = [];
  const podman = vi.fn((args: readonly string[]) => {
    const operation = args[0] === "ps" ? "ps" : args.slice(0, 2).join(" ");
    const handlers = new Map<
      string,
      () => { status: number | null; stdout: string; stderr: string }
    >([
      ["ps", () => ({ status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" })],
      [
        "container inspect",
        () => createHermesPortableContainerInspectResult(restartPolicy, input.sandboxName),
      ],
      ["container exec", () => ({ status: 0, stdout: "200\n", stderr: "" })],
      [
        "container update",
        () => {
          events.push("restart-policy");
          restartPolicy = options.updateFails ? restartPolicy : "unless-stopped";
          return options.updateFails
            ? { status: null, stdout: "", stderr: "timed out" }
            : { status: 0, stdout: "", stderr: "" };
        },
      ],
    ]);
    return handlers.get(operation)?.() ?? unexpectedHermesPortablePodmanArgs(args);
  });
  const value: HermesPortableOnboardingDeps<{ ready: true }> = {
    withLifecycleLock: async (_sandboxName, operation) => {
      events.push("lock-enter");
      try {
        return await withMcpLifecycleLock(input.sandboxName, operation, {
          stateDir: path.join(input.stateDir, "state"),
        });
      } finally {
        events.push("lock-exit");
      }
    },
    captureSocketAuthority: (socketPath) => {
      const directories = directoryChain(path.dirname(socketPath));
      return {
        device: "1",
        inode: "2",
        mode: "49536",
        ownerUid: String(process.getuid!()),
        socketPath,
        directoryChain: directories.map((directory, index) => ({
          device: "1",
          inode: String(index + 3),
          mode: String(index === 0 ? 0o40700 : 0o40755),
          ownerUid: String(index === 0 ? process.getuid!() : 0),
          path: directory,
        })),
      };
    },
    capturePodmanExecutableAuthority: () =>
      options.podmanAuthority ?? hermesPortableTestPodmanAuthority(),
    container: {
      podman,
      authenticatedHealth: vi.fn(() => ({ status: 0, stdout: "200\n", stderr: "" })),
      assertSocketAuthority: options.assertSocketAuthority ?? vi.fn(),
    },
    assertOpenShellExecutableAuthority: options.assertOpenShellExecutableAuthority ?? vi.fn(),
    capturePolicy: (args) => {
      events.push(args.includes("--base") ? "policy-base" : "policy-full");
      return result(String(options.policySource ?? HERMES_PORTABLE_TEST_POLICY));
    },
    observeSandbox:
      options.observeSandbox ??
      (() =>
        present
          ? {
              kind: "present",
              sandboxId: HERMES_PORTABLE_TEST_SANDBOX_ID,
              liveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
            }
          : { kind: "absent" }),
    ...(options.delaySandboxReadyPublicationPoll
      ? { delaySandboxReadyPublicationPoll: options.delaySandboxReadyPublicationPoll }
      : {}),
    ...(options.readSandboxReadyPublicationClockMs
      ? { readSandboxReadyPublicationClockMs: options.readSandboxReadyPublicationClockMs }
      : {}),
    createSandbox: async (argv, buildContextPath, effectivePolicySourcePath) => {
      events.push("create");
      if (options.createSandbox) {
        const created = await options.createSandbox(
          argv,
          buildContextPath,
          effectivePolicySourcePath,
        );
        present = true;
        return created;
      }
      const policyIndex = argv.indexOf("--policy");
      expect(argv[policyIndex + 1]).toContain("policy.");
      expect(argv[policyIndex + 1]).toBe(effectivePolicySourcePath);
      expect(argv[argv.indexOf("--from") + 1]).toBe(
        options.expectedDockerfilePath ?? "/private/staged-hermes/Dockerfile",
      );
      expect(buildContextPath).toBe(options.expectedBuildContextPath ?? "/private/staged-hermes");
      present = true;
      return { ready: true };
    },
    readRegistry: options.readRegistry ?? (() => registryEntry),
    ...(options.revalidatePendingCreateRegistry
      ? { revalidatePendingCreateRegistry: options.revalidatePendingCreateRegistry }
      : {}),
    compareAndSetRegistryGatewayPort:
      options.compareAndSetRegistryGatewayPort ??
      ((name, expected, gatewayPort) => {
        if (options.beforeCompareAndSetRegistryGatewayPort) {
          registryEntry = options.beforeCompareAndSetRegistryGatewayPort(
            registryEntry ? structuredClone(registryEntry) : null,
          );
        }
        if (
          !registryEntry ||
          registryEntry.name !== name ||
          registryEntry.gatewayPort !== undefined ||
          expected.gatewayPort !== undefined ||
          !Number.isSafeInteger(gatewayPort) ||
          gatewayPort < 1 ||
          gatewayPort > 65_535 ||
          !isDeepStrictEqual(registryEntry, expected)
        ) {
          return false;
        }
        registryEntry = { ...registryEntry, gatewayPort };
        events.push("registry-update");
        return true;
      }),
    registerSandbox:
      options.registerSandbox ??
      ((_result, _receipt, _liveIdentityFingerprint, revalidate, routeReservation) => {
        registryEntry =
          "replaceRegistryBeforeRegistration" in options
            ? (options.replaceRegistryBeforeRegistration ?? null)
            : registryEntry;
        isCurrentSandboxInferenceRouteReservation(routeReservation, registryEntry) ||
          (() => {
            throw new Error(
              "Cannot register a sandbox after its inference route reservation changed",
            );
          })();
        revalidate();
        events.push("registry");
        registryEntry = {
          ...matchingRegistryEntry(input, {
            omitGatewayPort: options.omitRegistryGatewayPort,
          }),
          pendingRouteReservation: true,
          reservationSessionId: input.inferenceRouteReservation.sessionId,
        };
        return registryEntry;
      }),
    afterRegistryCommit: async () => {
      const failure = registryFailures.shift();
      await (failure ? Promise.reject(failure) : options.afterRegistryCommit?.());
    },
    ...(options.omitCleanup
      ? {}
      : {
          cleanupTemporaryPolicy: () => {
            events.push("temp-cleanup");
            if (options.cleanupFails) return false;
            fs.unlinkSync(input.createPolicyPath);
            return true;
          },
        }),
  };
  return {
    value,
    events,
    podman,
    readRegistry: () => (registryEntry ? structuredClone(registryEntry) : null),
    updateRegistry: (name: string, updates: Partial<SandboxEntry>) => {
      if (!registryEntry || registryEntry.name !== name) return false;
      registryEntry = { ...registryEntry, ...updates };
      events.push("registry-update");
      return true;
    },
  };
}
