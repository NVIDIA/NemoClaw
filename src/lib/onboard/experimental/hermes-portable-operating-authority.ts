// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  assertHermesPortableOpenShellExecutableFileAuthority,
  captureHermesPortableOpenShellExecutableAuthority,
  buildOpenShellSubprocessEnv,
  type HermesPortableOpenShellExecutableAuthority,
} from "../../adapters/openshell/resolve-shared";
import {
  capturePodmanSocketAuthority,
  resolvePodmanExecutablePath,
  type PodmanExecutableAuthorityTimingStage,
  type PodmanSocketAuthority,
} from "../../adapters/podman";
import {
  captureHermesPortablePodmanExecutableAuthority,
  captureHermesPortablePodmanExecutableFileAuthority,
  type HermesPortablePodmanAuthorityDeps,
  type HermesPortablePodmanExecutableAuthority,
} from "./hermes-portable-podman-authority";
import {
  createHermesPortableSuccessorReceipt,
  stableHermesPortableExecutableAuthority,
  stableHermesPortableSocketAuthority,
  type HermesPortableConfiguredReceipt,
  type HermesPortableReceiptSnapshot,
  type HermesPortableStableSocketAuthority,
  type HermesPortableSuccessorReceipt,
} from "./hermes-portable-receipt";

export type HermesPortableOperatingAuthorityTimingStage =
  | "socketAuthority"
  | "openshellExecutable"
  | "podmanExecutable"
  | "podmanPathResolution"
  | PodmanExecutableAuthorityTimingStage
  | "transactionCompare";

export interface HermesPortableOperatingAuthorityTiming {
  readonly measure: <T>(
    stage: HermesPortableOperatingAuthorityTimingStage,
    operation: () => T,
  ) => T;
}

export interface HermesPortableOperatingAuthorityDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly timing?: HermesPortableOperatingAuthorityTiming;
  readonly podmanAuthorityDeps?: HermesPortablePodmanAuthorityDeps;
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
  readonly assertOpenShellExecutableFileAuthority?: (
    expected: HermesPortableOpenShellExecutableAuthority,
    resolutionEnv: NodeJS.ProcessEnv,
  ) => string;
  readonly capturePodmanExecutableFileAuthority?: (
    socketAuthority: PodmanSocketAuthority,
    receipt: HermesPortableConfiguredReceipt,
    env: NodeJS.ProcessEnv,
  ) => HermesPortablePodmanExecutableAuthority;
}

export interface QualifiedHermesPortableOperatingAuthority {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly assertTransactionCurrent: () => void;
  readonly assertCurrent: () => void;
}

function fail(message: string): never {
  throw new Error(`Hermes portable schema-8 authority ${message}`);
}

const MODE_TYPE_MASK = 0o170000n;
const DIRECTORY_MODE = 0o040000n;
const SOCKET_MODE = 0o140000n;

function parsedMode(value: string): bigint | null {
  if (!/^[0-9]+$/u.test(value)) return null;
  const mode = BigInt(value);
  return mode <= 0o177777n ? mode : null;
}

function hasSafeDirectoryMode(value: string): boolean {
  const mode = parsedMode(value);
  return mode !== null && (mode & MODE_TYPE_MASK) === DIRECTORY_MODE && (mode & 0o022n) === 0n;
}

function hasSafeSocketMode(socketMode: string, parentMode: string | undefined): boolean {
  const mode = parsedMode(socketMode);
  const parent = parentMode === undefined ? null : parsedMode(parentMode);
  return (
    mode !== null &&
    parent !== null &&
    (mode & MODE_TYPE_MASK) === SOCKET_MODE &&
    (mode & 0o002n) === 0n &&
    ((mode & 0o020n) === 0n || (parent & 0o077n) === 0n)
  );
}

function sameStableSocketSemantics(
  expected: HermesPortableStableSocketAuthority,
  currentSocket: PodmanSocketAuthority,
): boolean {
  const current = stableHermesPortableSocketAuthority(currentSocket);
  if (
    expected.socketPath !== current.socketPath ||
    expected.mode !== current.mode ||
    expected.ownerUid !== current.ownerUid ||
    expected.directoryChain.length !== current.directoryChain.length ||
    !hasSafeSocketMode(expected.mode, expected.directoryChain[0]?.mode) ||
    !hasSafeSocketMode(current.mode, current.directoryChain[0]?.mode)
  ) {
    return false;
  }
  return expected.directoryChain.every((component, index) => {
    const candidate = current.directoryChain[index];
    return (
      candidate !== undefined &&
      component.path === candidate.path &&
      component.ownerUid === candidate.ownerUid &&
      hasSafeDirectoryMode(component.mode) &&
      hasSafeDirectoryMode(candidate.mode)
    );
  });
}

function requireStableAuthority(
  expected: HermesPortableSuccessorReceipt,
  receipt: HermesPortableConfiguredReceipt,
  socket: PodmanSocketAuthority,
  openshell: HermesPortableOpenShellExecutableAuthority,
  podman: HermesPortablePodmanExecutableAuthority,
): void {
  if (
    !isDeepStrictEqual(expected.runtimeAuthority, receipt.runtimeAuthority) ||
    !isDeepStrictEqual(expected.startup, receipt.startup) ||
    !isDeepStrictEqual(expected.container, receipt.container) ||
    !sameStableSocketSemantics(expected.socketAuthority, socket) ||
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

/** Capture one operation-local filesystem/runtime generation from durable schema-8 semantics. */
export function qualifyHermesPortableOperatingAuthority(
  snapshot: HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
  },
  deps: HermesPortableOperatingAuthorityDeps = {},
  options: { readonly permitSchema5Requalification?: boolean } = {},
): QualifiedHermesPortableOperatingAuthority {
  if (snapshot.receipt.phase !== "active") fail("requires active Hermes receipt authority");
  if (!snapshot.successor && options.permitSchema5Requalification !== true) {
    return {
      receipt: snapshot.receipt,
      assertTransactionCurrent: () =>
        fail("transaction currentness requires durable successor authority"),
      assertCurrent: () => undefined,
    };
  }
  const env = deps.env ?? process.env;
  const measure = deps.timing?.measure ?? ((_stage, operation) => operation());
  const expected = snapshot.successor?.receipt ?? createHermesPortableSuccessorReceipt(snapshot);
  const captureSocket =
    deps.captureSocketAuthority ??
    ((socketPath: string, uid: number) => capturePodmanSocketAuthority(socketPath, { uid }));
  const captureOpenShell =
    deps.captureOpenShellExecutableAuthority ?? captureHermesPortableOpenShellExecutableAuthority;
  const podmanAuthorityDeps = {
    ...deps.podmanAuthorityDeps,
    executableAuthorityDeps: {
      ...deps.podmanAuthorityDeps?.executableAuthorityDeps,
      timing: { measure },
    },
    resolveExecutablePath:
      deps.podmanAuthorityDeps?.resolveExecutablePath ??
      ((sourceEnv: NodeJS.ProcessEnv) => resolvePodmanExecutablePath(sourceEnv, { measure })),
  } satisfies HermesPortablePodmanAuthorityDeps;
  const capturePodman =
    deps.capturePodmanExecutableAuthority ??
    ((socketAuthority, receipt, sourceEnv) =>
      captureHermesPortablePodmanExecutableAuthority(
        socketAuthority,
        receipt.runtimeAuthority,
        sourceEnv,
        podmanAuthorityDeps,
      ));
  const assertOpenShellFile =
    deps.assertOpenShellExecutableFileAuthority ??
    ((expected: HermesPortableOpenShellExecutableAuthority, resolutionEnv: NodeJS.ProcessEnv) =>
      assertHermesPortableOpenShellExecutableFileAuthority(expected, resolutionEnv));
  const capturePodmanFile =
    deps.capturePodmanExecutableFileAuthority ??
    ((socketAuthority, receipt, sourceEnv) =>
      captureHermesPortablePodmanExecutableFileAuthority(
        socketAuthority,
        receipt,
        sourceEnv,
        podmanAuthorityDeps,
      ));
  const capture = () => {
    const socket = measure("socketAuthority", () =>
      captureSocket(
        snapshot.receipt.runtimeAuthority.socketPath,
        snapshot.receipt.runtimeAuthority.uid,
      ),
    );
    const childEnv = buildOpenShellSubprocessEnv(env, snapshot.receipt.runtimeAuthority);
    const openshell = measure("openshellExecutable", () =>
      captureOpenShell(
        expected.openshellExecutableAuthority.executable.executablePath,
        childEnv,
        env,
      ),
    );
    const receiptWithCurrentSocket = { ...snapshot.receipt, socketAuthority: socket };
    const podman = measure("podmanExecutable", () =>
      capturePodman(socket, receiptWithCurrentSocket, env),
    );
    measure("transactionCompare", () =>
      requireStableAuthority(expected, snapshot.receipt, socket, openshell, podman),
    );
    return {
      socket,
      openshell,
      podman,
      receipt: {
        ...snapshot.receipt,
        socketAuthority: socket,
        openshellExecutableAuthority: openshell,
        podmanExecutableAuthority: podman,
      } satisfies HermesPortableConfiguredReceipt,
    };
  };
  const initial = capture();
  const assertTransactionCurrent = (): void => {
    const socket = measure("socketAuthority", () =>
      captureSocket(
        snapshot.receipt.runtimeAuthority.socketPath,
        snapshot.receipt.runtimeAuthority.uid,
      ),
    );
    buildOpenShellSubprocessEnv(env, snapshot.receipt.runtimeAuthority);
    measure("openshellExecutable", () => assertOpenShellFile(initial.openshell, env));
    const receiptWithCurrentSocket = { ...snapshot.receipt, socketAuthority: socket };
    const podman = measure("podmanExecutable", () =>
      capturePodmanFile(socket, receiptWithCurrentSocket, env),
    );
    measure("transactionCompare", () => {
      requireStableAuthority(expected, snapshot.receipt, socket, initial.openshell, podman);
      if (
        !isDeepStrictEqual(socket, initial.socket) ||
        !isDeepStrictEqual(podman, initial.podman)
      ) {
        fail("operation-local filesystem or runtime identity changed");
      }
    });
  };
  return {
    receipt: initial.receipt,
    assertTransactionCurrent,
    assertCurrent: () => {
      const current = capture();
      if (
        !isDeepStrictEqual(current.socket, initial.socket) ||
        !isDeepStrictEqual(current.openshell, initial.openshell) ||
        !isDeepStrictEqual(current.podman, initial.podman)
      ) {
        fail("operation-local filesystem or runtime identity changed");
      }
    },
  };
}
