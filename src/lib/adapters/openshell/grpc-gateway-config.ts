// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createGrpcOpenShellSandboxControl,
  type GrpcOpenShellSandboxControl,
  type OpenShellGrpcClientConfig,
  validateOpenShellGrpcClientConfig,
} from "./grpc-sandbox-control";

interface GatewayMetadata {
  name: string;
  gateway_endpoint: string;
  auth_mode?: string | null;
}

interface OidcTokenBundle {
  access_token: string;
  expires_at?: number | null;
}

export interface OpenShellGrpcGatewayResolverOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowSeconds?: number;
  systemConfigRoot?: string;
  xdgConfigHome?: string;
}

export interface ResolvedOpenShellGrpcGateway {
  gatewayName: string;
  metadataSource: "user" | "system";
  authMode: "plaintext" | "mtls" | "oidc";
  clientConfig: OpenShellGrpcClientConfig;
}

/** Direct gRPC cannot traverse OpenShell's CLI-owned Cloudflare edge tunnel. */
export class OpenShellGrpcEdgeTunnelRequiredError extends Error {
  constructor() {
    super(
      "OpenShell Cloudflare JWT gateways require the OpenShell edge tunnel and are not supported by the direct gRPC client",
    );
    this.name = "OpenShellGrpcEdgeTunnelRequiredError";
  }
}

function validateGatewayName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Invalid OpenShell gateway name '${name}': expected one path component`);
  }
}

function configRoots(options: OpenShellGrpcGatewayResolverOptions): {
  user: string;
  system: string;
} {
  const env = options.env ?? process.env;
  const xdgConfigHome = options.xdgConfigHome ?? env.XDG_CONFIG_HOME;
  const user = xdgConfigHome ?? path.join(options.homeDir ?? os.homedir(), ".config");
  if (!path.isAbsolute(user)) {
    throw new Error("OpenShell XDG config home must be an absolute path");
  }
  const systemOverride = options.systemConfigRoot ?? env.OPENSHELL_SYSTEM_GATEWAY_DIR;
  const system =
    systemOverride && path.isAbsolute(systemOverride) ? systemOverride : "/etc/openshell";
  return { user: path.join(user, "openshell"), system };
}

function readJson(pathname: string, label: string): unknown {
  let source: string;
  try {
    source = fs.readFileSync(pathname, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${label} from ${pathname}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Failed to parse ${label} from ${pathname}: ${(error as Error).message}`);
  }
}

function pathExists(pathname: string): boolean {
  try {
    fs.lstatSync(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to inspect OpenShell path ${pathname}: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataAt(pathname: string, gatewayName: string): GatewayMetadata {
  const value = readJson(pathname, "OpenShell gateway metadata");
  if (!isRecord(value)) throw new Error(`Invalid OpenShell gateway metadata in ${pathname}`);
  if (value.name !== gatewayName) {
    throw new Error(
      `OpenShell gateway metadata name mismatch in ${pathname}: expected '${gatewayName}'`,
    );
  }
  if (typeof value.gateway_endpoint !== "string" || !value.gateway_endpoint) {
    throw new Error(`OpenShell gateway metadata in ${pathname} has no gateway_endpoint`);
  }
  if (
    value.auth_mode !== undefined &&
    value.auth_mode !== null &&
    typeof value.auth_mode !== "string"
  ) {
    throw new Error(`OpenShell gateway metadata in ${pathname} has an invalid auth_mode`);
  }
  return value as unknown as GatewayMetadata;
}

function resolveMetadata(
  gatewayName: string,
  roots: { user: string; system: string },
): { metadata: GatewayMetadata; source: "user" | "system" } {
  const userPath = path.join(roots.user, "gateways", gatewayName, "metadata.json");
  if (pathExists(userPath)) {
    return { metadata: metadataAt(userPath, gatewayName), source: "user" };
  }
  const systemPath = path.join(roots.system, "gateways", gatewayName, "metadata.json");
  if (pathExists(systemPath)) {
    return { metadata: metadataAt(systemPath, gatewayName), source: "system" };
  }
  throw new Error(
    `No OpenShell metadata found for gateway '${gatewayName}' (looked in ${userPath} and ${systemPath})`,
  );
}

function readRequired(pathname: string, label: string): Buffer {
  let value: Buffer;
  try {
    value = fs.readFileSync(pathname);
  } catch (error) {
    throw new Error(`Failed to read ${label} from ${pathname}: ${(error as Error).message}`);
  }
  if (value.length === 0) throw new Error(`${label} is empty at ${pathname}`);
  return value;
}

function mtlsConfig(endpoint: string, mtlsDir: string): OpenShellGrpcClientConfig {
  return {
    endpoint,
    caCertificate: readRequired(path.join(mtlsDir, "ca.crt"), "OpenShell TLS CA"),
    clientCertificate: readRequired(
      path.join(mtlsDir, "tls.crt"),
      "OpenShell TLS client certificate",
    ),
    clientKey: readRequired(path.join(mtlsDir, "tls.key"), "OpenShell TLS client key"),
  };
}

function oidcConfig(
  endpoint: string,
  gatewayDir: string,
  nowSeconds: number,
): OpenShellGrpcClientConfig {
  const tokenPath = path.join(gatewayDir, "oidc_token.json");
  const value = readJson(tokenPath, "OpenShell OIDC token");
  if (!isRecord(value) || typeof value.access_token !== "string" || !value.access_token) {
    throw new Error(`OpenShell OIDC token in ${tokenPath} has no access_token`);
  }
  if (
    value.expires_at !== undefined &&
    value.expires_at !== null &&
    (!Number.isSafeInteger(value.expires_at) || Number(value.expires_at) < 0)
  ) {
    throw new Error(`OpenShell OIDC token in ${tokenPath} has an invalid expires_at`);
  }
  const token = value as unknown as OidcTokenBundle;
  if (
    token.expires_at !== undefined &&
    token.expires_at !== null &&
    nowSeconds + 30 >= token.expires_at
  ) {
    throw new Error(
      `OpenShell OIDC token for this gateway is expired or near expiry; refresh it with the OpenShell CLI`,
    );
  }

  const config: OpenShellGrpcClientConfig = { endpoint, bearerToken: token.access_token };
  const mtlsDir = path.join(gatewayDir, "mtls");
  const caPath = path.join(mtlsDir, "ca.crt");
  const certPath = path.join(mtlsDir, "tls.crt");
  const keyPath = path.join(mtlsDir, "tls.key");
  const hasCa = pathExists(caPath);
  if (hasCa) config.caCertificate = readRequired(caPath, "OpenShell TLS CA");
  if (hasCa && pathExists(certPath) && pathExists(keyPath)) {
    config.clientCertificate = readRequired(certPath, "OpenShell TLS client certificate");
    config.clientKey = readRequired(keyPath, "OpenShell TLS client key");
  }
  return config;
}

function effectiveAuthMode(metadata: GatewayMetadata): string {
  if (metadata.auth_mode) return metadata.auth_mode;
  return metadata.gateway_endpoint.startsWith("http://") ? "plaintext" : "mtls";
}

export function resolveOpenShellGrpcGateway(
  gatewayName: string,
  options: OpenShellGrpcGatewayResolverOptions = {},
): ResolvedOpenShellGrpcGateway {
  validateGatewayName(gatewayName);
  const roots = configRoots(options);
  const { metadata, source } = resolveMetadata(gatewayName, roots);
  const authMode = effectiveAuthMode(metadata);
  const gatewayDir = path.join(roots.user, "gateways", gatewayName);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("OpenShell gateway resolver nowSeconds must be a non-negative safe integer");
  }

  let clientConfig: OpenShellGrpcClientConfig;
  if (authMode === "plaintext") {
    if (!metadata.gateway_endpoint.startsWith("http://")) {
      throw new Error("OpenShell plaintext gateway metadata must use an http:// endpoint");
    }
    clientConfig = { endpoint: metadata.gateway_endpoint };
  } else if (authMode === "mtls") {
    if (!metadata.gateway_endpoint.startsWith("https://")) {
      throw new Error("OpenShell mTLS gateway metadata must use an https:// endpoint");
    }
    clientConfig = mtlsConfig(metadata.gateway_endpoint, path.join(gatewayDir, "mtls"));
  } else if (authMode === "oidc") {
    if (!metadata.gateway_endpoint.startsWith("https://")) {
      throw new Error("OpenShell OIDC gateway metadata must use an https:// endpoint");
    }
    clientConfig = oidcConfig(metadata.gateway_endpoint, gatewayDir, nowSeconds);
  } else if (authMode === "cloudflare_jwt") {
    throw new OpenShellGrpcEdgeTunnelRequiredError();
  } else {
    throw new Error(`Unsupported OpenShell gateway auth mode '${authMode}'`);
  }
  validateOpenShellGrpcClientConfig(clientConfig);

  return {
    gatewayName,
    metadataSource: source,
    authMode: authMode as ResolvedOpenShellGrpcGateway["authMode"],
    clientConfig,
  };
}

export function createGrpcOpenShellSandboxControlForGateway(
  gatewayName: string,
  options: OpenShellGrpcGatewayResolverOptions = {},
): GrpcOpenShellSandboxControl {
  const resolved = resolveOpenShellGrpcGateway(gatewayName, options);
  return createGrpcOpenShellSandboxControl(resolved.clientConfig);
}
