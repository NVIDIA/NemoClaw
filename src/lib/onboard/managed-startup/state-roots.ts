// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { ManagedStartupAgent } from "./profile";

export interface ManagedStartupStateRoot {
  readonly mountTarget: string;
  readonly resourceIdentity: string;
  readonly ownershipLabels: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly readWrite: boolean;
}

export interface ManagedStartupWorkspaceRoot {
  readonly uid: number;
  readonly gid: number;
  readonly mode: 0o755 | 0o1775;
}

type ManagedStartupStateRootDeclaration = {
  readonly mountTarget: string;
  readonly resourceIdentity: (sandboxName: string) => string;
  readonly ownershipLabels: (
    sandboxName: string,
    mountTarget: string,
  ) => Readonly<Record<string, string>>;
  readonly uidAuthority: "agent";
  readonly gidAuthority: "agent";
  readonly mode: number;
  readonly readWrite: true;
};

export const MANAGED_HERMES_STATE_ROOT = "/sandbox/.hermes" as const;
export const MANAGED_OPENCLAW_STATE_ROOT = "/sandbox/.openclaw" as const;
const HERMES_STATE_VOLUME_NAME_PREFIX = "nemoclaw-hermes-state-v1";
const OPENCLAW_STATE_VOLUME_NAME_PREFIX = "nemoclaw-openclaw-state-v1";

/**
 * RFC_9909_FOLLOW_UP
 *
 * Temporary core-owned registry for agent-specific managed state-root
 * declarations. Runtime providers consume only the resulting generic
 * ManagedStartupStateRoot list and must not compare or branch on agent IDs.
 *
 * Follow-up ownership: the RFC #9909 implementation epic, once created.
 * Do not invent an issue number here. Replace this breadcrumb with the epic
 * number when that epic exists.
 *
 * Removal condition: agent packages/manifests can declare validated managed
 * state roots without adding agent IDs or production logic to NemoClaw core.
 */
const MANAGED_AGENT_STATE_ROOTS = Object.freeze({
  openclaw: Object.freeze([
    Object.freeze({
      mountTarget: MANAGED_OPENCLAW_STATE_ROOT,
      resourceIdentity: (sandboxName: string) =>
        `${OPENCLAW_STATE_VOLUME_NAME_PREFIX}-${sandboxName}`,
      ownershipLabels: (sandboxName: string, mountTarget: string) =>
        Object.freeze({
          "io.nvidia.nemoclaw.openclaw-state.managed": "true",
          "io.nvidia.nemoclaw.openclaw-state.schema": "1",
          "io.nvidia.nemoclaw.openclaw-state.sandbox": sandboxName,
          "io.nvidia.nemoclaw.openclaw-state.target": mountTarget,
        }),
      uidAuthority: "agent",
      gidAuthority: "agent",
      mode: 0o2770,
      readWrite: true,
    } satisfies ManagedStartupStateRootDeclaration),
  ]),
  hermes: Object.freeze([
    Object.freeze({
      mountTarget: MANAGED_HERMES_STATE_ROOT,
      resourceIdentity: (sandboxName: string) =>
        `${HERMES_STATE_VOLUME_NAME_PREFIX}-${sandboxName}`,
      ownershipLabels: (sandboxName: string, mountTarget: string) =>
        Object.freeze({
          "io.nvidia.nemoclaw.hermes-state.managed": "true",
          "io.nvidia.nemoclaw.hermes-state.schema": "1",
          "io.nvidia.nemoclaw.hermes-state.sandbox": sandboxName,
          "io.nvidia.nemoclaw.hermes-state.target": mountTarget,
        }),
      uidAuthority: "agent",
      gidAuthority: "agent",
      mode: 0o3770,
      readWrite: true,
    } satisfies ManagedStartupStateRootDeclaration),
  ]),
  "langchain-deepagents-code": Object.freeze([]),
  pi: Object.freeze([]),
} satisfies Record<ManagedStartupAgent, readonly ManagedStartupStateRootDeclaration[]>);

export function managedStartupStateRootMountTargets(agent: ManagedStartupAgent): readonly string[] {
  return Object.freeze(MANAGED_AGENT_STATE_ROOTS[agent].map(({ mountTarget }) => mountTarget));
}

const MANAGED_AGENT_WORKSPACE_ROOTS = Object.freeze({
  openclaw: Object.freeze({ uidAuthority: "agent", gidAuthority: "agent", mode: 0o755 }),
  hermes: Object.freeze({ uidAuthority: "agent", gidAuthority: "agent", mode: 0o755 }),
  "langchain-deepagents-code": Object.freeze({
    uidAuthority: "root",
    gidAuthority: "agent",
    mode: 0o1775,
  }),
  pi: Object.freeze({ uidAuthority: "agent", gidAuthority: "agent", mode: 0o755 }),
} satisfies Record<
  ManagedStartupAgent,
  {
    readonly uidAuthority: "agent" | "root";
    readonly gidAuthority: "agent";
    readonly mode: ManagedStartupWorkspaceRoot["mode"];
  }
>);

function exactSandboxName(sandboxName: string): string {
  if (
    sandboxName.length === 0 ||
    sandboxName.includes("\0") ||
    sandboxName.includes("/") ||
    sandboxName === "." ||
    sandboxName === ".."
  ) {
    throw new Error("Managed startup state-root sandbox identity is invalid.");
  }
  return sandboxName;
}

function exactAgentIdentity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`Managed startup state-root ${label} authority is invalid.`);
  }
  return value;
}

export function managedStartupWorkspaceRoot(input: {
  readonly agent: ManagedStartupAgent;
  readonly agentIdentity: { readonly uid: number; readonly gid: number };
}): ManagedStartupWorkspaceRoot {
  const uid = exactAgentIdentity(input.agentIdentity.uid, "workspace UID");
  const gid = exactAgentIdentity(input.agentIdentity.gid, "workspace GID");
  const declaration = MANAGED_AGENT_WORKSPACE_ROOTS[input.agent];
  return Object.freeze({
    uid: declaration.uidAuthority === "root" ? 0 : uid,
    gid,
    mode: declaration.mode,
  });
}

export function managedStartupStateRoots(input: {
  readonly agent: ManagedStartupAgent;
  readonly sandboxName: string;
  readonly agentIdentity: { readonly uid: number; readonly gid: number };
}): readonly ManagedStartupStateRoot[] {
  const sandboxName = exactSandboxName(input.sandboxName);
  const uid = exactAgentIdentity(input.agentIdentity.uid, "UID");
  const gid = exactAgentIdentity(input.agentIdentity.gid, "GID");
  return Object.freeze(
    MANAGED_AGENT_STATE_ROOTS[input.agent].map((declaration) => {
      const mountTarget: string = declaration.mountTarget;
      if (
        !path.posix.isAbsolute(mountTarget) ||
        path.posix.normalize(mountTarget) !== mountTarget ||
        mountTarget === "/"
      ) {
        throw new Error("Managed startup state-root mount target is invalid.");
      }
      const resourceIdentity = declaration.resourceIdentity(sandboxName);
      return Object.freeze({
        mountTarget,
        resourceIdentity,
        ownershipLabels: declaration.ownershipLabels(sandboxName, mountTarget),
        uid,
        gid,
        mode: declaration.mode,
        readWrite: declaration.readWrite,
      });
    }),
  );
}

export function managedHermesStateVolumeName(sandboxName: string): string {
  return `${HERMES_STATE_VOLUME_NAME_PREFIX}-${exactSandboxName(sandboxName)}`;
}

export function managedHermesStateVolumeLabels(
  sandboxName: string,
): Readonly<Record<string, string>> {
  const [root] = managedStartupStateRoots({
    agent: "hermes",
    sandboxName,
    agentIdentity: { uid: 0, gid: 0 },
  });
  return root?.ownershipLabels ?? Object.freeze({});
}
