// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshellCommandAsyncResult } from "../../../adapters/openshell/command-execution";
import { createCliOpenShellSandboxCommandExecutor } from "../../../adapters/openshell/sandbox-command-cli";
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
import type { ModelAssignmentSelection } from "../../../domain/telemetry/provenance";
import { takeSelectedAgentsManifest } from "../../../onboard/agents-manifest";
import { isTelemetryOperationActive, withTelemetryEvidence } from "../../telemetry/operation";
import {
  persistVerifiedAgentModelSelections,
  readAgentSelectionEntry,
  verifiedManifestModelSelections,
  restoredAgentModelSelections,
} from "./model-selections";

/** Keep every native evidence read inside the shared remaining collection budget. */
export async function readTelemetryAgentCommand<T>(
  sandboxName: string,
  target: OpenShellGatewayTarget,
  command: readonly string[],
  project: (raw: string) => T,
): Promise<T | null> {
  return withTelemetryEvidence(async (remainingMs, signal) => {
    if (signal.aborted) throw new Error("Roster evidence cancelled");
    const executor = createCliOpenShellSandboxCommandExecutor({
      runBuffered: (binary, args, options) =>
        captureOpenshellCommandAsyncResult(binary, [...args], {
          ...options,
          cwd: options.hostCwd,
          killGraceMs: 0,
          signalSource: {
            add: (_signal, listener) => signal.addEventListener("abort", listener),
            remove: (_signal, listener) => signal.removeEventListener("abort", listener),
          },
        }),
    });
    const result = await executor.runBuffered({
      sandboxName,
      target,
      command,
      timeoutMilliseconds: Math.max(1, Math.min(1_000, Math.floor(remainingMs))),
      timeoutKillSignal: "SIGKILL",
      outputLimitBytes: 16 * 1024 * 1024,
    });
    if (result.outcome.kind !== "completed" || result.outcome.exitCode !== 0)
      throw new Error("Agent roster could not be verified");
    return project(result.stdout);
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

/** Fresh choices replace matching retained slots; restore never reclassifies their origin. */
export async function verifySelectedAgentsManifest(
  sandboxName: string,
  target: OpenShellGatewayTarget = selectedOpenShellGateway(),
  previous?: SandboxEntry | null,
): Promise<{
  verified: boolean;
  status: "reported" | "collection_error";
  metadataErrors?: TelemetryMetadataError[];
}> {
  const manifest = takeSelectedAgentsManifest();
  if (
    !isTelemetryOperationActive() ||
    (!manifest && previous?.modelAssignmentSelections === undefined)
  )
    return { verified: true, status: "reported" };
  const expected = readAgentSelectionEntry(sandboxName);
  const config = await readTelemetryAgentConfiguration(sandboxName, target);
  if (!config) return { verified: false, status: "collection_error" };
  const fresh = manifest ? verifiedManifestModelSelections(config, manifest) : [];
  if (!fresh) return { verified: false, status: "reported" };
  if (!expected)
    return { verified: true, status: "collection_error", metadataErrors: sourceErrors(fresh) };
  const retained =
    previous?.modelAssignmentSelections === undefined
      ? []
      : restoredAgentModelSelections(config, previous, expected);
  if (!retained) return { verified: false, status: "collection_error" };
  const selections = [
    ...retained.filter(
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
    if (persistVerifiedAgentModelSelections(expected, config, fresh, [], retained))
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
