// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { redactSensitiveText } from "../../../src/lib/security/redact.ts";

import {
  assertHermesPortableOpenShellExecutableAuthority,
  captureHermesPortableOpenShellExecutableAuthority,
} from "../../../src/lib/adapters/openshell/resolve-shared.ts";
import { parseStrictOpenShellSandboxListJson } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { loadAgent } from "../../../src/lib/agent/defs.ts";
import {
  createHermesPortableBuildContextPlan,
  type HermesPortableBuildContextSettings,
} from "../../../src/lib/onboard/experimental/hermes-portable-build-context.ts";
import {
  createHermesPortableChildEnvironment,
  createHermesPortableContainerDeps,
  createHermesPortableAuthenticatedHealthCapture,
  createHermesPortableOpenShellCapture,
  observeHermesPortableSandbox,
  runHermesPortableOnboardingTransaction,
} from "../../../src/lib/onboard/experimental/hermes-portable-onboarding.ts";
import { createHermesPortableAsyncPolicyCapture } from "../../../src/lib/onboard/experimental/hermes-portable-policy-state.ts";
import { captureHermesPortablePodmanExecutableAuthority } from "../../../src/lib/onboard/experimental/hermes-portable-podman-authority.ts";
import { readHermesPortableLifecycleReceipt } from "../../../src/lib/onboard/experimental/hermes-portable-receipt.ts";
import { PORTABLE_LOCAL_SANDBOX_IMAGE_REPO } from "../../../src/lib/domain/sandbox/image-tag.ts";
import { withMcpLifecycleLock } from "../../../src/lib/state/mcp-lifecycle-lock-acquisition.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry/types.ts";
import { normalizeSandboxInferenceRouteSelection } from "../../../src/lib/state/registry/route-reservation.ts";
import { registryEntryGatewayPort } from "../../../src/lib/state/gateway-registry.ts";
import { streamSandboxCreate } from "../../../src/lib/sandbox/create-stream.ts";

export function portableHermesTransactionSandboxIsPresent(
  sandboxName: string,
  result: { status: number | null; stdout?: string | Buffer | null; error?: unknown },
): boolean {
  if (result.error || result.status !== 0) {
    throw new Error(
      `OpenShell Hermes transaction cleanup observation failed (exit ${String(result.status)})`,
    );
  }
  const sandboxes = parseStrictOpenShellSandboxListJson(String(result.stdout ?? ""));
  if (!sandboxes) {
    throw new Error("OpenShell Hermes transaction cleanup observation was malformed");
  }
  const matches = sandboxes.filter((sandbox) => sandbox.name === sandboxName);
  if (matches.length > 1) {
    throw new Error("OpenShell Hermes transaction cleanup found duplicate sandbox names");
  }
  return matches.length === 1;
}

export async function withAmbientPodmanHost<T>(host: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.CONTAINER_HOST;
  process.env.CONTAINER_HOST = host;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.CONTAINER_HOST;
    else process.env.CONTAINER_HOST = previous;
  }
}

export async function proveHermesPortableOnboardingTransaction(input: {
  artifactDir: string;
  openshellBin: string;
  openshellClientEnv: NodeJS.ProcessEnv;
  runtimeAuthority: Parameters<typeof createHermesPortableContainerDeps>[1];
  sourceRevision: string;
  sourceEnv: NodeJS.ProcessEnv;
  gatewayName: string;
  policySourcePath: string;
  buildSettings: HermesPortableBuildContextSettings;
}): Promise<void> {
  const sandboxName = `hermes-tx-${process.pid.toString(36)}`;
  const receiptStateDir = path.join(input.runtimeAuthority.homeDir, ".nemoclaw");
  const policyPath = path.join(input.runtimeAuthority.homeDir, ".hermes-transaction-policy.yaml");
  fs.writeFileSync(policyPath, fs.readFileSync(input.policySourcePath), {
    flag: "wx",
    mode: 0o600,
  });
  const sourceEnv = input.sourceEnv;
  const gatewayName = input.gatewayName;
  const childEnv = createHermesPortableChildEnvironment(sourceEnv, input.runtimeAuthority);
  const openshellExecutableAuthority = captureHermesPortableOpenShellExecutableAuthority(
    input.openshellBin,
    childEnv,
    sourceEnv,
  );
  const capture = createHermesPortableOpenShellCapture(
    (args) => [input.openshellBin, ...args],
    sourceEnv,
    input.runtimeAuthority,
    openshellExecutableAuthority,
  );
  const buildContext = createHermesPortableBuildContextPlan(
    fs.realpathSync(process.cwd()),
    input.buildSettings,
  );
  const startupArgv = [
    "env",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
    "/usr/local/bin/nemoclaw-start",
  ];
  const inferenceRouteReservation = {
    sessionId: randomUUID(),
    selection: {
      provider: "ollama-local",
      model: "qwen3-vl:4b",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
    },
  } as const;
  let registryEntry: SandboxEntry | null = {
    name: sandboxName,
    gatewayName: gatewayName,
    pendingRouteReservation: true,
    reservationSessionId: inferenceRouteReservation.sessionId,
    ...normalizeSandboxInferenceRouteSelection(inferenceRouteReservation.selection),
  };
  const imageRef: { value: string | null } = { value: null };
  const cleanupPodman: {
    current: ReturnType<typeof createHermesPortableContainerDeps>["podman"] | null;
  } = { current: null };
  let primaryFailed = false;
  let primaryFailure: unknown;
  try {
    const transaction = await runHermesPortableOnboardingTransaction(
      {
        sandboxName,
        gatewayName: gatewayName,
        lifecycleGeneration: `portable-transaction-${String(process.pid)}`,
        runtimeAuthority: input.runtimeAuthority,
        openshellExecutableAuthority,
        stateDir: receiptStateDir,
        createRequest: {
          sandboxName,
          target: { kind: "named", gatewayName: gatewayName },
          source: { reference: buildContext.sourceDockerfilePath },
          policyPath,
          startupCommand: startupArgv,
          environment: {},
        },
        createPolicyPath: policyPath,
        buildContext,
        startup: { agent: loadAgent("hermes"), sandboxName, startupArgv },
        inferenceRouteReservation,
      },
      {
        withLifecycleLock: (name, operation) =>
          withMcpLifecycleLock(name, operation, { stateDir: path.join(receiptStateDir, "state") }),
        capturePodmanExecutableAuthority: (socketAuthority) =>
          captureHermesPortablePodmanExecutableAuthority(
            socketAuthority,
            input.runtimeAuthority,
            sourceEnv,
          ),
        container: (socketAuthority, podmanAuthority) => {
          const containerDeps = createHermesPortableContainerDeps(
            socketAuthority,
            input.runtimeAuthority,
            podmanAuthority,
            sourceEnv,
          );
          cleanupPodman.current = containerDeps.podman;
          return {
            ...containerDeps,
            authenticatedHealth: createHermesPortableAuthenticatedHealthCapture(
              sandboxName,
              gatewayName,
              capture,
            ),
          };
        },
        assertOpenShellExecutableAuthority: (authority) => {
          assertHermesPortableOpenShellExecutableAuthority(authority, childEnv, sourceEnv);
        },
        capturePolicy: createHermesPortableAsyncPolicyCapture(
          () => ({ executablePath: input.openshellBin, env: childEnv }),
          5_000,
        ),
        observeSandbox: (timeoutBudgetMs) =>
          observeHermesPortableSandbox(sandboxName, gatewayName, capture, timeoutBudgetMs),
        createSandbox: async (request) => {
          imageRef.value = request.source.reference;
          const args = [
            "sandbox",
            "create",
            "-g",
            gatewayName,
            "--name",
            sandboxName,
            "--from",
            request.source.reference,
            "--policy",
            request.policyPath!,
            "--no-tty",
            "--detach",
            "--",
            ...request.startupCommand,
          ];
          const result = await streamSandboxCreate(
            "/usr/bin/timeout",
            ["--signal=TERM", "--kill-after=5s", "240s", input.openshellBin, ...args],
            input.openshellClientEnv,
            {
              initialPhase: "create",
              readyCheck: () =>
                observeHermesPortableSandbox(sandboxName, gatewayName, capture).kind === "present",
              readyCheckOutputPatterns: [],
              waitForReadyTermination: true,
            },
          );
          if (result.status !== 0) {
            throw new Error(
              `OpenShell Hermes transaction sandbox creation failed (exit ${result.status}): ${redactSensitiveText(result.output)}`,
            );
          }
          return result;
        },
        readRegistry: () => registryEntry,
        compareAndSetRegistryGatewayPort: (name, expected, gatewayPort) => {
          if (
            name !== sandboxName ||
            !registryEntry ||
            JSON.stringify(registryEntry) !== JSON.stringify(expected)
          )
            return false;
          registryEntry = { ...registryEntry, gatewayPort };
          return true;
        },
        registerSandbox: async (
          _result,
          receipt,
          liveIdentityFingerprint,
          revalidate,
          _reservation,
        ) => {
          await revalidate();
          registryEntry = {
            name: sandboxName,
            agent: "hermes",
            gatewayName: gatewayName,
            gatewayPort: registryEntryGatewayPort({
              name: sandboxName,
              gatewayName: gatewayName,
            }),
            ...normalizeSandboxInferenceRouteSelection(inferenceRouteReservation.selection),
            lifecycleGeneration: receipt.lifecycleGeneration,
            lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
            openshellDriver: "docker",
            openshellVersion: openshellExecutableAuthority.version,
            pendingRouteReservation: true,
            reservationSessionId: inferenceRouteReservation.sessionId,
          };
          return registryEntry;
        },
      },
    );
    fs.writeFileSync(
      path.join(input.artifactDir, "hermes-portable-transaction-receipt.json"),
      `${JSON.stringify(
        {
          sourceRevision: input.sourceRevision,
          sandboxName,
          created: transaction.created,
          imageRef: imageRef.value,
          transactionId: transaction.active.receipt.transactionId,
          phase: transaction.active.receipt.phase,
          podmanSocketPath: input.runtimeAuthority.socketPath,
          openShellSandboxId:
            transaction.active.receipt.phase === "active"
              ? transaction.active.receipt.container.sandboxId
              : null,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }
  const sandboxIsPresent = (): boolean =>
    portableHermesTransactionSandboxIsPresent(
      sandboxName,
      capture(["sandbox", "list", "-g", gatewayName, "-o", "json"]),
    );
  const cleanupFailures: unknown[] = [];
  try {
    if (sandboxIsPresent()) {
      // The lifecycle capture caps every command at five seconds. Sandbox
      // deletion can take longer while OpenShell settles its container.
      assertHermesPortableOpenShellExecutableAuthority(
        openshellExecutableAuthority,
        childEnv,
        sourceEnv,
      );
      const deletion = spawnSync(
        input.openshellBin,
        ["sandbox", "delete", "-g", gatewayName, sandboxName],
        {
          encoding: "utf-8",
          env: childEnv,
          killSignal: "SIGKILL",
          maxBuffer: 512 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 240_000,
        },
      );
      if (deletion.status !== 0 || deletion.error) {
        throw new Error(
          `OpenShell Hermes transaction sandbox deletion failed (exit ${String(deletion.status)}): ${redactSensitiveText(`${deletion.error?.message ?? ""}\n${deletion.stderr ?? ""}\n${deletion.stdout ?? ""}`)}`,
        );
      }
    }
    const absenceDeadline = Date.now() + 30_000;
    while (sandboxIsPresent()) {
      if (Date.now() >= absenceDeadline) {
        throw new Error("OpenShell Hermes transaction sandbox remained after cleanup");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    const receipt = readHermesPortableLifecycleReceipt(sandboxName, receiptStateDir);
    const builtImageRef =
      imageRef.value ??
      (receipt ? `${PORTABLE_LOCAL_SANDBOX_IMAGE_REPO}:${receipt.receipt.transactionId}` : null);
    if (!primaryFailed && (!builtImageRef || !cleanupPodman.current)) {
      throw new Error("Successful Hermes transaction did not retain image cleanup authority");
    }
    if (builtImageRef && cleanupPodman.current) {
      const removal = cleanupPodman.current(["image", "rm", "--force", builtImageRef], 15_000);
      if (removal.status !== 0 || removal.error) {
        throw new Error(
          `Hermes transaction image removal failed: ${redactSensitiveText(String(removal.stderr))}`,
        );
      }
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    fs.rmSync(policyPath, { force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (primaryFailed && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Hermes transaction and cleanup failed",
      {
        cause: primaryFailure,
      },
    );
  }
  if (primaryFailed) throw primaryFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Hermes transaction cleanup failed");
  }
}
