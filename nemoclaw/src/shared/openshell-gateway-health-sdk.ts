// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as importedOpenShellObservationBoundary from "./openshell-observation-boundary.cjs";
import type {
  ObserveOpenShellGatewayHealthRequest,
  OpenShellGatewayHealthObserver,
  OpenShellGatewayHealthResult,
  OpenShellGatewayHealthStatus,
} from "./openshell-observation-boundary.cjs";

const sourceOrGeneratedOpenShellObservationBoundary =
  importedOpenShellObservationBoundary as typeof importedOpenShellObservationBoundary & {
    default?: typeof importedOpenShellObservationBoundary;
  };
const { EXTERNAL_OPENSHELL_RELEASE } =
  sourceOrGeneratedOpenShellObservationBoundary.default ??
  sourceOrGeneratedOpenShellObservationBoundary;

type OpenShellConnectOptions = Readonly<{ gateway: string; caCert: Buffer }>;

type OpenShellHealthClient = Readonly<{
  raw: Readonly<{
    health(
      request: Record<string, never>,
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<unknown>;
  }>;
}>;

type OpenShellServiceStatus = Readonly<{
  UNSPECIFIED: number;
  HEALTHY: number;
  DEGRADED: number;
  UNHEALTHY: number;
}>;

type LoadedOpenShellSdk = Readonly<{
  connect: (options: OpenShellConnectOptions) => Promise<OpenShellHealthClient>;
  serviceStatus: OpenShellServiceStatus;
}>;

type OpenShellGatewayHealthSdkDependencies = Readonly<{
  loadSdk?: () => Promise<unknown>;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}>;

const OPENSHELL_SDK_PACKAGE = "@nvidia/openshell-sdk";
const OPENSHELL_RAW_SDK_PACKAGE = "@nvidia/openshell-sdk/raw";

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function parseOpenShellServiceStatus(value: unknown): OpenShellServiceStatus {
  if (
    !isObjectLike(value) ||
    value.UNSPECIFIED !== 0 ||
    value.HEALTHY !== 1 ||
    value.DEGRADED !== 2 ||
    value.UNHEALTHY !== 3
  ) {
    throw new TypeError("The OpenShell SDK service-status export is not compatible.");
  }
  return value as OpenShellServiceStatus;
}

function parseLoadedOpenShellSdk(value: unknown): LoadedOpenShellSdk {
  if (!isObjectLike(value) || typeof value.connect !== "function") {
    throw new TypeError("The OpenShell SDK client export is not compatible.");
  }
  return Object.freeze({
    connect: value.connect as LoadedOpenShellSdk["connect"],
    serviceStatus: parseOpenShellServiceStatus(value.serviceStatus),
  });
}

async function loadOpenShellSdk(): Promise<LoadedOpenShellSdk> {
  const [clientModule, rawModule] = await Promise.all([
    import(OPENSHELL_SDK_PACKAGE),
    import(OPENSHELL_RAW_SDK_PACKAGE),
  ]);
  if (!isObjectLike(clientModule) || !isObjectLike(clientModule.OpenShellClient)) {
    throw new TypeError("The OpenShell SDK client export is not compatible.");
  }
  const openShellClient = clientModule.OpenShellClient;
  const connect = openShellClient.connect;
  return parseLoadedOpenShellSdk({
    connect:
      typeof connect === "function"
        ? (options: OpenShellConnectOptions) =>
            Reflect.apply(connect, openShellClient, [options]) as Promise<OpenShellHealthClient>
        : connect,
    serviceStatus: isObjectLike(rawModule) ? rawModule.ServiceStatus : undefined,
  });
}

async function withinDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("health deadline expired");
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = () => rejectDeadline?.(new Error("health deadline expired"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function healthStatus(
  status: unknown,
  serviceStatus: OpenShellServiceStatus,
): OpenShellGatewayHealthStatus | null {
  switch (status) {
    case serviceStatus.UNSPECIFIED:
      return "unspecified";
    case serviceStatus.HEALTHY:
      return "healthy";
    case serviceStatus.DEGRADED:
      return "degraded";
    case serviceStatus.UNHEALTHY:
      return "unhealthy";
    default:
      return null;
  }
}

function failure(
  kind: "dependency" | "schema" | "timeout" | "transport",
  message: string,
): OpenShellGatewayHealthResult {
  return Object.freeze({ ok: false, error: Object.freeze({ kind, message }) });
}

/** Observe public gateway health through the exact approved OpenShell SDK. */
export function createOpenShellSdkGatewayHealthObserver(
  dependencies: OpenShellGatewayHealthSdkDependencies = {},
): OpenShellGatewayHealthObserver {
  return Object.freeze({
    async observeHealth(request: ObserveOpenShellGatewayHealthRequest) {
      if (
        request.target.expected_release !== EXTERNAL_OPENSHELL_RELEASE ||
        !(request.caBundle instanceof Uint8Array) ||
        request.caBundle.byteLength === 0 ||
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs < 1 ||
        request.timeoutMs > 60_000
      ) {
        return failure("schema", "The external OpenShell gateway health request is not valid.");
      }

      const signal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(request.timeoutMs);
      let sdk: LoadedOpenShellSdk;
      try {
        sdk = parseLoadedOpenShellSdk(
          await withinDeadline(signal, dependencies.loadSdk ?? loadOpenShellSdk),
        );
      } catch {
        return signal.aborted
          ? failure("timeout", "The external OpenShell gateway health check timed out.")
          : failure("dependency", "The approved OpenShell SDK package is unavailable.");
      }

      try {
        const client = await withinDeadline(signal, () =>
          sdk.connect({
            gateway: request.target.endpoint,
            caCert: Buffer.from(request.caBundle),
          }),
        );
        const response = await withinDeadline(signal, () => client.raw.health({}, { signal }));
        if (typeof response !== "object" || response === null || Array.isArray(response)) {
          return failure(
            "schema",
            "The external OpenShell gateway returned an invalid health response.",
          );
        }
        const healthResponse = response as Record<string, unknown>;
        const status = healthStatus(healthResponse.status, sdk.serviceStatus);
        if (
          status === null ||
          typeof healthResponse.version !== "string" ||
          healthResponse.version === ""
        ) {
          return failure(
            "schema",
            "The external OpenShell gateway returned an invalid health response.",
          );
        }
        return Object.freeze({
          ok: true,
          value: Object.freeze({ status, release: healthResponse.version }),
        });
      } catch {
        return signal.aborted
          ? failure("timeout", "The external OpenShell gateway health check timed out.")
          : failure("transport", "NemoClaw could not reach the external OpenShell target.");
      }
    },
  });
}

export const sdkOpenShellGatewayHealthObserver = createOpenShellSdkGatewayHealthObserver();
