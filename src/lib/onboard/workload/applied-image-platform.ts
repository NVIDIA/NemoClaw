// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import { performance } from "node:perf_hooks";
import { inspectDockerSandboxIdentities } from "../../adapters/docker/inspect";
import { loadTelemetryConfig } from "../../actions/telemetry/send";
import type { LegacyDockerfilePlatformProof } from "../../state/registry/types";
import {
  cloneLegacyDockerfilePlatformProof,
  isRuntimeImageContentId,
} from "../../state/registry/workload";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  OPENSHELL_SANDBOX_WORKSPACE_LABEL,
} from "../openshell-docker-sandbox-containers";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";

const OBSERVATION_TIMEOUT_MS = 3_000;

/** Observe only the applied image of one verified, completed Docker sandbox. */
export function observeAppliedDockerfileImagePlatform(
  input: {
    readonly sandboxName: string;
    readonly sandboxIdentityFingerprint: string;
    readonly reference: string;
    readonly provider: RuntimeProviderBundle | null;
    readonly environment?: NodeJS.ProcessEnv;
  },
  dependencies: {
    readonly monotonicNow?: () => number;
  } = {},
): LegacyDockerfilePlatformProof | undefined {
  if (!loadTelemetryConfig(input.environment ?? process.env)) return undefined;
  const engine = input.provider?.containerEngine;
  if (
    input.provider?.identity.id !== "docker" ||
    engine?.supported !== true ||
    engine.providerId !== input.provider.identity.id ||
    !engine.identities.some(
      (identity) => identity.operation === "sandbox-lifecycle" && identity.engineId === "docker",
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.sandboxName) ||
    !/^[0-9a-f]{64}$/u.test(input.sandboxIdentityFingerprint) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u.test(input.reference)
  ) {
    return undefined;
  }
  try {
    const now = dependencies.monotonicNow ?? (() => performance.now());
    const deadline = now() + OBSERVATION_TIMEOUT_MS;
    const capture = (args: readonly string[]) => {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new Error("Applied image observation deadline expired.");
      const observed = engine.capture("sandbox-lifecycle", args, remaining);
      if (now() >= deadline) throw new Error("Applied image observation deadline expired.");
      if (observed.stdout.length > 4096)
        throw new Error("Applied image observation exceeded its output limit.");
      return observed;
    };
    const inspectIdentities = () =>
      inspectDockerSandboxIdentities(
        `${OPENSHELL_SANDBOX_NAME_LABEL}=${input.sandboxName}`,
        {
          managedBy: OPENSHELL_MANAGED_BY_LABEL,
          workspace: OPENSHELL_SANDBOX_WORKSPACE_LABEL,
          sandboxId: OPENSHELL_SANDBOX_ID_LABEL,
        },
        (args) => capture(args),
      );
    const identities = inspectIdentities();
    if (
      identities.status !== "observed" ||
      identities.malformedRows !== 0 ||
      identities.rows.length !== 1
    )
      return undefined;
    const [identity] = identities.rows;
    if (
      !identity ||
      !/^[0-9a-f]{64}$/u.test(identity.id) ||
      identity.managedBy !== OPENSHELL_MANAGED_BY_VALUE ||
      fingerprintOpenShellSandboxId(identity.sandboxId) !== input.sandboxIdentityFingerprint
    ) {
      return undefined;
    }
    const container = capture([
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Image}}",
      identity.id,
    ]);
    if (
      container.error ||
      container.status !== 0 ||
      !isRuntimeImageContentId(container.stdout.trim())
    )
      return undefined;
    const runtimeImageContentId = container.stdout.trim();
    const image = capture([
      "image",
      "inspect",
      "--format",
      "{{.Id}} {{.Os}}/{{.Architecture}}",
      input.reference,
    ]);
    if (image.error || image.status !== 0) return undefined;
    const match = image.stdout.match(/^(sha256:[0-9a-f]{64}) (linux\/(?:amd64|arm64))\r?\n?$/u);
    if (match?.[1] !== runtimeImageContentId) return undefined;
    const confirmed = inspectIdentities();
    if (
      confirmed.status !== "observed" ||
      confirmed.malformedRows !== 0 ||
      confirmed.rows.length !== 1 ||
      confirmed.rows[0]?.id !== identity.id ||
      confirmed.rows[0]?.sandboxId !== identity.sandboxId ||
      confirmed.rows[0]?.managedBy !== OPENSHELL_MANAGED_BY_VALUE
    )
      return undefined;
    return cloneLegacyDockerfilePlatformProof(
      {
        schemaVersion: 1,
        source: "applied-image-inspect",
        sandboxName: input.sandboxName,
        sandboxIdentityFingerprint: input.sandboxIdentityFingerprint,
        reference: input.reference,
        runtimeImageContentId,
        platform: match[2],
      },
      input.reference,
    );
  } catch {
    // Optional telemetry evidence must not change sandbox finalization.
    return undefined;
  }
}
