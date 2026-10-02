// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertHermesPortableOpenShellExecutableResolution,
  buildOpenShellSubprocessEnv,
} from "../../adapters/openshell/resolve-shared";
import {
  createPodmanExecutableOperationProof,
  resolvePodmanExecutablePath,
  type PodmanExecutableAuthorityDeps,
} from "../../adapters/podman";
import { buildHermesPortablePodmanEnvironment } from "./hermes-portable-container";
import type { HermesPortableConfiguredReceipt } from "./hermes-portable-receipt";

export interface HermesPortableOperatingFileProofDeps {
  readonly openshell?: PodmanExecutableAuthorityDeps;
  readonly podman?: PodmanExecutableAuthorityDeps;
  readonly resolveOpenShell?: (env: NodeJS.ProcessEnv) => string | null;
  readonly resolvePodman?: (env: NodeJS.ProcessEnv) => string;
}

/** Retain digests already proved by qualification; every checkpoint still checks file identity. */
export function createHermesPortableOperatingFileProof(
  receipt: Pick<
    HermesPortableConfiguredReceipt,
    "runtimeAuthority" | "openshellExecutableAuthority" | "podmanExecutableAuthority"
  >,
  env: NodeJS.ProcessEnv,
  deps: HermesPortableOperatingFileProofDeps = {},
): () => void {
  const openshell = createPodmanExecutableOperationProof(
    receipt.openshellExecutableAuthority.executable,
    deps.openshell,
  );
  const podman = createPodmanExecutableOperationProof(
    receipt.podmanExecutableAuthority.executable,
    deps.podman,
  );
  return () => {
    buildOpenShellSubprocessEnv(env, receipt.runtimeAuthority);
    buildHermesPortablePodmanEnvironment(receipt.runtimeAuthority, env);
    assertHermesPortableOpenShellExecutableResolution(receipt.openshellExecutableAuthority, env, {
      resolve: deps.resolveOpenShell,
    });
    if ((deps.resolvePodman ?? resolvePodmanExecutablePath)(env) !== podman.executablePath) {
      throw new Error("Hermes portable operating executable resolution changed during startup");
    }
    for (const proof of [openshell, podman]) {
      // A checkpoint dispatches no child. One metadata capture already guards
      // its own before/after filesystem boundary.
      proof.assertCheckpointCurrent();
    }
  };
}
