// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function refreshContract(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const refresh = value as Record<string, unknown>;
  if (
    typeof refresh.strategy !== "string" ||
    !refresh.strategy ||
    !Array.isArray(refresh.scopes) ||
    refresh.scopes.some((scope) => typeof scope !== "string") ||
    !Array.isArray(refresh.material)
  ) {
    return null;
  }
  const material = refresh.material.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name) return null;
    return {
      name: entry.name,
      required: entry.required,
      secret: entry.secret,
    };
  });
  if (material.some((entry) => entry === null)) return null;
  return {
    strategy: refresh.strategy,
    scopes: refresh.scopes,
    material,
  };
}

function providerProfileContract(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.id !== "string" ||
    !Array.isArray(profile.credentials) ||
    !Array.isArray(profile.endpoints) ||
    !Array.isArray(profile.binaries) ||
    typeof profile.inference_capable !== "boolean"
  ) {
    return null;
  }
  const credentials = profile.credentials.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const credential = value as Record<string, unknown>;
    if (
      typeof credential.name !== "string" ||
      !credential.name ||
      !Array.isArray(credential.env_vars) ||
      credential.env_vars.some((envVar) => typeof envVar !== "string") ||
      typeof credential.required !== "boolean" ||
      typeof credential.auth_style !== "string" ||
      typeof credential.header_name !== "string" ||
      typeof credential.query_param !== "string"
    ) {
      return null;
    }
    const refresh = credential.refresh === undefined ? null : refreshContract(credential.refresh);
    if (credential.refresh !== undefined && refresh === null) return null;
    return {
      name: credential.name,
      env_vars: credential.env_vars,
      required: credential.required,
      auth_style: credential.auth_style,
      header_name: credential.header_name,
      query_param: credential.query_param,
      refresh,
    };
  });
  if (credentials.some((credential) => credential === null)) return null;
  return {
    id: profile.id,
    credentials,
    endpoints: profile.endpoints,
    binaries: profile.binaries,
    inference_capable: profile.inference_capable,
  };
}

/** Stable digest of the provider fields that define its credential boundary. */
export function providerProfileContractDigest(value: unknown): string | null {
  const contract = providerProfileContract(value);
  if (!contract) return null;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(contract)))
    .digest("hex");
}
