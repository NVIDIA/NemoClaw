// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import {
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  prepareDockerDriverGatewayConfigEnv,
} from "../../src/lib/onboard/docker-driver-gateway-config";

export { DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS };

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
export const GATEWAY_AUTH_REVIEW_NOTE = path.join(
  REPO_ROOT,
  "docs",
  "security",
  "openshell-0.0.72-compatibility-review.mdx",
);
export const GATEWAY_MIGRATION_REVIEW_NOTE = path.join(
  REPO_ROOT,
  "docs",
  "security",
  "openshell-0.0.85-migration-review.md",
);
const SANDBOX_JWT_SUBJECT_PREFIX = "spiffe://openshell/sandbox/";

export type JwtBundlePaths = {
  signingKeyPath: string;
  publicKeyPath: string;
  kidPath: string;
};

export function baseGatewayEnv(stateDir: string): Record<string, string> {
  return {
    OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
    OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
    OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE:
      "ghcr.io/nvidia/openshell/supervisor@sha256:f4226253a3525c3832adac5b38b419a0f27d1e915effe565b5885e20f93cd5e9",
  };
}

export function writeGatewayConfig(stateDir: string): Record<string, string> {
  return prepareDockerDriverGatewayConfigEnv(
    baseGatewayEnv(stateDir),
    stateDir,
    "/usr/bin/openshell-sandbox",
  );
}

export function parseTomlString(toml: string, key: string): string {
  const match = toml.match(new RegExp(`^${key} = "([^"]+)"$`, "m"));
  expect(match, `missing TOML string key ${key}`).not.toBeNull();
  return match?.[1] ?? "";
}

export function parseTomlInteger(toml: string, key: string): number {
  const match = toml.match(new RegExp(`^${key} = (\\d+)$`, "m"));
  expect(match, `missing TOML integer key ${key}`).not.toBeNull();
  return Number(match?.[1] ?? "0");
}

export function jwtBundlePaths(stateDir: string): JwtBundlePaths {
  return {
    signingKeyPath: path.join(stateDir, "jwt", "signing.pem"),
    publicKeyPath: path.join(stateDir, "jwt", "public.pem"),
    kidPath: path.join(stateDir, "jwt", "kid"),
  };
}

export function expectEd25519BundleSignsAndVerifies(paths: JwtBundlePaths): void {
  const privateKey = createPrivateKey(fs.readFileSync(paths.signingKeyPath, "utf-8"));
  const publicKey = createPublicKey(fs.readFileSync(paths.publicKeyPath, "utf-8"));
  const payload = Buffer.from("nemoclaw-openshell-gateway-jwt-bundle-check", "utf-8");
  expect(privateKey.asymmetricKeyType).toBe("ed25519");
  expect(publicKey.asymmetricKeyType).toBe("ed25519");
  expect(fs.readFileSync(paths.kidPath, "utf-8").trim()).not.toBe("");
  expect(verifyPayload(null, payload, publicKey, signPayload(null, payload, privateKey))).toBe(
    true,
  );
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as Record<string, unknown>;
}

export function mintOpenShellStyleSandboxJwt(options: {
  signingKeyPath: string;
  kid: string;
  gatewayId: string;
  sandboxId: string;
  exp: number;
  iat: number;
}): string {
  const header = base64UrlJson({ alg: "EdDSA", kid: options.kid, typ: "JWT" });
  const identity = `openshell-gateway:${options.gatewayId}`;
  const payload = base64UrlJson({
    sub: `${SANDBOX_JWT_SUBJECT_PREFIX}${options.sandboxId}`,
    iss: identity,
    aud: identity,
    iat: options.iat,
    exp: options.exp,
    sandbox_id: options.sandboxId,
  });
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey(fs.readFileSync(options.signingKeyPath, "utf-8"));
  const signature = signPayload(null, Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function validateOpenShellStyleSandboxJwt(options: {
  token: string;
  publicKeyPath: string;
  kid: string;
  gatewayId: string;
  now: number;
  expectedSandboxId: string;
}): Record<string, unknown> | null {
  const [headerPart, payloadPart, signaturePart] = options.token.split(".");
  expect(headerPart, "JWT header segment").toBeTruthy();
  expect(payloadPart, "JWT payload segment").toBeTruthy();
  expect(signaturePart, "JWT signature segment").toBeTruthy();

  const header = decodeJwtPart(headerPart ?? "");
  return header.kid === options.kid && header.alg === "EdDSA"
    ? validateOpenShellStyleSandboxJwtSignature({
        headerPart: headerPart ?? "",
        payloadPart: payloadPart ?? "",
        signaturePart: signaturePart ?? "",
        publicKeyPath: options.publicKeyPath,
        gatewayId: options.gatewayId,
        now: options.now,
        expectedSandboxId: options.expectedSandboxId,
      })
    : null;
}

function validateOpenShellStyleSandboxJwtSignature(options: {
  headerPart: string;
  payloadPart: string;
  signaturePart: string;
  publicKeyPath: string;
  gatewayId: string;
  now: number;
  expectedSandboxId: string;
}): Record<string, unknown> {
  const signingInput = `${options.headerPart}.${options.payloadPart}`;
  const publicKey = createPublicKey(fs.readFileSync(options.publicKeyPath, "utf-8"));
  const signatureOk = verifyPayload(
    null,
    Buffer.from(signingInput),
    publicKey,
    Buffer.from(options.signaturePart, "base64url"),
  );
  expect(signatureOk, "OpenShell-style sandbox JWT signature").toBe(true);

  const payload = decodeJwtPart(options.payloadPart);
  const identity = `openshell-gateway:${options.gatewayId}`;
  expect(payload.iss).toBe(identity);
  expect(payload.aud).toBe(identity);
  expect(payload.sandbox_id, "OpenShell-style sandbox JWT sandbox binding").toBe(
    options.expectedSandboxId,
  );
  expect(String(payload.sub)).toBe(`${SANDBOX_JWT_SUBJECT_PREFIX}${payload.sandbox_id}`);
  const exp = typeof payload.exp === "number" ? payload.exp : Number.NaN;
  expect(exp === 0 || exp >= options.now - 60, "OpenShell-style sandbox JWT expiry").toBe(true);
  return payload;
}
