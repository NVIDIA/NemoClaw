// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  SANDBOX_BASE_RESOLUTION_KEY_LABEL,
  SANDBOX_BASE_RESOLUTION_LABEL,
  type SandboxBaseImageResolutionMetadata,
} from "../../../src/lib/sandbox-base-image/types";
import {
  createRebuildHermesOldBaseResolutionMetadata,
  verifyRebuildHermesCurrentBaseReuse,
  verifyRebuildHermesFinalBaseIdentity,
  verifyRebuildHermesOldBaseIsStale,
} from "../live/rebuild-hermes-base-identity.ts";
import { REBUILD_HERMES_OLD_BASE_FIXTURE } from "../live/rebuild-hermes-old-base-fixture.ts";

const imageName = "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base";
const digest = `sha256:${"a".repeat(64)}`;
const pinnedRemoteRef = `${imageName}@sha256:${"b".repeat(64)}`;
const imageId = `sha256:${"c".repeat(64)}`;
const rootFsLayers = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
const oldRootFsLayers = [`sha256:${"8".repeat(64)}`, `sha256:${"9".repeat(64)}`];

function currentMetadata(
  overrides: Partial<SandboxBaseImageResolutionMetadata> = {},
): SandboxBaseImageResolutionMetadata {
  return {
    schema: 1,
    key: "current-key",
    imageName,
    ref: `${imageName}@${digest}`,
    digest,
    source: "pinned",
    pinnedRemoteRef,
    imageId,
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.41",
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
    ...overrides,
  };
}

function resolutionLabels(metadata: SandboxBaseImageResolutionMetadata): Record<string, string> {
  return {
    [SANDBOX_BASE_RESOLUTION_KEY_LABEL]: metadata.key,
    [SANDBOX_BASE_RESOLUTION_LABEL]: Buffer.from(JSON.stringify(metadata)).toString("base64url"),
  };
}

function imageInspect(input: {
  id: string;
  repoTags?: string[];
  repoDigests?: string[];
  labels?: Record<string, string>;
  layers?: string[];
}): string {
  return JSON.stringify({
    Id: input.id,
    RepoTags: input.repoTags ?? [],
    RepoDigests: input.repoDigests ?? [],
    Os: "linux",
    Architecture: "amd64",
    Config: { Labels: input.labels ?? {} },
    RootFS: { Layers: input.layers ?? rootFsLayers },
  });
}

function oldMetadata(): SandboxBaseImageResolutionMetadata {
  return {
    ...currentMetadata(),
    key: "old-key",
    ref: `${imageName}@sha256:${"d".repeat(64)}`,
    digest: `sha256:${"d".repeat(64)}`,
    pinnedRemoteRef: REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
    imageId: `sha256:${"e".repeat(64)}`,
    glibcVersion: "2.39",
  };
}

describe("rebuild-Hermes base identity", () => {
  it("records the exact historical platform identity as a stale hint (#7144)", () => {
    const platformRef = `${imageName}@sha256:${"d".repeat(64)}`;
    const metadata = createRebuildHermesOldBaseResolutionMetadata(
      imageInspect({
        id: `sha256:${"e".repeat(64)}`,
        repoDigests: [platformRef],
      }),
      "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39",
    );

    expect(metadata).toMatchObject({
      imageName,
      ref: platformRef,
      digest: platformRef.slice(platformRef.indexOf("@") + 1),
      source: "pinned",
      pinnedRemoteRef: REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
      imageId: `sha256:${"e".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.39",
    });
    expect(metadata.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects incomplete historical image or runtime identity (#7144)", () => {
    expect(() => createRebuildHermesOldBaseResolutionMetadata("[]", "glibc 2.39")).toThrow(
      "not valid JSON",
    );
    expect(() =>
      createRebuildHermesOldBaseResolutionMetadata(
        imageInspect({ id: `sha256:${"e".repeat(64)}`, repoDigests: ["hermes:latest"] }),
        "glibc 2.39",
      ),
    ).toThrow("official immutable repository digest");
    expect(() =>
      createRebuildHermesOldBaseResolutionMetadata(
        imageInspect({
          id: `sha256:${"e".repeat(64)}`,
          repoDigests: [REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef],
        }),
        "unknown",
      ),
    ).toThrow("did not report a glibc version");
  });

  it("classifies the valid historical identity stale against the current contract (#7144)", () => {
    const old = oldMetadata();

    expect(
      verifyRebuildHermesOldBaseIsStale(
        old,
        currentMetadata(),
        imageInspect({
          id: old.imageId,
          repoDigests: [`${old.imageName}@${old.digest}`],
        }),
      ),
    ).toEqual({
      reason: "key_mismatch",
      oldKey: "old-key",
      currentKey: "current-key",
      oldRef: old.ref,
      currentRef: `${imageName}@${digest}`,
    });
  });

  it("rejects an invalid or non-stale historical identity (#7144)", () => {
    const old = oldMetadata();

    expect(() =>
      verifyRebuildHermesOldBaseIsStale(
        old,
        currentMetadata(),
        imageInspect({ id: imageId, repoDigests: [`${old.imageName}@${old.digest}`] }),
      ),
    ).toThrow("old Hermes fixture identity was invalid: local_image_changed");
    expect(() =>
      verifyRebuildHermesOldBaseIsStale(
        { ...old, key: "current-key" },
        currentMetadata(),
        imageInspect({ id: old.imageId, repoDigests: [`${old.imageName}@${old.digest}`] }),
      ),
    ).toThrow("was not classified stale by resolution key mismatch");
  });

  it.each([
    ["published", currentMetadata()],
    [
      "repository-built",
      currentMetadata({
        ref: "nemoclaw-hermes-sandbox-base-local:current",
        digest: null,
        source: "local",
        pinnedRemoteRef: undefined,
      }),
    ],
  ])("verifies a direct %s current-base reuse alias (#7144)", (_kind, expected) => {
    const reuseRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";

    expect(
      verifyRebuildHermesCurrentBaseReuse(
        expected,
        reuseRef,
        imageInspect({
          id: expected.imageId,
          repoDigests: expected.digest ? [`${imageName}@${expected.digest}`] : [],
        }),
        imageInspect({
          id: expected.imageId,
          repoTags: [reuseRef],
          repoDigests: expected.digest ? [`${imageName}@${expected.digest}`] : [],
        }),
      ),
    ).toMatchObject({
      reuseImageId: expected.imageId,
      pinnedReuseRef: `nemoclaw-hermes-sandbox-base-local:image-${"c".repeat(64)}`,
      sourceDigest: expected.digest,
      sourceImageId: expected.imageId,
      sourceRef: expected.ref,
      layerCount: rootFsLayers.length,
      rootFsChain: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects a reuse alias that changes identity, tags, or layers (#7144)", () => {
    const expected = currentMetadata();
    const reuseRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";
    const source = imageInspect({ id: imageId, repoDigests: [expected.ref] });

    expect(() =>
      verifyRebuildHermesCurrentBaseReuse(
        expected,
        reuseRef,
        source,
        imageInspect({ id: `sha256:${"f".repeat(64)}`, repoTags: [reuseRef] }),
      ),
    ).toThrow("changed the phase 1 image identity");
    expect(() =>
      verifyRebuildHermesCurrentBaseReuse(
        expected,
        reuseRef,
        source,
        imageInspect({ id: imageId }),
      ),
    ).toThrow("did not retain its test-owned local ref");
    expect(() =>
      verifyRebuildHermesCurrentBaseReuse(
        expected,
        reuseRef,
        source,
        imageInspect({ id: imageId, repoTags: [reuseRef], layers: oldRootFsLayers }),
      ),
    ).toThrow("changed the phase 1 root filesystem layers");
  });

  it.each([
    false,
    true,
  ])("proves the final image uses the phase 1 layers for stale mode %s (#7144)", (staleBaseMode) => {
    const expected = currentMetadata();
    const old = oldMetadata();
    const finalImageId = `sha256:${"f".repeat(64)}`;

    expect(
      verifyRebuildHermesFinalBaseIdentity(
        staleBaseMode,
        expected,
        old,
        imageInspect({ id: imageId, repoDigests: [expected.ref] }),
        imageInspect({
          id: old.imageId,
          repoDigests: [old.ref],
          layers: oldRootFsLayers,
        }),
        imageInspect({
          id: finalImageId,
          layers: [...rootFsLayers, `sha256:${"7".repeat(64)}`],
          labels: resolutionLabels(expected),
        }),
      ),
    ).toMatchObject({
      lane: staleBaseMode ? "stale-base" : "current-base",
      imageName,
      ref: expected.ref,
      digest,
      contentIdentity: digest,
      imageId,
      pinnedRemoteRef,
      source: "pinned",
      oldImageId: `sha256:${"e".repeat(64)}`,
      finalImageId,
      currentBaseLayerCount: rootFsLayers.length,
      finalLayerCount: rootFsLayers.length + 1,
      currentBaseRootFsChain: expect.stringMatching(/^[0-9a-f]{64}$/),
      oldBaseRootFsChain: expect.stringMatching(/^[0-9a-f]{64}$/),
      resolutionLabelsVerified: true,
    });
  });

  it.each([
    false,
    true,
  ])("fails when final provenance is missing for stale mode %s (#7144)", (staleBaseMode) => {
    const expected = currentMetadata();
    const old = oldMetadata();

    expect(() =>
      verifyRebuildHermesFinalBaseIdentity(
        staleBaseMode,
        expected,
        old,
        imageInspect({ id: imageId, repoDigests: [expected.ref] }),
        imageInspect({
          id: old.imageId,
          repoDigests: [old.ref],
          layers: oldRootFsLayers,
        }),
        imageInspect({
          id: `sha256:${"f".repeat(64)}`,
          layers: [...rootFsLayers, `sha256:${"7".repeat(64)}`],
        }),
      ),
    ).toThrow("did not retain the resolved phase 1 base metadata");
  });

  it("fails closed on mutable metadata or a different final filesystem (#7144)", () => {
    const expected = currentMetadata();
    const old = oldMetadata();
    const currentInspect = imageInspect({ id: imageId, repoDigests: [expected.ref] });
    const oldInspect = imageInspect({
      id: old.imageId,
      repoDigests: [old.ref],
      layers: oldRootFsLayers,
    });

    expect(() =>
      verifyRebuildHermesFinalBaseIdentity(
        false,
        currentMetadata({ source: "latest" }),
        old,
        currentInspect,
        oldInspect,
        "{}",
      ),
    ).toThrow("trusted immutable current base");
    expect(() =>
      verifyRebuildHermesFinalBaseIdentity(
        false,
        expected,
        old,
        currentInspect,
        oldInspect,
        "not-json",
      ),
    ).toThrow("metadata was not valid JSON");
    expect(() =>
      verifyRebuildHermesFinalBaseIdentity(
        false,
        expected,
        old,
        currentInspect,
        oldInspect,
        imageInspect({
          id: `sha256:${"f".repeat(64)}`,
          layers: [...oldRootFsLayers, `sha256:${"7".repeat(64)}`],
        }),
      ),
    ).toThrow("did not use the phase 1 current base");
    expect(() =>
      verifyRebuildHermesFinalBaseIdentity(
        false,
        expected,
        old,
        currentInspect,
        imageInspect({ id: old.imageId, repoDigests: [old.ref] }),
        imageInspect({
          id: `sha256:${"f".repeat(64)}`,
          layers: [...rootFsLayers, `sha256:${"7".repeat(64)}`],
        }),
      ),
    ).toThrow("old Hermes fixture root filesystem was not distinct from phase 1");
    expect(() =>
      verifyRebuildHermesFinalBaseIdentity(
        false,
        expected,
        { ...old, imageId: expected.imageId },
        currentInspect,
        oldInspect,
        imageInspect({
          id: `sha256:${"f".repeat(64)}`,
          layers: [...rootFsLayers, `sha256:${"7".repeat(64)}`],
        }),
      ),
    ).toThrow("old Hermes fixture base identity was not distinct");
  });
});
