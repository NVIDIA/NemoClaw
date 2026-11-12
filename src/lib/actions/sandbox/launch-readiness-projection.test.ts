// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { entry, servingProfile } from "../../../../test/helpers/native-launch-readiness.ts";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { buildLaunchReadinessRegistryProjection, launchReadinessDigest } from "./launch-readiness";

describe("launch readiness registry projection", () => {
  it("binds every host mount field without projecting the host source path (#8942)", () => {
    const agent = loadAgent("openclaw");
    const source = "/private/host/customer-project";
    const mounted: SandboxEntry = {
      ...entry(),
      hostMounts: [
        {
          source,
          target: "/sandbox/project",
          readOnly: true,
          sourceIdentity: { device: "11", inode: "22" },
        },
      ],
    };
    const projection = buildLaunchReadinessRegistryProjection(mounted, agent) as {
      hostMounts: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(projection)).not.toContain(source);
    expect(projection.hostMounts).toEqual([
      {
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        target: "/sandbox/project",
        readOnly: true,
        sourceIdentity: { device: "11", inode: "22" },
      },
    ]);

    const original = launchReadinessDigest(projection);
    const mutations: SandboxEntry[] = [
      {
        ...mounted,
        hostMounts: [{ ...mounted.hostMounts![0]!, source: `${source}-changed` }],
      },
      {
        ...mounted,
        hostMounts: [{ ...mounted.hostMounts![0]!, target: "/sandbox/changed" }],
      },
      {
        ...mounted,
        hostMounts: [
          {
            ...mounted.hostMounts![0]!,
            sourceIdentity: { device: "12", inode: "22" },
          },
        ],
      },
      {
        ...mounted,
        hostMounts: [
          {
            ...mounted.hostMounts![0]!,
            sourceIdentity: { device: "11", inode: "23" },
          },
        ],
      },
    ];
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(buildLaunchReadinessRegistryProjection(mutation, agent)),
            original,
          ),
      ),
    ).toBe(true);
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        {
          ...mounted,
          hostMounts: [{ ...mounted.hostMounts![0]!, readOnly: false as true }],
        },
        agent,
      ),
    ).toThrow();
  });

  it("binds every semantic serving profile provenance field (#8942)", () => {
    const agent = loadAgent("openclaw");
    const originalProfile = servingProfile();
    const original = launchReadinessDigest(
      buildLaunchReadinessRegistryProjection(
        { ...entry(), servingProfileProvenance: originalProfile },
        agent,
      ),
    );
    const mutations: NonNullable<SandboxEntry["servingProfileProvenance"]>[] = [
      { ...originalProfile, catalogDigest: `sha256:${"a".repeat(64)}` },
      { ...originalProfile, preset: { ...originalProfile.preset, id: "changed" } },
      {
        ...originalProfile,
        preset: { ...originalProfile.preset, digest: `sha256:${"a".repeat(64)}` },
      },
      { ...originalProfile, preset: { ...originalProfile.preset, displayName: "Changed" } },
      {
        ...originalProfile,
        preset: { ...originalProfile.preset, supportState: "experimental" },
      },
      { ...originalProfile, recipe: { ...originalProfile.recipe, id: "changed" } },
      {
        ...originalProfile,
        recipe: { ...originalProfile.recipe, digest: `sha256:${"a".repeat(64)}` },
      },
      { ...originalProfile, recipe: { ...originalProfile.recipe, backend: "changed" } },
      { ...originalProfile, model: { ...originalProfile.model, id: "changed" } },
      { ...originalProfile, model: { ...originalProfile.model, revision: "changed" } },
      { ...originalProfile, runtimeImage: "example.com/changed@sha256:immutable" },
      { ...originalProfile, estimatedImageDownloadBytes: 1_001 },
      { ...originalProfile, estimatedModelDownloadBytes: 2_001 },
    ];
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(
              buildLaunchReadinessRegistryProjection(
                { ...entry(), servingProfileProvenance: mutation },
                agent,
              ),
            ),
            original,
          ),
      ),
    ).toBe(true);
  });

  it("excludes diagnostic timestamps, source paths, and GPU detail from the projection", () => {
    const agent = loadAgent("openclaw");
    const first: SandboxEntry = {
      ...entry(),
      createdAt: "2026-01-01T00:00:00.000Z",
      sandboxGpuProof: {
        status: "verified",
        cudaVerified: true,
        label: "cuda",
        detail: "first diagnostic",
        at: "2026-01-01T00:00:00.000Z",
      },
    };
    const second: SandboxEntry = {
      ...first,
      createdAt: "2026-06-01T00:00:00.000Z",
      sandboxGpuProof: {
        ...first.sandboxGpuProof!,
        detail: "second diagnostic",
        at: "2026-06-01T00:00:00.000Z",
      },
    };
    expect(launchReadinessDigest(buildLaunchReadinessRegistryProjection(second, agent))).toBe(
      launchReadinessDigest(buildLaunchReadinessRegistryProjection(first, agent)),
    );
  });
});
