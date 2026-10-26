// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellReleaseTrust } from "./extract-installer-pins.mts";

type ObjectValue = Record<string, unknown>;
function object(value: unknown, keys: string[], optional: string[] = []): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid upgrade trust record");
  const result = value as ObjectValue;
  if (
    keys.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !keys.includes(key) && !optional.includes(key))
  ) {
    throw new Error("Upgrade trust record has missing or unexpected fields");
  }
  return result;
}
function text(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[\r\n]/u.test(value) ||
    !pattern.test(value)
  ) {
    throw new Error("Invalid upgrade trust identity");
  }
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw new Error("Invalid upgrade trust list");
  return value.map(parse);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid upgrade trust requirement");
  return value;
}
const sha256 = (value: unknown) => text(value, /^[a-f0-9]{64}$/u);
const asset = (value: unknown) => text(value, /^openshell[A-Za-z0-9._+-]*$/u);
const hashes = (value: unknown) => list(value, sha256);
function layout(value: unknown) {
  const entry = object(value, ["assets", "manifests"]);
  return { assets: list(entry.assets, asset), manifests: list(entry.manifests, asset) };
}

/** Parse inert, already-reviewed data; this function does not grant admission. */
function parseRelease(value: unknown): OpenShellReleaseTrust {
  const entry = object(value, [
    "version",
    "formula",
    "manifests",
    "pinLayout",
    "sandboxBuilds",
    "supervisor",
    "installerTemplateSha256",
    "brevTemplateSha256",
    "featureGateTemplateSha256",
  ]);
  const version = text(entry.version, /^\d+\.\d+\.\d+$/u);
  const formula = object(entry.formula, ["asset", "sha256", "url"]);
  if (
    formula.asset !== "openshell.rb" ||
    formula.url !== `https://github.com/NVIDIA/OpenShell/releases/download/v${version}/openshell.rb`
  ) {
    throw new Error("Upgrade formula must come from the selected NVIDIA/OpenShell release");
  }
  const pins = object(entry.pinLayout, ["installer", "brev"]);
  const supervisor = object(entry.supervisor, [
    "image",
    "manifestDigest",
    "required",
    "runtimeTemplateSha256",
  ]);
  if (supervisor.image !== "ghcr.io/nvidia/openshell/supervisor")
    throw new Error("Invalid upgrade supervisor repository");
  return {
    version,
    formula: { asset: "openshell.rb", sha256: sha256(formula.sha256), url: formula.url },
    manifests: list(entry.manifests, (item) => {
      const manifest = object(item, ["asset", "sha256"]);
      return { asset: asset(manifest.asset), sha256: sha256(manifest.sha256) };
    }),
    pinLayout: { installer: layout(pins.installer), brev: layout(pins.brev) },
    sandboxBuilds: list(entry.sandboxBuilds, (item) => {
      const binary = object(item, ["sha256", "required"]);
      return { sha256: sha256(binary.sha256), required: boolean(binary.required) };
    }),
    supervisor: {
      image: supervisor.image,
      manifestDigest: text(supervisor.manifestDigest, /^sha256:[a-f0-9]{64}$/u),
      required: boolean(supervisor.required),
      runtimeTemplateSha256: hashes(supervisor.runtimeTemplateSha256),
    },
    installerTemplateSha256: hashes(entry.installerTemplateSha256),
    brevTemplateSha256: hashes(entry.brevTemplateSha256),
    featureGateTemplateSha256: hashes(entry.featureGateTemplateSha256),
  };
}

export type OpenShellTrustRegistry = {
  schemaVersion: 1;
  releases: readonly OpenShellReleaseTrust[];
  revokedTemplateSha256: readonly string[];
};

/** Parsing does not confer trust; the caller owns the source's provenance. */
export function parseOpenShellTrustRegistry(source: string): OpenShellTrustRegistry {
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("Upgrade trust registry exceeds its size limit");
  const envelope = object(JSON.parse(source), [
    "schemaVersion",
    "releases",
    "revokedTemplateSha256",
  ]);
  if (envelope.schemaVersion !== 1) throw new Error("Unsupported upgrade trust schema");
  if (
    !Array.isArray(envelope.releases) ||
    envelope.releases.length > 128 ||
    !Array.isArray(envelope.revokedTemplateSha256) ||
    envelope.revokedTemplateSha256.length > 1024
  )
    throw new Error("Invalid upgrade trust registry lists");
  const releases = envelope.releases.map(parseRelease);
  const revokedTemplateSha256 = envelope.revokedTemplateSha256.map(sha256);
  if (
    new Set(releases.map((release) => release.version)).size !== releases.length ||
    new Set(revokedTemplateSha256).size !== revokedTemplateSha256.length
  )
    throw new Error("Duplicate upgrade trust registry entry");
  return { schemaVersion: 1, releases, revokedTemplateSha256 };
}
