// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createSupervisedSandboxCommandReader } from "../../telemetry/native-reader";
import {
  type OpenShellGatewayTarget,
  selectedOpenShellGateway,
} from "../../../adapters/openshell/sandbox-observer";
export { createCliOpenShellSandboxCommandExecutor } from "../../../adapters/openshell/sandbox-command-cli";
export {
  selectedOpenShellGateway,
  type OpenShellGatewayTarget,
} from "../../../adapters/openshell/sandbox-observer";

import { parseConfig } from "../../../sandbox/config-format";
import type { SandboxEntry } from "../../../state/registry/types";
import type { TelemetryMetadataError } from "../../../domain/telemetry/event";
import {
  readMatchingNativeModelSelection,
  readHermesModelSelectionTuple,
  readModelSelectionProvenance,
  type ModelAssignmentSelection,
} from "../../../domain/telemetry/provenance";
import { takeSelectedAgentsManifest } from "../../../onboard/agents-manifest";
import { resolveSandboxGatewayName } from "../../../onboard/gateway-binding/identity";
import { resolveSandboxConfigRuntimeSelection } from "../mcp-bridge-provider-inspection";
import { isTelemetryOperationActive, withTelemetryEvidence } from "../../telemetry/operation";
import {
  persistVerifiedAgentModelSelections,
  readSandboxTelemetryEntry,
  updateSandboxTelemetrySelections,
  verifiedManifestModelSelections,
  restoredAgentModelSelections,
} from "./model-selections";

/** Keep every native evidence read inside the shared remaining collection budget. */
export async function readTelemetryAgentCommand<T>(
  sandboxName: string,
  target: OpenShellGatewayTarget,
  command: readonly string[],
  project: (raw: string) => T,
  timeoutLimitMs = 1_000,
): Promise<T | null> {
  return withTelemetryEvidence(async (remainingMs, signal) => {
    const runtimeSelection = resolveSandboxConfigRuntimeSelection(sandboxName);
    if (target.kind === "named" && target.gatewayName !== runtimeSelection.gatewayName)
      throw new Error("Native evidence target does not match the recorded sandbox gateway");
    const reader = createSupervisedSandboxCommandReader(signal);
    try {
      const raw = await reader.read(
        {
          sandboxName,
          target: { kind: "named", gatewayName: runtimeSelection.gatewayName },
          command,
          timeoutMilliseconds: Math.max(1, Math.min(timeoutLimitMs, Math.floor(remainingMs))),
          timeoutKillSignal: "SIGKILL",
          outputLimitBytes: 16 * 1024 * 1024,
        },
        runtimeSelection,
      );
      return project(raw);
    } finally {
      reader.dispose();
    }
  });
}

export function readTelemetryAgentConfiguration(
  sandboxName: string,
  target: OpenShellGatewayTarget = selectedOpenShellGateway(),
) {
  return readTelemetryAgentCommand(
    sandboxName,
    target,
    ["cat", "/sandbox/.openclaw/openclaw.json"],
    (raw) => parseConfig(raw, "json5"),
  );
}

function sourceErrors(selections: readonly ModelAssignmentSelection[]): TelemetryMetadataError[] {
  return selections.map((selection) => ({
    category: "model_source",
    slot: {
      agentId: selection.agentId,
      assignment: selection.assignment,
      reference: selection.reference,
    },
  }));
}

async function restoreNativeModelSelection(
  sandboxName: string,
  previous: SandboxEntry,
  expected: SandboxEntry,
) {
  const failure = {
    verified: true,
    status: "collection_error" as const,
    metadataErrors: [{ category: "native_model_source" as const }],
  };
  let verified = false;
  try {
    const gatewayName = resolveSandboxGatewayName(expected);
    const sameOwner =
      previous.pendingCreateIdentity === undefined &&
      previous.pendingRouteReservation === undefined &&
      previous.name === expected.name &&
      previous.agent === expected.agent &&
      resolveSandboxGatewayName(previous) === gatewayName;
    if (!sameOwner) return { ...failure, verified: false };
    const receipt = readModelSelectionProvenance(previous.nativeModelSelectionProvenance);
    if (!receipt) return failure;
    const config = await readTelemetryAgentCommand(
      sandboxName,
      { kind: "named", gatewayName },
      ["cat", "/sandbox/.hermes/config.yaml"],
      (raw) => parseConfig(raw, "yaml"),
    );
    if (!readHermesModelSelectionTuple(config)) return { ...failure, verified: false };
    verified = true;
    if (
      updateSandboxTelemetrySelections(expected, {
        nativeModelSelectionProvenance:
          readMatchingNativeModelSelection(config, expected.nativeModelSelectionProvenance) ??
          readMatchingNativeModelSelection(config, receipt) ??
          undefined,
      })
    )
      return { verified: true, status: "reported" as const };
  } catch {
    // Native completion remains valid when optional selection metadata cannot be saved.
  }
  return { ...failure, verified };
}

/** Fresh choices replace matching retained slots; restore never reclassifies their origin. */
export async function verifySelectedAgentsManifest(
  sandboxName: string,
  target: OpenShellGatewayTarget = selectedOpenShellGateway(),
  previous?: SandboxEntry | null,
  restoreOnly = false,
): Promise<{
  verified: boolean;
  status: "reported" | "collection_error";
  metadataErrors?: TelemetryMetadataError[];
}> {
  const manifest = restoreOnly ? null : takeSelectedAgentsManifest();
  if (
    !isTelemetryOperationActive() ||
    (!manifest &&
      previous?.modelAssignmentSelections === undefined &&
      previous?.nativeModelSelectionProvenance === undefined &&
      previous?.modelSelectionProvenance === undefined)
  )
    return { verified: true, status: "reported" };
  let expected: SandboxEntry | null;
  let scopedTarget = target;
  try {
    expected = readSandboxTelemetryEntry(sandboxName);
    if (expected) {
      const gatewayName = resolveSandboxGatewayName(expected);
      if (
        expected.name !== sandboxName ||
        expected.pendingCreateIdentity !== undefined ||
        expected.pendingRouteReservation !== undefined ||
        (target.kind === "named" && target.gatewayName !== gatewayName)
      )
        return { verified: false, status: "collection_error" };
      scopedTarget = { kind: "named", gatewayName };
    }
  } catch {
    return { verified: false, status: "collection_error" };
  }
  if (expected && (expected.agent ?? "openclaw") !== "openclaw") {
    if (manifest) return { verified: false, status: "collection_error" };
    return expected.agent === "hermes" &&
      previous?.agent === "hermes" &&
      previous.nativeModelSelectionProvenance !== undefined
      ? restoreNativeModelSelection(sandboxName, previous, expected)
      : { verified: true, status: "reported" };
  }
  if (
    !manifest &&
    previous?.modelAssignmentSelections === undefined &&
    previous?.modelSelectionProvenance === undefined
  )
    return { verified: expected !== null, status: expected ? "reported" : "collection_error" };
  const config = await readTelemetryAgentConfiguration(sandboxName, scopedTarget);
  if (!config) return { verified: false, status: "collection_error" };
  const fresh = manifest ? verifiedManifestModelSelections(config, manifest) : [];
  if (!fresh) return { verified: false, status: "reported" };
  if (!expected)
    return { verified: true, status: "collection_error", metadataErrors: sourceErrors(fresh) };
  const retained = previous ? restoredAgentModelSelections(config, previous, expected) : [];
  if (!retained) return { verified: false, status: "collection_error" };
  const current = restoredAgentModelSelections(config, expected, expected);
  if (!current) return { verified: true, status: "collection_error" };
  const preserved = [
    ...retained.filter(
      (selection) =>
        !current.some(
          (slot) => slot.agentId === selection.agentId && slot.assignment === selection.assignment,
        ),
    ),
    ...current,
  ];
  const selections = [
    ...preserved.filter(
      (selection) =>
        !fresh.some(
          (replacement) =>
            replacement.agentId === selection.agentId &&
            replacement.assignment === selection.assignment,
        ),
    ),
    ...fresh,
  ];
  try {
    if (persistVerifiedAgentModelSelections(expected, config, fresh, [], preserved))
      return { verified: true, status: "reported" };
  } catch {
    /* Verified application remains successful when telemetry metadata cannot be saved. */
  }
  return {
    verified: true,
    status: "collection_error",
    metadataErrors: sourceErrors(selections),
  };
}
