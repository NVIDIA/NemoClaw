// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";

const CREDENTIAL_KEY = /^[A-Z][A-Z0-9_]{0,127}$/u;

/** Build a stable identifier from validated names, never from credential values. */
function profileIdentityDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function familyKeys(primary: string, keys: readonly string[]): string[] {
  if (
    !CREDENTIAL_KEY.test(primary) ||
    keys.length > 33 ||
    !keys.includes(primary) ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) =>
        !CREDENTIAL_KEY.test(key) ||
        (key !== primary && (!key.startsWith(`${primary}_`) || key.length <= primary.length + 1)),
    )
  ) {
    throw new Error("Provider credential names do not match the selected credential family.");
  }
  return [...keys].sort();
}

/** Bind an immutable profile to the selected names, without hashing credential values. */
export function credentialFamilyProfileType(
  baseType: string,
  primary: string,
  keys: readonly string[],
): string {
  const sorted = familyKeys(primary, keys);
  if (!/^[a-z][a-z0-9-]*$/u.test(baseType) || baseType === "generic") {
    throw new Error("Additional credentials require an explicit owned provider profile.");
  }
  if (sorted.length === 1) return baseType;
  const digest = profileIdentityDigest(JSON.stringify([baseType, primary, sorted])).slice(0, 32);
  return `${baseType}-${digest}`;
}

export function matchesCredentialFamilyProfileType(
  actualType: string,
  baseType: string,
  primary: string,
  keys: readonly string[],
): boolean {
  try {
    familyKeys(primary, keys);
    if (baseType === "generic") return actualType === baseType;
    return actualType === credentialFamilyProfileType(baseType, primary, keys);
  } catch {
    return false;
  }
}

export function credentialFamilyBaseType(profileType: string): string {
  return profileType.replace(/-[a-f0-9]{32}$/u, "");
}

export function credentialFamilyPrimary(keys: readonly string[]): string | null {
  const primary = keys.find((key) =>
    keys.every((other) => other === key || other.startsWith(`${key}_`)),
  );
  if (!primary) return null;
  try {
    familyKeys(primary, keys);
    return primary;
  } catch {
    return null;
  }
}

/** Preserve the checked-in profile's network and execution authority. */
export function buildCredentialFamilyProfile(
  source: string,
  primary: string,
  keys: readonly string[],
): { readonly profileType: string; readonly source: string } {
  const contract = parseCheckedInProviderProfileContract(source);
  if (!contract) throw new Error("The owned provider profile is invalid.");
  const sorted = familyKeys(primary, keys);
  const primaryCredential = contract.boundary.credentials.find(
    (credential) => Array.isArray(credential.env_vars) && credential.env_vars.includes(primary),
  );
  if (!primaryCredential || primaryCredential.refresh) {
    throw new Error("Additional credentials require a declared static credential.");
  }
  const profileType = credentialFamilyProfileType(contract.profileId, primary, sorted);
  if (profileType === contract.profileId) return { profileType, source };
  const profile = YAML.parse(source) as Record<string, unknown>;
  const credentials = profile.credentials as Record<string, unknown>[];
  const declared = new Set(
    contract.boundary.credentials.flatMap((credential) => credential.env_vars as string[]),
  );
  profile.id = profileType;
  profile.credentials = [
    ...credentials,
    ...sorted
      .filter((key) => key !== primary && !declared.has(key))
      .map((key) => ({
        name: key,
        env_vars: [key],
        required: false,
        auth_style: primaryCredential.auth_style,
        header_name: primaryCredential.header_name,
        query_param: primaryCredential.query_param ?? "",
      })),
  ];
  return { profileType, source: JSON.stringify(profile) };
}

export function credentialFamilyProfileContract(
  profilePath: string,
  primary: string,
  keys: readonly string[],
) {
  const generated = buildCredentialFamilyProfile(
    fs.readFileSync(profilePath, "utf8"),
    primary,
    keys,
  );
  const contract = parseCheckedInProviderProfileContract(generated.source);
  if (!contract) throw new Error("The generated credential profile is invalid.");
  return contract;
}

/** Keep generated profile files private and remove them after import or verification. */
export async function withCredentialFamilyProfile<T>(
  profilePath: string,
  primary: string,
  keys: readonly string[],
  use: (profile: { readonly profileType: string; readonly profilePath: string }) => T | Promise<T>,
): Promise<T> {
  const source = fs.readFileSync(profilePath, "utf8");
  const generated = buildCredentialFamilyProfile(source, primary, keys);
  if (keys.length === 1) return use({ profileType: generated.profileType, profilePath });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-profile-"));
  try {
    const generatedPath = path.join(directory, "profile.json");
    fs.writeFileSync(generatedPath, generated.source, { mode: 0o600, flag: "wx" });
    return await use({ profileType: generated.profileType, profilePath: generatedPath });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
