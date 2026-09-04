// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { ManagedStartupStateRoot } from "../managed-startup/state-roots";

type JsonRecord = Record<string, unknown>;

export interface ManagedBootstrapStateRootReceipt {
  readonly mountTarget: string;
  readonly resourceIdentity: string;
  readonly mountpoint: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly readWrite: boolean;
  readonly prepared: boolean;
}

export interface ManagedBootstrapStateRootPreparation {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

type ManagedBootstrapStateRootPreparationReceipt = ManagedBootstrapStateRootPreparation & {
  readonly device: string;
  readonly inode: string;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Managed bootstrap ${label} is invalid.`);
  }
  return value as JsonRecord;
}

function exactMountpoint(value: unknown): string {
  const mountpoint = typeof value === "string" ? value : "";
  if (
    !path.isAbsolute(mountpoint) ||
    path.normalize(mountpoint) !== mountpoint ||
    mountpoint === path.parse(mountpoint).root
  ) {
    throw new Error("Managed bootstrap state-root mountpoint authority is invalid.");
  }
  return mountpoint;
}

function volumeEvidence(
  root: ManagedStartupStateRoot,
  captureVolume: (args: readonly string[]) => string,
): {
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, unknown>>;
} {
  const output = captureVolume([
    "inspect",
    "--format",
    "{{.Name}}\n{{.Mountpoint}}\n{{json .Labels}}",
    root.resourceIdentity,
  ]).trimEnd();
  const separator = output.lastIndexOf("\n");
  if (separator < 0) {
    throw new Error("Managed bootstrap state-root resource evidence is incomplete.");
  }
  const identity = output.slice(0, separator);
  const identitySeparator = identity.indexOf("\n");
  if (identitySeparator < 0 || identity.slice(0, identitySeparator) !== root.resourceIdentity) {
    throw new Error("Managed bootstrap state-root resource identity changed.");
  }
  const mountpoint = exactMountpoint(identity.slice(identitySeparator + 1));
  let labels: unknown;
  try {
    labels = JSON.parse(output.slice(separator + 1));
  } catch {
    throw new Error("Managed bootstrap state-root ownership labels are invalid.");
  }
  const observedLabels = record(labels, "state-root ownership labels");
  if (
    !Object.entries(root.ownershipLabels).every(([name, value]) => observedLabels[name] === value)
  ) {
    throw new Error("Managed bootstrap state-root resource ownership changed.");
  }
  return Object.freeze({
    mountpoint,
    labels: Object.freeze({ ...observedLabels }),
  });
}

function exactContainerMount(
  inspect: JsonRecord,
  root: ManagedStartupStateRoot,
  mountpoint: string,
): void {
  if (!Array.isArray(inspect.Mounts)) {
    throw new Error("Managed bootstrap state-root mount inventory is invalid.");
  }
  const matches = inspect.Mounts.map((value) => record(value, "state-root mount")).filter(
    (mount) => mount.Destination === root.mountTarget,
  );
  if (matches.length !== 1) {
    throw new Error("Managed bootstrap state root must resolve to one exact mount.");
  }
  const mount = matches[0] as JsonRecord;
  const driver = mount.Driver;
  if (
    mount.Type !== "volume" ||
    mount.Name !== root.resourceIdentity ||
    mount.Source !== mountpoint ||
    mount.RW !== root.readWrite ||
    (driver !== undefined && driver !== "" && driver !== "local")
  ) {
    throw new Error("Managed bootstrap state-root mount authority changed.");
  }
}

export function prepareManagedBootstrapStateRoots(input: {
  readonly inspect: JsonRecord;
  readonly roots: readonly ManagedStartupStateRoot[];
  readonly captureVolume: (args: readonly string[]) => string;
  readonly prepareRoot?: (
    input: ManagedBootstrapStateRootPreparation,
  ) => ManagedBootstrapStateRootPreparationReceipt;
}): readonly ManagedBootstrapStateRootReceipt[] {
  return Object.freeze(
    input.roots.map((root) => {
      const evidence = volumeEvidence(root, input.captureVolume);
      exactContainerMount(input.inspect, root, evidence.mountpoint);
      const preparation = Object.freeze({
        path: evidence.mountpoint,
        uid: root.uid,
        gid: root.gid,
        mode: root.mode,
      });
      const receipt = input.prepareRoot?.(preparation);
      if (
        receipt &&
        (receipt.path !== preparation.path ||
          receipt.uid !== preparation.uid ||
          receipt.gid !== preparation.gid ||
          receipt.mode !== preparation.mode ||
          !/^\d+$/u.test(receipt.device) ||
          !/^\d+$/u.test(receipt.inode))
      ) {
        throw new Error("Managed bootstrap state-root preparation receipt is invalid.");
      }
      return Object.freeze({
        mountTarget: root.mountTarget,
        resourceIdentity: root.resourceIdentity,
        mountpoint: evidence.mountpoint,
        uid: root.uid,
        gid: root.gid,
        mode: root.mode,
        readWrite: root.readWrite,
        prepared: receipt !== undefined,
      });
    }),
  );
}
