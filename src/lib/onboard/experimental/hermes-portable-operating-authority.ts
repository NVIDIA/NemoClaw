// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  captureHermesPortableOpenShellExecutableAuthority,
  buildOpenShellSubprocessEnv,
  type HermesPortableOpenShellExecutableAuthority,
} from "../../adapters/openshell/resolve-shared";
import { capturePodmanSocketAuthority, type PodmanSocketAuthority } from "../../adapters/podman";
import {
  captureHermesPortablePodmanExecutableAuthority,
  type HermesPortablePodmanExecutableAuthority,
} from "./hermes-portable-podman-authority";
import {
  assertHermesPortableDurablePolicyAuthority,
  createHermesPortableSuccessorReceipt,
  requalifyHermesPortablePolicyAuthority,
  stableHermesPortableExecutableAuthority,
  stableHermesPortableSocketAuthority,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePolicyAuthority,
  type HermesPortableReceiptSnapshot,
  type HermesPortableSuccessorReceipt,
} from "./hermes-portable-receipt";

export interface HermesPortableOperatingAuthorityDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly captureSocketAuthority?: (socketPath: string, uid: number) => PodmanSocketAuthority;
  readonly captureOpenShellExecutableAuthority?: (
    executablePath: string,
    childEnv: NodeJS.ProcessEnv,
    resolutionEnv: NodeJS.ProcessEnv,
  ) => HermesPortableOpenShellExecutableAuthority;
  readonly capturePodmanExecutableAuthority?: (
    socketAuthority: PodmanSocketAuthority,
    receipt: HermesPortableConfiguredReceipt,
    env: NodeJS.ProcessEnv,
  ) => HermesPortablePodmanExecutableAuthority;
}

export interface QualifiedHermesPortableOperatingAuthority {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly assertCurrent: () => void;
}

function fail(message: string): never {
  throw new Error(`Hermes portable schema-6 authority ${message}`);
}

function requireStableAuthority(
  expected: HermesPortableSuccessorReceipt,
  receipt: HermesPortableConfiguredReceipt,
  policy: HermesPortablePolicyAuthority,
  socket: PodmanSocketAuthority,
  openshell: HermesPortableOpenShellExecutableAuthority,
  podman: HermesPortablePodmanExecutableAuthority,
): void {
  if (
    !isDeepStrictEqual(expected.runtimeAuthority, receipt.runtimeAuthority) ||
    !isDeepStrictEqual(expected.startup, receipt.startup) ||
    !isDeepStrictEqual(expected.container, receipt.container) ||
    expected.policy.sourcePath !== policy.sourcePath ||
    expected.policy.sourceSha256 !== policy.sourceSha256 ||
    expected.policy.intendedSemanticSha256 !== policy.intendedSemanticSha256 ||
    expected.policy.size !== policy.sourceIdentity.size ||
    expected.policy.mode !== policy.sourceIdentity.mode ||
    expected.policy.uid !== policy.sourceIdentity.uid ||
    !isDeepStrictEqual(expected.socketAuthority, stableHermesPortableSocketAuthority(socket)) ||
    expected.openshellExecutableAuthority.version !== openshell.version ||
    !isDeepStrictEqual(
      expected.openshellExecutableAuthority.executable,
      stableHermesPortableExecutableAuthority(openshell.executable),
    ) ||
    expected.podmanExecutableAuthority.version !== podman.version ||
    !isDeepStrictEqual(
      expected.podmanExecutableAuthority.executable,
      stableHermesPortableExecutableAuthority(podman.executable),
    )
  ) {
    fail("current filesystem or runtime semantics disagree with durable authority");
  }
}

/** Capture one operation-local filesystem/runtime generation from durable schema-6 semantics. */
export function qualifyHermesPortableOperatingAuthority(
  snapshot: HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
  },
  deps: HermesPortableOperatingAuthorityDeps = {},
  options: { readonly permitSchema5Requalification?: boolean } = {},
): QualifiedHermesPortableOperatingAuthority {
  if (snapshot.receipt.phase !== "active") fail("requires active Hermes receipt authority");
  if (!snapshot.successor && options.permitSchema5Requalification !== true) {
    assertHermesPortableDurablePolicyAuthority(snapshot.receipt.policy);
    return {
      receipt: snapshot.receipt,
      assertCurrent: () => assertHermesPortableDurablePolicyAuthority(snapshot.receipt.policy),
    };
  }
  const env = deps.env ?? process.env;
  const expected = snapshot.successor?.receipt ?? createHermesPortableSuccessorReceipt(snapshot);
  const captureSocket =
    deps.captureSocketAuthority ??
    ((socketPath: string, uid: number) => capturePodmanSocketAuthority(socketPath, { uid }));
  const captureOpenShell =
    deps.captureOpenShellExecutableAuthority ?? captureHermesPortableOpenShellExecutableAuthority;
  const capturePodman =
    deps.capturePodmanExecutableAuthority ??
    ((socketAuthority, receipt, sourceEnv) =>
      captureHermesPortablePodmanExecutableAuthority(
        socketAuthority,
        receipt.runtimeAuthority,
        sourceEnv,
      ));
  const capture = () => {
    const policy = requalifyHermesPortablePolicyAuthority(snapshot.receipt.policy).authority;
    const socket = captureSocket(
      snapshot.receipt.runtimeAuthority.socketPath,
      snapshot.receipt.runtimeAuthority.uid,
    );
    const childEnv = buildOpenShellSubprocessEnv(env, snapshot.receipt.runtimeAuthority);
    const openshell = captureOpenShell(
      expected.openshellExecutableAuthority.executable.executablePath,
      childEnv,
      env,
    );
    const receiptWithCurrentSocket = { ...snapshot.receipt, policy, socketAuthority: socket };
    const podman = capturePodman(socket, receiptWithCurrentSocket, env);
    requireStableAuthority(expected, snapshot.receipt, policy, socket, openshell, podman);
    return {
      policy,
      socket,
      openshell,
      podman,
      receipt: {
        ...snapshot.receipt,
        policy,
        socketAuthority: socket,
        openshellExecutableAuthority: openshell,
        podmanExecutableAuthority: podman,
      } satisfies HermesPortableConfiguredReceipt,
    };
  };
  const initial = capture();
  return {
    receipt: initial.receipt,
    assertCurrent: () => {
      const current = capture();
      if (
        !isDeepStrictEqual(current.policy, initial.policy) ||
        !isDeepStrictEqual(current.socket, initial.socket) ||
        !isDeepStrictEqual(current.openshell, initial.openshell) ||
        !isDeepStrictEqual(current.podman, initial.podman)
      ) {
        fail("operation-local filesystem or runtime identity changed");
      }
    },
  };
}
