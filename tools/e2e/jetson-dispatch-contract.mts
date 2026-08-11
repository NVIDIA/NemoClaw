// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, createVerify, type JsonWebKeyInput, type KeyObject } from "node:crypto";

export const JETSON_DISPATCH_AUDIENCE = "nemoclaw-jetson-dispatch";
export const JETSON_DISPATCH_TARGET = "jetson-nvmap-gpu";
export const JETSON_DISPATCH_REPOSITORY = "NVIDIA/NemoClaw";
export const JETSON_DISPATCH_WORKFLOW_REF =
  "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;
const JWKS_CACHE_MS = 5 * 60_000;
const UNKNOWN_KEY_REFRESH_INTERVAL_MS = 60_000;

export interface JetsonDispatchRequest {
  schemaVersion: 1;
  target: typeof JETSON_DISPATCH_TARGET;
  candidateSha: string;
  workflowRunId: string;
  workflowRunAttempt: number;
}

export interface GitHubOidcIdentity {
  repository: typeof JETSON_DISPATCH_REPOSITORY;
  repositoryId: string;
  runId: string;
  runAttempt: number;
  workflowSha: string;
  tokenId: string;
}

export interface GitHubOidcPolicy {
  repositoryId: string;
}

export type SigningKeyResolver = (keyId: string) => Promise<KeyObject>;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function positiveIntegerString(value: unknown, name: string): string {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  return value;
}

export function parseJetsonDispatchRequest(value: unknown): JetsonDispatchRequest {
  const request = record(value, "dispatch request");
  const expectedKeys = [
    "candidateSha",
    "schemaVersion",
    "target",
    "workflowRunAttempt",
    "workflowRunId",
  ];
  const actualKeys = Object.keys(request).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("dispatch request fields must match the fixed Jetson contract");
  }
  if (request.schemaVersion !== 1) {
    throw new Error("dispatch request schemaVersion must be 1");
  }
  if (request.target !== JETSON_DISPATCH_TARGET) {
    throw new Error(`dispatch target must be ${JETSON_DISPATCH_TARGET}`);
  }
  if (typeof request.candidateSha !== "string" || !SHA_PATTERN.test(request.candidateSha)) {
    throw new Error("candidateSha must be a lowercase 40-character commit SHA");
  }
  const workflowRunId = positiveIntegerString(request.workflowRunId, "workflowRunId");
  const workflowRunAttempt = positiveInteger(request.workflowRunAttempt, "workflowRunAttempt");
  return {
    schemaVersion: 1,
    target: JETSON_DISPATCH_TARGET,
    candidateSha: request.candidateSha,
    workflowRunId,
    workflowRunAttempt,
  };
}

function decodeJwtPart(encoded: string, name: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error(`OIDC ${name} encoding is invalid`);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error(`OIDC ${name} is not valid JSON`);
  }
  return record(value, `OIDC ${name}`);
}

function stringClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OIDC ${name} claim is invalid`);
  }
  return value;
}

function numericDateClaim(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`OIDC ${name} claim is invalid`);
  }
  return value as number;
}

export async function verifyGitHubOidcToken(options: {
  token: string;
  request: JetsonDispatchRequest;
  policy: GitHubOidcPolicy;
  resolveSigningKey: SigningKeyResolver;
  nowMs?: number;
}): Promise<GitHubOidcIdentity> {
  if (
    typeof options.token !== "string" ||
    options.token.length === 0 ||
    Buffer.byteLength(options.token) > MAX_TOKEN_BYTES
  ) {
    throw new Error("OIDC token size is invalid");
  }
  if (!POSITIVE_INTEGER_PATTERN.test(options.policy.repositoryId)) {
    throw new Error("trusted repository ID must be a positive decimal integer");
  }
  const parts = options.token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("OIDC token must be a compact JWT");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJwtPart(encodedHeader, "header");
  if (header.alg !== "RS256" || header.typ !== "JWT") {
    throw new Error("OIDC token must use an RS256 JWT header");
  }
  const keyId = stringClaim(header, "kid");
  if (keyId.length > 256 || /[\u0000-\u001f\u007f]/u.test(keyId)) {
    throw new Error("OIDC kid header is invalid");
  }

  const claims = decodeJwtPart(encodedClaims, "claims");
  if (!/^[A-Za-z0-9_-]+$/u.test(encodedSignature)) {
    throw new Error("OIDC signature encoding is invalid");
  }
  const signature = Buffer.from(encodedSignature, "base64url");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedClaims}`, "ascii");
  verifier.end();
  const signingKey = await options.resolveSigningKey(keyId);
  if (!verifier.verify(signingKey, signature)) {
    throw new Error("OIDC signature verification failed");
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const issuedAt = numericDateClaim(claims, "iat");
  const notBefore = numericDateClaim(claims, "nbf");
  const expiresAt = numericDateClaim(claims, "exp");
  if (
    issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
    notBefore > nowSeconds + CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("OIDC token is outside its allowed validity window");
  }

  const workflowSha = stringClaim(claims, "workflow_sha");
  const workflowRunId = positiveIntegerString(claims.run_id, "OIDC run_id claim");
  const workflowRunAttempt = positiveIntegerString(claims.run_attempt, "OIDC run_attempt claim");
  if (
    stringClaim(claims, "iss") !== GITHUB_OIDC_ISSUER ||
    stringClaim(claims, "aud") !== JETSON_DISPATCH_AUDIENCE ||
    stringClaim(claims, "repository") !== JETSON_DISPATCH_REPOSITORY ||
    stringClaim(claims, "repository_id") !== options.policy.repositoryId ||
    stringClaim(claims, "workflow_ref") !== JETSON_DISPATCH_WORKFLOW_REF ||
    stringClaim(claims, "ref") !== "refs/heads/main" ||
    stringClaim(claims, "event_name") !== "workflow_dispatch" ||
    stringClaim(claims, "runner_environment") !== "github-hosted" ||
    !SHA_PATTERN.test(workflowSha) ||
    stringClaim(claims, "sha") !== workflowSha ||
    workflowRunId !== options.request.workflowRunId ||
    Number(workflowRunAttempt) !== options.request.workflowRunAttempt
  ) {
    throw new Error("OIDC claims do not match the trusted Jetson controller");
  }

  return {
    repository: JETSON_DISPATCH_REPOSITORY,
    repositoryId: options.policy.repositoryId,
    runId: workflowRunId,
    runAttempt: options.request.workflowRunAttempt,
    workflowSha,
    tokenId: stringClaim(claims, "jti"),
  };
}

type FetchLike = typeof fetch;

export function createGitHubJwksResolver(fetchImpl: FetchLike = fetch): SigningKeyResolver {
  let cachedAt = 0;
  let cachedKeys = new Map<string, KeyObject>();
  let refreshInFlight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const response = await fetchImpl(GITHUB_OIDC_JWKS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`GitHub OIDC JWKS returned HTTP ${response.status}`);
    const payload = record(await response.json(), "GitHub OIDC JWKS response");
    if (!Array.isArray(payload.keys) || payload.keys.length === 0 || payload.keys.length > 20) {
      throw new Error("GitHub OIDC JWKS response has an invalid key set");
    }
    const nextKeys = new Map<string, KeyObject>();
    for (const value of payload.keys) {
      const key = record(value, "GitHub OIDC JWK");
      if (
        key.kty !== "RSA" ||
        key.use !== "sig" ||
        key.alg !== "RS256" ||
        typeof key.kid !== "string" ||
        key.kid.length === 0 ||
        typeof key.n !== "string" ||
        typeof key.e !== "string"
      ) {
        continue;
      }
      nextKeys.set(key.kid, createPublicKey({ key, format: "jwk" } as JsonWebKeyInput));
    }
    if (nextKeys.size === 0) throw new Error("GitHub OIDC JWKS contains no RS256 signing key");
    cachedKeys = nextKeys;
    cachedAt = Date.now();
  }

  async function refreshOnce(): Promise<void> {
    refreshInFlight ??= refresh().finally(() => {
      refreshInFlight = undefined;
    });
    await refreshInFlight;
  }

  return async (keyId) => {
    const now = Date.now();
    const refreshedExpiredCache = cachedAt === 0 || now - cachedAt > JWKS_CACHE_MS;
    if (refreshedExpiredCache) await refreshOnce();
    let key = cachedKeys.get(keyId);
    if (!key && !refreshedExpiredCache && now - cachedAt > UNKNOWN_KEY_REFRESH_INTERVAL_MS) {
      await refreshOnce();
      key = cachedKeys.get(keyId);
    }
    if (!key) throw new Error("OIDC signing key is unknown");
    return key;
  };
}
