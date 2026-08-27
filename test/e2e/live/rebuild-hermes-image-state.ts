// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { extractBuiltImageRef } from "../../../src/lib/build-context";
import {
  LOCAL_SANDBOX_IMAGE_REPO,
  SANDBOX_FROM_IMAGE_REPO,
} from "../../../src/lib/domain/sandbox/image-tag";
import { MANAGED_IMAGE_REPOSITORIES } from "../../../src/lib/onboard/managed-image/contract";

export interface RebuildHermesRegistryImageState {
  openshellDriver: "docker";
  imageTag: string;
  fromDockerfile: null;
  workload: {
    schemaVersion: 1;
    kind: "legacy-dockerfile";
    reference: string;
    shared: false;
  };
}

export interface RebuildHermesReplacementLifecycleReceipt {
  lifecycleGeneration: string;
  lifecycleLiveIdentityFingerprint: string;
}

export interface RebuildHermesManagedImageEvidence {
  lane: "managed-image";
  reference: string;
  imageId: string;
  os: string;
  architecture: string;
  repoDigestVerified: true;
}

export async function cleanupTrackedRebuildHermesImage(
  imageTag: string | null,
  remove: (imageTag: string) => Promise<void>,
): Promise<void> {
  if (imageTag !== null) await remove(imageTag);
}

export function requireRebuildHermesFinalImageRef(value: unknown, sandboxName: string): string {
  const prefix = `${LOCAL_SANDBOX_IMAGE_REPO}:${sandboxName}-`;
  const imageRef = typeof value === "string" ? value : "";
  const buildPart = imageRef.startsWith(prefix) ? imageRef.slice(prefix.length) : "";
  const managedDigestPrefix = `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:`;
  const managedDigest = imageRef.startsWith(managedDigestPrefix)
    ? imageRef.slice(managedDigestPrefix.length)
    : "";
  if (/^\d+$/.test(buildPart) || /^[0-9a-f]{64}$/.test(managedDigest)) return imageRef;
  throw new Error(
    `rebuilt Hermes image reference must be an immutable ${managedDigestPrefix}<digest> or owned ${prefix}<build> reference; got ${imageRef || "<missing>"}`,
  );
}

export function verifyRebuildHermesManagedImageIdentity(
  expectedReference: string,
  inspectJson: string,
): RebuildHermesManagedImageEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectJson);
  } catch {
    throw new Error("rebuilt Hermes managed image metadata was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("rebuilt Hermes managed image metadata was incomplete");
  }
  const inspected = parsed as Record<string, unknown>;
  const imageId = inspected.Id;
  const repoDigests = inspected.RepoDigests;
  const os = inspected.Os;
  const architecture = inspected.Architecture;
  if (
    typeof imageId !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(imageId) ||
    !Array.isArray(repoDigests) ||
    !repoDigests.includes(expectedReference) ||
    typeof os !== "string" ||
    !os ||
    typeof architecture !== "string" ||
    !architecture
  ) {
    throw new Error("rebuilt Hermes runtime did not use the exact managed image receipt");
  }
  return {
    lane: "managed-image",
    reference: expectedReference,
    imageId,
    os,
    architecture,
    repoDigestVerified: true,
  };
}

export function requireRebuildHermesReplacementLifecycleReceipt(
  value: Record<string, unknown>,
): RebuildHermesReplacementLifecycleReceipt {
  const lifecycleGeneration = value.lifecycleGeneration;
  const lifecycleLiveIdentityFingerprint = value.lifecycleLiveIdentityFingerprint;
  if (
    typeof lifecycleGeneration !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      lifecycleGeneration,
    )
  ) {
    throw new Error("rebuilt Hermes registry is missing its journaled lifecycle generation");
  }
  if (
    typeof lifecycleLiveIdentityFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(lifecycleLiveIdentityFingerprint)
  ) {
    throw new Error("rebuilt Hermes registry is missing its live lifecycle identity fingerprint");
  }
  return { lifecycleGeneration, lifecycleLiveIdentityFingerprint };
}

export function rebuildHermesRegistryImageState(
  createOutput: string,
): RebuildHermesRegistryImageState {
  const imageTag = extractBuiltImageRef(createOutput);
  const prefix = `${SANDBOX_FROM_IMAGE_REPO}:`;
  const buildId = imageTag?.startsWith(prefix) ? imageTag.slice(prefix.length) : "";
  if (!imageTag || !/^\d+$/.test(buildId)) {
    throw new Error(
      `old Hermes sandbox create must report an exact ${prefix}<build-id> image tag; got ${imageTag ?? "<missing>"}`,
    );
  }
  return {
    openshellDriver: "docker",
    imageTag,
    fromDockerfile: null,
    workload: {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: imageTag,
      shared: false,
    },
  };
}
