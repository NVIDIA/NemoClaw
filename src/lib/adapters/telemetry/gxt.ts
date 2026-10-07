// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isOperationEvent,
  TELEMETRY_CLIENT_ID,
  TELEMETRY_SCHEMA_VERSION,
} from "../../domain/telemetry/schema";

/** Match OpenShell's transport convention while retaining NemoClaw's own schema. */
export function operationEnvelope(
  event: unknown,
  temporaryFunctionalConsent = false,
): Record<string, unknown> | null {
  if (
    !isOperationEvent(event) ||
    (temporaryFunctionalConsent && event.parameters.testLabel.length === 0)
  )
    return null;
  const installedVersion =
    event.parameters.versions.installedStatus === "reported"
      ? event.parameters.versions.installed
      : "undefined";
  return {
    browserType: "undefined",
    clientId: TELEMETRY_CLIENT_ID,
    clientType: "Native",
    clientVariant: "Release",
    clientVer: installedVersion,
    cpuArchitecture: event.parameters.platform.hostArch,
    deviceGdprBehOptIn: "None",
    deviceGdprFuncOptIn: temporaryFunctionalConsent ? "Temp" : "None",
    deviceGdprTechOptIn: "None",
    deviceId: "undefined",
    deviceMake: "undefined",
    deviceModel: "undefined",
    deviceOS:
      event.parameters.platform.hostOSStatus === "reported"
        ? event.parameters.platform.hostOS
        : "undefined",
    deviceOSVersion: "undefined",
    deviceType: "undefined",
    eventProtocol: "1.6",
    eventSchemaVer: TELEMETRY_SCHEMA_VERSION,
    eventSysVer: "nemoclaw-telemetry/3.0",
    externalUserId: "undefined",
    gdprBehOptIn: "None",
    gdprFuncOptIn: "None",
    gdprTechOptIn: "None",
    idpId: "undefined",
    integrationId: "undefined",
    productName: "NemoClaw",
    productVersion: installedVersion,
    sentTs: new Date().toISOString(),
    sessionId: "undefined",
    userId: "undefined",
    events: [event],
  };
}
