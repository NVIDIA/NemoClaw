// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import {
  DEFAULT_TOOL_DISCLOSURE,
  resolveSandboxToolDisclosure,
  resolveToolDisclosureRequest,
  TOOL_DISCLOSURE_ENV,
  type ToolDisclosure,
} from "../tool-disclosure";
import { assertToolDisclosureDockerfileContract } from "./dockerfile-tool-disclosure-contract";
import type { SandboxLifecycleHelpers } from "./sandbox-lifecycle";

export function applyOnboardToolDisclosureRequest(value: unknown): ToolDisclosure | null {
  let requested: ToolDisclosure | null;
  try {
    requested = resolveToolDisclosureRequest(value, process.env);
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (requested) process.env[TOOL_DISCLOSURE_ENV] = requested;
  return requested;
}

export function prepareSandboxToolDisclosure(
  sandboxName: string,
  fromDockerfile: string | null,
  recreate: boolean,
  inspectSandboxForCreate: SandboxLifecycleHelpers["inspectSandboxForCreate"],
  desiredToolDisclosure: ToolDisclosure | null = null,
) {
  const { existingEntry, preservedMcpState, liveExists } = inspectSandboxForCreate(sandboxName);
  let mode: ToolDisclosure;
  try {
    mode = resolveSandboxToolDisclosure({
      requested: desiredToolDisclosure ?? resolveToolDisclosureRequest(null, process.env),
      recorded: existingEntry?.toolDisclosure,
      session: onboardSession.loadSession()?.toolDisclosure,
      sandboxExists: liveExists,
      recreate,
    });
  } catch (error) {
    console.error(`  Tool disclosure configuration is invalid: ${String(error)}`);
    console.error(`  Re-run with --recreate-sandbox --tool-disclosure ${DEFAULT_TOOL_DISCLOSURE}.`);
    process.exit(1);
  }

  if (fromDockerfile) {
    try {
      assertToolDisclosureDockerfileContract(path.resolve(fromDockerfile), mode);
    } catch (error) {
      console.error(
        `  Custom Dockerfile tool-disclosure contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  // Keep inspection and validation ahead of every mutation. Splitting these
  // steps across lifecycle callbacks would require a transaction object to
  // preserve this fail-closed ordering for registry and session state.
  if (
    existingEntry &&
    !liveExists &&
    !preservedMcpState &&
    existingEntry.pendingRouteReservation !== true
  ) {
    registry.removeSandbox(sandboxName);
  }
  onboardSession.updateSession((session) => {
    session.toolDisclosure = mode;
    return session;
  });

  const migrationNeeded = Boolean(
    liveExists && existingEntry && existingEntry.toolDisclosure === undefined,
  );
  return {
    existingEntry,
    preservedMcpState,
    liveExists,
    effectiveToolDisclosure: mode,
    toolDisclosureMigrationNeeded: migrationNeeded,
    toolDisclosureMigrationNote: migrationNeeded
      ? `  Sandbox '${sandboxName}' exists — recreating to apply ${mode} tool disclosure.`
      : null,
  };
}
