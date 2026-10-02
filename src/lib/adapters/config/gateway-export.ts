// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidNemoClawPort } from "../../config/model";
import { isExternalHttpGatewayOrigin } from "../../core/gateway-address";
import type {
  ExportSnapshotReadStage,
  ObservedExportGateway,
} from "../../domain/config/export-evidence";
import { isWsl } from "../../core/wsl";
import { loadGatewayManagementDeclaration } from "../../onboard/gateway-management";
import { gatewayOwnerFromCheckpoint } from "../../onboard/gateway-authority-checkpoint";
import { resolveGatewayName } from "../../onboard/gateway-binding/identity";
import {
  evaluateGatewayAttachment,
  resolveGatewayOwner,
  sameGatewayOwner,
  type GatewayOwner,
} from "../../onboard/gateway-ownership";
import {
  managedGatewayStateRootOwnershipFailure,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway/state-dir";
import { inspectCheckpoint } from "../../state/onboard-checkpoint";
import { onboardStateRoot } from "../../state/onboard-session/lock";
import type { SandboxEntry } from "../../state/registry/types";
import { createProductionGatewayReadinessDependencies } from "../../readiness/gateway-production";
import { openRegularFileNoFollow } from "../fs/regular-file";
import { observeOpenShellGatewayRegistration } from "../openshell/gateway-reuse-cli";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { connectExternalHttpOpenShellSdk } from "../openshell/sdk";
import type { OpenShellReadClient, ConnectOpenShellReader } from "../openshell/sdk-read";
import { buildOpenShellSubprocessEnv } from "../openshell/resolve-shared";

export function createExportGatewayConnection(gateway: ObservedExportGateway, signal: AbortSignal) {
  const endpoint = gateway.external?.endpoint;
  if (!endpoint) return undefined;
  const connect: ConnectOpenShellReader = async (target) =>
    (await connectExternalHttpOpenShellSdk(target, endpoint, { signal })) as OpenShellReadClient;
  let temporaryHome: string | undefined;
  return {
    connect,
    captureInferenceRoute: (
      args: string[],
      options: Parameters<typeof captureSanitizedResolvedOpenshell>[1],
    ) => {
      temporaryHome ??= fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-export-gateway-"));
      return captureExternalInferenceRoute(args, options, endpoint, temporaryHome);
    },
    removeTemporaryHome(): string | null {
      const home = temporaryHome;
      if (!home) return null;
      try {
        fs.rmSync(home, { recursive: true, force: true });
        temporaryHome = undefined;
        return null;
      } catch {
        return path.basename(home);
      }
    },
  };
}

export type ExportGatewayConnection = ReturnType<typeof createExportGatewayConnection>;

function captureExternalInferenceRoute(
  args: string[],
  options: Parameters<typeof captureSanitizedResolvedOpenshell>[1],
  endpoint: string,
  temporaryHome: string,
) {
  return captureSanitizedResolvedOpenshell(args, {
    ...options,
    env: {
      ...buildOpenShellSubprocessEnv(),
      HOME: temporaryHome,
      XDG_CONFIG_HOME: path.join(temporaryHome, "config"),
      XDG_CACHE_HOME: path.join(temporaryHome, "cache"),
      XDG_DATA_HOME: path.join(temporaryHome, "data"),
      XDG_STATE_HOME: path.join(temporaryHome, "state"),
      OPENSHELL_SYSTEM_GATEWAY_DIR: path.join(temporaryHome, "system"),
      OPENSHELL_GATEWAY_ENDPOINT: endpoint,
      OPENSHELL_WORKSPACE: "default",
    } as Record<string, string>,
    replaceEnv: true,
  });
}

function resolveExportGatewayBinding(entry: Readonly<SandboxEntry>) {
  const port = entry.gatewayPort;
  if (!isValidNemoClawPort(port)) throw new Error("The persisted gateway port is invalid.");
  const name = resolveGatewayName(port);
  if (entry.gatewayName !== name) throw new Error("Gateway name and port disagree.");
  return { name, port };
}

function inspectRecordedOwner(value: unknown): GatewayOwner | null {
  const raw = value && typeof value === "object" && "checkpoint" in value ? value.checkpoint : null;
  const inspected = inspectCheckpoint(raw);
  if (inspected.status === "none" || inspected.status === "legacy") return null;
  if (inspected.status !== "loaded") throw new Error("Gateway checkpoint could not be verified.");
  const authority = inspected.checkpoint.gatewayAuthority;
  if (authority.kind === "unset") return null;
  if (authority.kind !== "selected") throw new Error("Gateway authority was not selected.");
  return gatewayOwnerFromCheckpoint(authority.value);
}

function readRecordedOwner(port: number): GatewayOwner | null {
  const sessionPath = path.join(onboardStateRoot(os.homedir(), port), "onboard-session.json");
  if (!fs.lstatSync(sessionPath, { throwIfNoEntry: false })) return null;
  const file = openRegularFileNoFollow(sessionPath);
  try {
    const value: unknown = JSON.parse(file.readBytes(1024 * 1024).toString("utf-8"));
    return inspectRecordedOwner(value);
  } finally {
    file.close();
  }
}

async function observeExternalListener(owner: GatewayOwner) {
  const probe = await createProductionGatewayReadinessDependencies({
    gatewayName: () => owner.gatewayName,
    gatewayPort: () => owner.gatewayPort,
  }).probeAttachment(owner);
  if (
    !evaluateGatewayAttachment(owner, probe).ok ||
    probe.listenerStartTime === null ||
    probe.listenerPids.length !== 1 ||
    probe.listenerPids[0] === undefined
  ) {
    throw new Error("External gateway listener identity could not be verified.");
  }
  return { listenerPid: probe.listenerPids[0], listenerStartTime: probe.listenerStartTime };
}

async function externalGateway(
  owner: GatewayOwner,
  recorded: GatewayOwner | null,
  beforeRead: (stage: ExportSnapshotReadStage) => void,
): Promise<ObservedExportGateway> {
  const { endpoint, gatewayPort: port, gatewayName: name } = owner;
  beforeRead("gateway-configuration");
  if (
    process.platform !== "linux" ||
    isWsl() ||
    endpoint === null ||
    !isExternalHttpGatewayOrigin(endpoint, port)
  ) {
    throw new Error("Export requires a native Linux external HTTP loopback gateway without TLS.");
  }
  beforeRead("gateway-authority");
  if (!recorded || !sameGatewayOwner(recorded, owner)) {
    throw new Error("External gateway authority is missing or changed since onboarding.");
  }
  beforeRead("gateway-registration");
  const registered = await observeOpenShellGatewayRegistration(name, (args, options) =>
    captureSanitizedResolvedOpenshell(args, {
      ...options,
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    }),
  );
  if (registered.endpoint !== endpoint || registered.auth !== "plaintext") {
    throw new Error(
      "External gateway registration or authentication differs from its declaration.",
    );
  }
  beforeRead("gateway-listener");
  const listener = await observeExternalListener(owner);
  return {
    name,
    port,
    management: "external",
    stateRootOwned: false,
    external: {
      endpoint,
      authorityFingerprint: createHash("sha256").update(JSON.stringify(owner)).digest("hex"),
      ...listener,
    },
  };
}

export async function observeExportGateway(
  entry: Readonly<SandboxEntry>,
  beforeRead: (stage: ExportSnapshotReadStage) => void = () => {},
): Promise<ObservedExportGateway> {
  const { name, port } = resolveExportGatewayBinding(entry);
  beforeRead("gateway-authority");
  const loaded = loadGatewayManagementDeclaration();
  if (!loaded.ok) throw new Error("Gateway declaration could not be verified.");
  const recorded = readRecordedOwner(port);
  if (loaded.declaration?.mode === "externally-supervised") {
    return externalGateway(
      resolveGatewayOwner({
        gatewayName: name,
        gatewayPort: port,
        declaration: loaded.declaration,
        hasPackagedService: false,
      }),
      recorded,
      beforeRead,
    );
  }
  if (recorded?.mode === "externally-supervised") {
    throw new Error("Recorded external gateway authority no longer has its declaration.");
  }
  beforeRead("gateway-binding");
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  const stateDir = resolveGatewayStateDirForPort({ configured, home: os.homedir(), port });
  const stateRootOwned =
    managedGatewayStateRootOwnershipFailure(
      { gatewayName: name, gatewayPort: port, stateDir },
      { allowLegacyManagedState: !configured },
    ) === null;
  return { name, port, management: stateRootOwned ? "nemoclaw" : "unknown", stateRootOwned };
}
