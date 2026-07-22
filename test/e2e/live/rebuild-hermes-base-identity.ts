// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { parseSandboxBaseImageResolutionLabels } from "../../../src/lib/sandbox-base-image/label-codec";
import { validateSandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/resolution-metadata";
import {
  OPENSHELL_SANDBOX_MIN_GLIBC,
  SANDBOX_BASE_RESOLUTION_SCHEMA,
  type SandboxBaseImageResolutionMetadata,
} from "../../../src/lib/sandbox-base-image/types";
import { REBUILD_HERMES_OLD_BASE_FIXTURE } from "./rebuild-hermes-old-base-fixture.ts";

const HERMES_BASE_IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base";
const OFFICIAL_HERMES_BASE_DIGEST_REF =
  /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/;
const LOCAL_HERMES_BASE_REF = /^nemoclaw-hermes-sandbox-base-local:[^\s]+$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

interface DockerImageInspect {
  Id?: unknown;
  RepoTags?: unknown;
  RepoDigests?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Labels?: unknown } | null;
  RootFS?: { Layers?: unknown } | null;
}

interface ParsedDockerImageInspect {
  Id: string;
  RepoTags: unknown[];
  RepoDigests: unknown[];
  Os: string;
  Architecture: string;
  Config: { Labels?: unknown } | null;
  RootFS: { Layers?: unknown } | null;
}

type TrustedCurrentBaseMetadata = SandboxBaseImageResolutionMetadata &
  (
    | { digest: string; pinnedRemoteRef: string; source: "pinned" }
    | { digest: null; pinnedRemoteRef?: undefined; source: "local" }
  );

export interface RebuildHermesFinalBaseEvidence {
  lane: "current-base" | "stale-base";
  imageName: string;
  ref: string;
  digest: string | null;
  contentIdentity: string;
  imageId: string;
  pinnedRemoteRef: string | null;
  source: "pinned" | "local";
  os: string;
  architecture: string;
  oldDigest: string;
  oldImageId: string;
  finalImageId: string;
  currentBaseLayerCount: number;
  finalLayerCount: number;
  currentBaseRootFsChain: string;
  oldBaseRootFsChain: string;
  resolutionLabelsVerified: boolean;
}

function parseDockerImageInspect(
  inspectJson: string,
  label:
    | "old Hermes fixture"
    | "phase 1 current Hermes base"
    | "current Hermes base reuse alias"
    | "rebuilt Hermes sandbox",
): ParsedDockerImageInspect {
  let parsed: DockerImageInspect;
  try {
    const value = JSON.parse(inspectJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    parsed = value as DockerImageInspect;
  } catch {
    throw new Error(`${label} Docker image metadata was not valid JSON`);
  }

  if (
    typeof parsed.Id !== "string" ||
    !IMAGE_ID.test(parsed.Id) ||
    typeof parsed.Os !== "string" ||
    !parsed.Os ||
    typeof parsed.Architecture !== "string" ||
    !parsed.Architecture ||
    (parsed.RepoTags !== null &&
      parsed.RepoTags !== undefined &&
      !Array.isArray(parsed.RepoTags)) ||
    (parsed.RepoDigests !== null &&
      parsed.RepoDigests !== undefined &&
      !Array.isArray(parsed.RepoDigests))
  ) {
    throw new Error(`${label} Docker image identity was incomplete`);
  }
  return {
    Id: parsed.Id,
    RepoTags: Array.isArray(parsed.RepoTags) ? parsed.RepoTags : [],
    RepoDigests: Array.isArray(parsed.RepoDigests) ? parsed.RepoDigests : [],
    Os: parsed.Os,
    Architecture: parsed.Architecture,
    Config: parsed.Config ?? null,
    RootFS: parsed.RootFS ?? null,
  };
}

function parseGlibcVersion(output: string): string {
  const versions = output.match(/\b\d+\.\d+\b/g) ?? [];
  const version = versions.at(-1);
  if (!version) throw new Error("old Hermes fixture did not report a glibc version");
  return version;
}

/**
 * Label the synthetic old sandbox with its real historical base identity. The
 * fixture-scoped key is deliberately different from the current resolver key,
 * so rebuild must classify the recorded metadata as stale before resolving the
 * current base again.
 */
export function createRebuildHermesOldBaseResolutionMetadata(
  inspectJson: string,
  glibcVersionOutput: string,
): SandboxBaseImageResolutionMetadata {
  const inspected = parseDockerImageInspect(inspectJson, "old Hermes fixture");
  const ref = inspected.RepoDigests.find(
    (entry): entry is string =>
      typeof entry === "string" && OFFICIAL_HERMES_BASE_DIGEST_REF.test(entry),
  );
  if (!ref) {
    throw new Error("old Hermes fixture lacked an official immutable repository digest");
  }
  const digest = ref.slice(ref.indexOf("@") + 1);
  const glibcVersion = parseGlibcVersion(glibcVersionOutput);
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        fixture: REBUILD_HERMES_OLD_BASE_FIXTURE,
        ref,
        digest,
        imageId: inspected.Id,
        os: inspected.Os,
        architecture: inspected.Architecture,
        glibcVersion,
      }),
    )
    .digest("hex");

  return {
    schema: SANDBOX_BASE_RESOLUTION_SCHEMA,
    key,
    imageName: HERMES_BASE_IMAGE_NAME,
    ref,
    digest,
    source: "pinned",
    pinnedRemoteRef: REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
    imageId: inspected.Id,
    os: inspected.Os,
    architecture: inspected.Architecture,
    glibcVersion,
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
  };
}

/**
 * Prove with the production validator that the recorded historical identity is
 * valid on its own terms, but stale for the exact current resolution contract.
 */
export function verifyRebuildHermesOldBaseIsStale(
  oldMetadata: SandboxBaseImageResolutionMetadata,
  currentMetadata: SandboxBaseImageResolutionMetadata | null,
  oldInspectJson: string,
): {
  reason: "key_mismatch";
  oldKey: string;
  currentKey: string;
  oldRef: string;
  currentRef: string;
} {
  const current = requireRebuildHermesCurrentBaseIdentity(currentMetadata);
  const inspected = parseDockerImageInspect(oldInspectJson, "old Hermes fixture");
  const oldValidation = validateSandboxBaseImageResolutionMetadata({
    metadata: oldMetadata,
    expectedKey: oldMetadata.key,
    imageName: oldMetadata.imageName,
    pinnedRemoteRef: oldMetadata.pinnedRemoteRef,
    requireOpenshellSandboxAbi: oldMetadata.requireOpenshellSandboxAbi,
    minGlibcVersion: oldMetadata.minGlibcVersion,
    inspected,
  });
  if (!oldValidation.ok) {
    throw new Error(`old Hermes fixture identity was invalid: ${oldValidation.reason}`);
  }

  const currentValidation = validateSandboxBaseImageResolutionMetadata({
    metadata: oldMetadata,
    expectedKey: current.key,
    imageName: current.imageName,
    pinnedRemoteRef: current.pinnedRemoteRef,
    requireOpenshellSandboxAbi: current.requireOpenshellSandboxAbi,
    minGlibcVersion: current.minGlibcVersion,
    inspected,
  });
  if (currentValidation.ok || currentValidation.reason !== "key_mismatch") {
    throw new Error("old Hermes fixture was not classified stale by resolution key mismatch");
  }

  return {
    reason: currentValidation.reason,
    oldKey: oldMetadata.key,
    currentKey: current.key,
    oldRef: oldMetadata.ref,
    currentRef: current.ref,
  };
}

export function requireRebuildHermesCurrentBaseIdentity(
  metadata: SandboxBaseImageResolutionMetadata | null,
): TrustedCurrentBaseMetadata {
  if (!metadata) {
    throw new Error("phase 1 Hermes sandbox did not record current base-image identity");
  }
  const commonIdentityIsValid =
    metadata.schema === SANDBOX_BASE_RESOLUTION_SCHEMA &&
    metadata.imageName === HERMES_BASE_IMAGE_NAME &&
    Boolean(metadata.key) &&
    IMAGE_ID.test(metadata.imageId) &&
    Boolean(metadata.os) &&
    Boolean(metadata.architecture);
  const pinnedIdentityIsValid =
    metadata.source === "pinned" &&
    Boolean(metadata.digest) &&
    Boolean(metadata.pinnedRemoteRef) &&
    OFFICIAL_HERMES_BASE_DIGEST_REF.test(metadata.ref) &&
    OFFICIAL_HERMES_BASE_DIGEST_REF.test(metadata.pinnedRemoteRef ?? "") &&
    metadata.ref === `${metadata.imageName}@${metadata.digest}`;
  const localIdentityIsValid =
    metadata.source === "local" &&
    metadata.digest === null &&
    metadata.pinnedRemoteRef === undefined &&
    LOCAL_HERMES_BASE_REF.test(metadata.ref);
  if (!commonIdentityIsValid || (!pinnedIdentityIsValid && !localIdentityIsValid)) {
    throw new Error("phase 1 Hermes sandbox did not use a trusted immutable current base");
  }
  return metadata as TrustedCurrentBaseMetadata;
}

function resolutionMetadataMatches(
  actual: SandboxBaseImageResolutionMetadata | null,
  expected: TrustedCurrentBaseMetadata,
): boolean {
  if (!actual) return false;
  return (
    actual.schema === expected.schema &&
    actual.key === expected.key &&
    actual.imageName === expected.imageName &&
    actual.ref === expected.ref &&
    actual.digest === expected.digest &&
    actual.source === expected.source &&
    actual.pinnedRemoteRef === expected.pinnedRemoteRef &&
    actual.imageId === expected.imageId &&
    actual.os === expected.os &&
    actual.architecture === expected.architecture &&
    actual.glibcVersion === expected.glibcVersion &&
    actual.requireOpenshellSandboxAbi === expected.requireOpenshellSandboxAbi &&
    actual.minGlibcVersion === expected.minGlibcVersion
  );
}

function rootFsLayers(inspected: ParsedDockerImageInspect, label: string): string[] {
  const layers = inspected.RootFS?.Layers;
  if (!Array.isArray(layers) || layers.some((layer) => typeof layer !== "string")) {
    throw new Error(`${label} Docker root filesystem identity was incomplete`);
  }
  return layers as string[];
}

function rootFsChain(layers: string[]): string {
  return createHash("sha256").update(JSON.stringify(layers)).digest("hex");
}

function layersStartWith(actual: string[], expectedPrefix: string[]): boolean {
  return (
    expectedPrefix.length > 0 &&
    actual.length >= expectedPrefix.length &&
    expectedPrefix.every((layer, index) => actual[index] === layer)
  );
}

function requireInspectMatchesResolution(
  inspected: ParsedDockerImageInspect,
  expected: SandboxBaseImageResolutionMetadata,
  subject: string,
): void {
  if (
    inspected.Id !== expected.imageId ||
    inspected.Os !== expected.os ||
    inspected.Architecture !== expected.architecture
  ) {
    throw new Error(`${subject} inspection did not match recorded identity`);
  }
  if (
    expected.digest &&
    !inspected.RepoDigests.some((entry) => entry === `${expected.imageName}@${expected.digest}`)
  ) {
    throw new Error(`${subject} inspection lacked its recorded digest`);
  }
}

/** Prove the normal lane's local alias is the exact phase 1 image, not a rebuild. */
export function verifyRebuildHermesCurrentBaseReuse(
  expectedMetadata: SandboxBaseImageResolutionMetadata | null,
  reuseRef: string,
  sourceInspectJson: string,
  reuseInspectJson: string,
): {
  reuseImageId: string;
  pinnedReuseRef: string;
  sourceDigest: string | null;
  sourceImageId: string;
  sourceRef: string;
  rootFsChain: string;
  layerCount: number;
} {
  const expected = requireRebuildHermesCurrentBaseIdentity(expectedMetadata);
  if (!LOCAL_HERMES_BASE_REF.test(reuseRef)) {
    throw new Error("current Hermes base reuse requires a test-owned local image ref");
  }
  const source = parseDockerImageInspect(sourceInspectJson, "phase 1 current Hermes base");
  const reuse = parseDockerImageInspect(reuseInspectJson, "current Hermes base reuse alias");
  requireInspectMatchesResolution(source, expected, "phase 1 current Hermes base");
  if (
    reuse.Id !== source.Id ||
    reuse.Os !== source.Os ||
    reuse.Architecture !== source.Architecture
  ) {
    throw new Error("current Hermes base reuse alias changed the phase 1 image identity");
  }
  if (!reuse.RepoTags.some((entry) => entry === reuseRef)) {
    throw new Error("current Hermes base reuse alias did not retain its test-owned local ref");
  }
  const sourceLayers = rootFsLayers(source, "phase 1 current Hermes base");
  const reuseLayers = rootFsLayers(reuse, "current Hermes base reuse alias");
  if (
    sourceLayers.length !== reuseLayers.length ||
    !sourceLayers.every((layer, index) => reuseLayers[index] === layer)
  ) {
    throw new Error("current Hermes base reuse alias changed the phase 1 root filesystem layers");
  }

  return {
    reuseImageId: reuse.Id,
    pinnedReuseRef: `nemoclaw-hermes-sandbox-base-local:image-${reuse.Id.slice("sha256:".length)}`,
    sourceDigest: expected.digest,
    sourceImageId: expected.imageId,
    sourceRef: expected.ref,
    rootFsChain: rootFsChain(sourceLayers),
    layerCount: sourceLayers.length,
  };
}

/** Fail unless the rebuilt filesystem is derived from the exact phase 1 base. */
export function verifyRebuildHermesFinalBaseIdentity(
  staleBaseMode: boolean,
  expectedMetadata: SandboxBaseImageResolutionMetadata | null,
  oldMetadata: SandboxBaseImageResolutionMetadata,
  currentBaseInspectJson: string,
  oldBaseInspectJson: string,
  finalInspectJson: string,
): RebuildHermesFinalBaseEvidence {
  const expected = requireRebuildHermesCurrentBaseIdentity(expectedMetadata);
  if (
    oldMetadata.key === expected.key ||
    oldMetadata.ref === expected.ref ||
    oldMetadata.imageId === expected.imageId ||
    oldMetadata.pinnedRemoteRef === expected.pinnedRemoteRef
  ) {
    throw new Error("old Hermes fixture base identity was not distinct from phase 1");
  }
  const currentBase = parseDockerImageInspect(
    currentBaseInspectJson,
    "phase 1 current Hermes base",
  );
  const oldBase = parseDockerImageInspect(oldBaseInspectJson, "old Hermes fixture");
  const finalImage = parseDockerImageInspect(finalInspectJson, "rebuilt Hermes sandbox");
  requireInspectMatchesResolution(currentBase, expected, "phase 1 current Hermes base");
  requireInspectMatchesResolution(oldBase, oldMetadata, "old Hermes fixture");

  const currentLayers = rootFsLayers(currentBase, "phase 1 current Hermes base");
  const oldLayers = rootFsLayers(oldBase, "old Hermes fixture");
  const finalLayers = rootFsLayers(finalImage, "rebuilt Hermes sandbox");
  if (
    currentLayers.length === oldLayers.length &&
    currentLayers.every((layer, index) => oldLayers[index] === layer)
  ) {
    throw new Error("old Hermes fixture root filesystem was not distinct from phase 1");
  }
  if (!layersStartWith(finalLayers, currentLayers)) {
    throw new Error("rebuilt Hermes sandbox root filesystem did not use the phase 1 current base");
  }

  const finalResolutionMetadata = parseSandboxBaseImageResolutionLabels(finalImage.Config?.Labels);
  if (!resolutionMetadataMatches(finalResolutionMetadata, expected)) {
    throw new Error("rebuilt Hermes sandbox did not retain the resolved phase 1 base metadata");
  }

  return {
    lane: staleBaseMode ? "stale-base" : "current-base",
    imageName: expected.imageName,
    ref: expected.ref,
    digest: expected.digest,
    contentIdentity: expected.digest ?? expected.imageId,
    imageId: expected.imageId,
    pinnedRemoteRef: expected.pinnedRemoteRef ?? null,
    source: expected.source,
    os: expected.os,
    architecture: expected.architecture,
    oldDigest: oldMetadata.digest ?? oldMetadata.imageId,
    oldImageId: oldMetadata.imageId,
    finalImageId: finalImage.Id,
    currentBaseLayerCount: currentLayers.length,
    finalLayerCount: finalLayers.length,
    currentBaseRootFsChain: rootFsChain(currentLayers),
    oldBaseRootFsChain: rootFsChain(oldLayers),
    resolutionLabelsVerified: finalResolutionMetadata !== null,
  };
}
