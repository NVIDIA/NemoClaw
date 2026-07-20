// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getReportedGatewayName } from "../state/gateway";
import { type GatewayOwner, GatewayOwnershipError } from "./gateway-ownership";

export interface GatewayAttachmentRegistrationDeps {
  runOpenshell(
    args: string[],
    options: { ignoreError: true; suppressOutput?: true },
  ): { status: number | null };
  runCaptureOpenshell(args: string[], options: { ignoreError: true }): string;
}

function reportedGatewayEndpoint(output: string): string | null {
  const match = output.match(/^\s*Gateway endpoint:\s+(\S+)\s*$/m);
  if (!match) return null;
  try {
    return new URL(match[1]).origin;
  } catch {
    return null;
  }
}

function gatewayMetadataMissing(output: string): boolean {
  const value = output.trim();
  return value.length === 0 || /No gateway metadata found|gateway not found/i.test(value);
}

function registrationError(owner: GatewayOwner, detail: string): never {
  throw new GatewayOwnershipError(
    "gateway_registration_mismatch",
    `Could not bind OpenShell commands to the declared gateway endpoint. ${detail} ` +
      "No provider, policy, sandbox, or registry mutation was attempted.",
    owner,
  );
}

/**
 * Register and select the exact endpoint already proven to belong to the
 * external supervisor. OpenShell operations are name-scoped, so readiness of
 * the endpoint alone is insufficient: an ambient sibling gateway could remain
 * selected and receive every later provider or sandbox mutation.
 */
export function bindExternallySupervisedGateway(
  owner: GatewayOwner,
  gatewayName: string,
  deps: GatewayAttachmentRegistrationDeps,
): void {
  if (!owner.endpoint) {
    registrationError(owner, "The external owner has no endpoint.");
  }
  const endpoint = new URL(owner.endpoint).origin;
  const before = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
    ignoreError: true,
  });
  const existingEndpoint = reportedGatewayEndpoint(before);

  if (existingEndpoint && existingEndpoint !== endpoint) {
    registrationError(
      owner,
      `Gateway name '${gatewayName}' is already registered to a different endpoint.`,
    );
  }
  if (!existingEndpoint && !gatewayMetadataMissing(before)) {
    registrationError(owner, `Existing metadata for gateway '${gatewayName}' is not verifiable.`);
  }
  if (!existingEndpoint) {
    const added = deps.runOpenshell(
      ["gateway", "add", endpoint, "--local", "--name", gatewayName],
      { ignoreError: true, suppressOutput: true },
    );
    if (added.status !== 0) {
      registrationError(owner, `OpenShell could not register gateway '${gatewayName}'.`);
    }
  }

  const selected = deps.runOpenshell(["gateway", "select", gatewayName], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (selected.status !== 0) {
    registrationError(owner, `OpenShell could not select gateway '${gatewayName}'.`);
  }

  const named = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
    ignoreError: true,
  });
  const active = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  if (
    getReportedGatewayName(named) !== gatewayName ||
    reportedGatewayEndpoint(named) !== endpoint ||
    getReportedGatewayName(active) !== gatewayName ||
    reportedGatewayEndpoint(active) !== endpoint
  ) {
    registrationError(
      owner,
      `OpenShell did not verify '${gatewayName}' as the active registration for the declared endpoint.`,
    );
  }
}
