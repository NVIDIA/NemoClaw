// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  captureExternalComponentTrust,
  ExternalComponentContractError,
  parseExternalComponentDeclaration,
  type ExternalComponentDeclarationV2,
} from "./index";
import type { RuntimeProviderGatewayHostRuntime } from "../runtime-provider/contract";
import { isIPv4 } from "node:net";

type Settings = Omit<ExternalComponentDeclarationV2, "activationSocketPath">;
const quote = JSON.stringify;

export function validateExternalComponentGatewaySettings(value: unknown): Settings {
  const declaration = parseExternalComponentDeclaration(
    JSON.stringify({
      ...(value as Settings),
      activationSocketPath: "/unused",
    }),
  );
  if (declaration.schemaVersion !== 2)
    throw new ExternalComponentContractError("declaration_invalid");
  const { activationSocketPath: _socket, ...settings } = declaration;
  return settings;
}

export function externalComponentGatewayNetwork(
  env: Record<string, string>,
  runtime: RuntimeProviderGatewayHostRuntime,
  settings: Settings,
): { gatewayIp: string; subnet: string } {
  const name = env.OPENSHELL_DOCKER_NETWORK_NAME;
  const network = name ? runtime.network.inspect(name) : undefined;
  if (
    runtime.openShellDriver !== "docker" ||
    !network?.gatewayIp ||
    !network.subnet ||
    !isIPv4(network.gatewayIp) ||
    !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(network.gatewayIp) ||
    new URL(settings.middleware.endpoint).hostname !== "host.openshell.internal"
  ) {
    throw new ExternalComponentContractError("endpoint_restricted");
  }
  return { gatewayIp: network.gatewayIp, subnet: network.subnet };
}

export function renderExternalComponentConnections(
  settings: Settings,
  gatewayIp: string,
): string[] {
  const interceptor = settings.interceptor;
  const middleware = settings.middleware;
  const interceptorTrust = captureExternalComponentTrust(interceptor.caCertificatePath);
  const middlewareTrust = captureExternalComponentTrust(middleware.caCertificatePath);
  const lines: string[] = [];
  lines.push(
    "[[openshell.gateway.interceptors]]",
    `name = ${quote(settings.componentId)}`,
    `grpc_endpoint = ${quote(interceptor.endpoint)}`,
    `tls_ca_cert_path = ${quote(interceptor.caCertificatePath)}`,
    `# ca-sha256 = ${interceptorTrust.sha256}`,
    `audience = ${quote(interceptor.audience)}`,
    "allow_insecure_transport = false",
    "order = 10",
    'binding_policy = "dynamic"',
    'timeout = "500ms"',
    "max_response_bytes = 1048576",
    "max_patches = 32",
    "",
  );
  lines.push(
    "[[openshell.supervisor.middleware]]",
    `name = ${quote(middleware.name)}`,
    `grpc_endpoint = ${quote(middleware.endpoint.replace("host.openshell.internal", gatewayIp))}`,
    `tls_ca_cert_path = ${quote(middleware.caCertificatePath)}`,
    `# ca-sha256 = ${middlewareTrust.sha256}`,
    `audience = ${quote(middleware.audience)}`,
    "allow_insecure_transport = false",
    "max_payload_bytes = 262144",
    'timeout = "500ms"',
    "",
  );
  return lines;
}

export function parseExternalComponentConnections(openshell: Record<string, unknown>): Settings {
  const gateway = openshell.gateway as Record<string, unknown>;
  const interceptors = gateway.interceptors as Record<string, unknown>[];
  const supervisor = openshell.supervisor as Record<string, unknown>;
  const services = supervisor?.middleware as Record<string, unknown>[];
  if (interceptors?.length !== 1 || services?.length !== 1) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  const interceptor = interceptors[0]!;
  const middleware = services[0]!;
  const sources = gateway.provider_profile_sources as Record<string, unknown>[] | undefined;
  if (sources && (sources.length !== 1 || sources[0]?.type !== "interceptor")) {
    throw new ExternalComponentContractError("declaration_invalid");
  }
  const connection = (service: Record<string, unknown>) => ({
    endpoint: service.grpc_endpoint,
    caCertificatePath: service.tls_ca_cert_path,
    audience: service.audience,
  });
  return validateExternalComponentGatewaySettings({
    schemaVersion: 2,
    componentId: interceptor.name,
    interceptor: connection(interceptor),
    middleware: {
      ...connection(middleware),
      endpoint:
        typeof middleware.grpc_endpoint === "string"
          ? middleware.grpc_endpoint.replace(
              /^https:\/\/[^:]+:/u,
              "https://host.openshell.internal:",
            )
          : null,
      name: middleware.name,
    },
    ...(sources ? { providerProfileSource: sources[0]?.name } : {}),
  });
}
