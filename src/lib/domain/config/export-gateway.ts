// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isExternalHttpGatewayOrigin } from "../../core/gateway-address";
import { isValidNemoClawLocalResourceName, isValidNemoClawPort } from "../../config/model";
import type {
  ExportFinding,
  ObservedExportGateway,
  QualifiedExportSnapshot,
  VerifiedExportGateway,
} from "./export-evidence";

function externalGatewayIsVerified(gateway: ObservedExportGateway): boolean {
  const external = gateway.external;
  return (
    gateway.management === "external" &&
    external !== undefined &&
    isExternalHttpGatewayOrigin(external.endpoint, gateway.port) &&
    /^[a-f0-9]{64}$/u.test(external.authorityFingerprint) &&
    Number.isSafeInteger(external.listenerPid) &&
    external.listenerPid > 0 &&
    /^[0-9]+$/u.test(external.listenerStartTime)
  );
}

function externalGatewayScopeIsSupported(snapshot: QualifiedExportSnapshot): boolean {
  return (
    snapshot.registry.agent === "openclaw" &&
    snapshot.registry.openshellDriver === "docker" &&
    snapshot.inference.topology === "hosted"
  );
}

function managedGatewayIsVerified(gateway: ObservedExportGateway): boolean {
  return (
    gateway.management === "nemoclaw" && gateway.stateRootOwned && gateway.external === undefined
  );
}

export function validateExportGateway(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, gateway } = snapshot;
  const findings: ExportFinding[] = [];
  if (!externalGatewayIsVerified(gateway) && !managedGatewayIsVerified(gateway)) {
    findings.push({
      field: "spec.gateway.management",
      category: "drifted",
      diagnostic: "Gateway ownership or external connection provenance could not be verified.",
    });
  }
  if (gateway.management === "external" && !externalGatewayScopeIsSupported(snapshot)) {
    findings.push({
      field: "spec.gateway.management",
      category: "unsupported",
      diagnostic: "External gateway export requires OpenClaw with hosted inference on Docker.",
    });
  }
  if (entry.gatewayName !== gateway.name || entry.gatewayPort !== gateway.port) {
    findings.push({
      field: "spec.gateway",
      category: "drifted",
      diagnostic: "Registry and live gateway bindings differ.",
    });
  }
  if (
    !isValidNemoClawLocalResourceName(gateway.name) ||
    !isValidNemoClawPort(gateway.port) ||
    gateway.port < 1024
  ) {
    findings.push({
      field: "spec.gateway",
      category: "unsupported",
      diagnostic: "The gateway name or port cannot be represented by v1.",
    });
  }
  return findings;
}

export function projectExportGateway(gateway: ObservedExportGateway): VerifiedExportGateway {
  const binding = { name: gateway.name, port: gateway.port };
  return gateway.management === "external" && gateway.external
    ? { ...binding, management: "external", endpoint: gateway.external.endpoint }
    : binding;
}
