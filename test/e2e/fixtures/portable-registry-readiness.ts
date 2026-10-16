// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
} from "../../../tools/e2e/retry-evidence.mts";
import type { ArtifactSink } from "./artifacts.ts";
import { buildChildEnv } from "./redaction.ts";
import { type ShellProbe, trustedShellCommand } from "./shell-probe.ts";

export type PortableRegistryReadinessObservation =
  | { readonly kind: "ready"; readonly statusCode: 200 }
  | { readonly kind: "http-status"; readonly statusCode: number }
  | {
      readonly kind: "transport";
      readonly code: "connection-refused" | "connection-reset" | "timeout" | "unexpected";
    };

export const PORTABLE_REGISTRY_READINESS_MAX_ATTEMPTS = 10;
export const PORTABLE_REGISTRY_READINESS_DELAY_MS = 1_000;

const PORTABLE_REGISTRY_DIAGNOSTIC_ENV_KEYS = [
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
  "DOCKER_HOST",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

function retryableTransport(observation: PortableRegistryReadinessObservation): boolean {
  return observation.kind === "transport" && observation.code !== "unexpected";
}

/**
 * Wait for the managed registry through a bounded read-only policy.
 *
 * Connection refusal, reset, and timeout are the only transient startup
 * signatures. An HTTP response other than the unauthenticated registry 200,
 * or an unknown transport failure, stops immediately for diagnostics.
 */
export async function runPortableRegistryReadinessPolicy(options: {
  readonly probe: (attempt: number) => Promise<PortableRegistryReadinessObservation>;
  readonly onEvidence?: (evidence: RetryEvidence) => Promise<void> | void;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<BoundedRetryResult<PortableRegistryReadinessObservation>> {
  return runBoundedRetry({
    operation: "portable-registry.http-readiness",
    owner: "portable-profile-rootless-linux",
    idempotence: "read-only",
    maxAttempts: options.maxAttempts ?? PORTABLE_REGISTRY_READINESS_MAX_ATTEMPTS,
    delayMs: options.delayMs ?? PORTABLE_REGISTRY_READINESS_DELAY_MS,
    run: options.probe,
    classify: (observation, error) => {
      if (error !== undefined || observation === undefined) {
        return { outcome: "failed", failureClass: "deterministic" };
      }
      if (observation.kind === "ready") return { outcome: "passed" };
      return {
        outcome: "failed",
        failureClass: retryableTransport(observation) ? "transient-external" : "deterministic",
      };
    },
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onEvidence ? { onEvidence: options.onEvidence } : {}),
  });
}

export async function probePortableRegistry(
  url = "http://127.0.0.1:5000/v2/",
): Promise<PortableRegistryReadinessObservation> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (observation: PortableRegistryReadinessObservation): void => {
      if (settled) return;
      settled = true;
      resolve(observation);
    };
    const request = http.get(url, (response) => {
      const responseFailure = (): void => {
        settle({ kind: "transport", code: "unexpected" });
      };
      response.once("aborted", responseFailure);
      response.once("error", responseFailure);
      response.once("close", () => {
        if (!response.complete) responseFailure();
      });
      response.resume();
      response.once("end", () =>
        settle(
          response.statusCode === 200
            ? { kind: "ready", statusCode: 200 }
            : { kind: "http-status", statusCode: response.statusCode ?? 0 },
        ),
      );
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      const code =
        error.code === "ECONNREFUSED"
          ? "connection-refused"
          : error.code === "ECONNRESET"
            ? "connection-reset"
            : error.code === "ETIMEDOUT"
              ? "timeout"
              : "unexpected";
      settle({ kind: "transport", code });
    });
    request.setTimeout(500, () => {
      settle({ kind: "transport", code: "timeout" });
      request.destroy();
    });
  });
}

async function captureRegistryFailureDiagnostics(shellProbe: ShellProbe): Promise<void> {
  const env = buildChildEnv(process.env, {
    additionalAllowedEnv: PORTABLE_REGISTRY_DIAGNOSTIC_ENV_KEYS,
    fixtureOverlay: {},
  });
  const commands = [
    {
      artifactName: "portable-registry-container-inspect",
      args: [
        "container",
        "inspect",
        "--format",
        [
          "id={{.Id}}",
          "name={{.Name}}",
          "status={{.State.Status}}",
          "running={{.State.Running}}",
          "exit_code={{.State.ExitCode}}",
          "error={{.State.Error}}",
        ].join("\\n"),
        "nemoclaw-portable-registry",
      ],
      reason: "capture the managed registry container state after readiness failure",
    },
    {
      artifactName: "portable-registry-port-mapping",
      args: ["port", "nemoclaw-portable-registry", "5000/tcp"],
      reason: "capture the managed registry published port after readiness failure",
    },
    {
      artifactName: "portable-registry-log-tail",
      args: ["logs", "--tail", "50", "nemoclaw-portable-registry"],
      reason: "capture a bounded managed registry log tail after readiness failure",
    },
  ] as const;
  await Promise.allSettled(
    commands.map((command) =>
      shellProbe.run(
        trustedShellCommand({
          command: "podman",
          args: command.args,
          reason: command.reason,
        }),
        {
          artifactName: command.artifactName,
          captureLimitBytes: 32 * 1024,
          env,
          timeoutMs: 10_000,
        },
      ),
    ),
  );
}

export async function collectPortableRegistryReadinessFailure(options: {
  readonly artifacts: ArtifactSink;
  readonly probe?: (attempt: number) => Promise<PortableRegistryReadinessObservation>;
  readonly shellProbe: ShellProbe;
}): Promise<PortableRegistryReadinessObservation | undefined> {
  const result = await runPortableRegistryReadinessPolicy({
    probe: options.probe ?? (() => probePortableRegistry()),
    onEvidence: async (evidence) => {
      await options.artifacts.writeJson("portable-registry-readiness-retry.json", evidence);
    },
  });
  if (result.outcome === "passed") return undefined;
  await options.artifacts.writeJson("portable-registry-readiness-failure.json", {
    observation: result.value ?? null,
  });
  await captureRegistryFailureDiagnostics(options.shellProbe);
  return result.value;
}
