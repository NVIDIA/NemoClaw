// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent } from "../../../test/helpers/base-image-test-harness";

const dockerMocks = vi.hoisted(() => ({
  build: vi.fn(),
  capture: vi.fn(),
  imageInspect: vi.fn(),
  imageInspectFormat: vi.fn(),
  infoFormat: vi.fn(),
  rmi: vi.fn(),
  tag: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerBuild: dockerMocks.build,
  dockerCapture: dockerMocks.capture,
  dockerImageInspect: dockerMocks.imageInspect,
  dockerImageInspectFormat: dockerMocks.imageInspectFormat,
  dockerInfoFormat: dockerMocks.infoFormat,
  dockerRmi: dockerMocks.rmi,
  dockerTag: dockerMocks.tag,
}));

vi.mock("../sandbox-base-image/source-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox-base-image/source-identity")>()),
  baseImageInputsChangedSinceMain: vi.fn(() => false),
  baseImageInputsDirty: vi.fn(() => false),
  buildLocalBaseTag: vi.fn((prefix: string) => `${prefix}:local`),
  getNearestVersionedBaseImageTags: vi.fn(() => []),
  getSourceRevisionIds: vi.fn(() => ["test-revision"]),
  getSourceShortShaTags: vi.fn(() => []),
  getVersionedBaseImageTags: vi.fn(() => []),
}));

import { ROOT } from "../runner";
import {
  createSandboxBaseImageBuildProvenanceKey,
  createSandboxBaseImageResolutionKey,
  type LocalImageMetadata,
  type ResolveBaseImageOptions,
  SANDBOX_BASE_BUILD_PROVENANCE_LABEL,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { bindLocalAgentBaseImageHandoffToResolution } from "./base-image";

function fixture(options: { canonicalSource?: boolean } = {}) {
  const agent = makeAgent();
  const dockerfile = fs.readFileSync(agent.dockerfilePath as string, "utf8");
  const pinnedRemoteRef = dockerfile.match(/^ARG BASE_IMAGE=(\S+)$/m)?.[1] as string;
  const resolutionOptions: ResolveBaseImageOptions = {
    imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
    dockerfilePath: agent.dockerfileBasePath as string,
    localTag: "nemoclaw-hermes-sandbox-base-local:local",
    envVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
    label: "Hermes Agent sandbox base image",
    requireOpenshellSandboxAbi: process.platform === "linux",
    rootDir: ROOT,
    pinnedRemoteRef,
    preferPinnedRemoteRef: true,
    validateImage: () => true,
    validationDescription: "the required MCP Streamable HTTP runtime",
  };
  const imageId = `sha256:${"a".repeat(64)}`;
  const canonicalRef = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
  const sourceRef = options.canonicalSource ? canonicalRef : resolutionOptions.localTag;
  const handoffRef = options.canonicalSource
    ? canonicalRef
    : `nemoclaw-hermes-sandbox-base-local:rebuild-343338-${"b".repeat(16)}-image-${"a".repeat(64)}`;
  const metadata: SandboxBaseImageResolutionMetadata = {
    schema: 1,
    key: createSandboxBaseImageResolutionKey(resolutionOptions),
    imageName: resolutionOptions.imageName,
    ref: sourceRef,
    digest: null,
    source: "local",
    imageId,
    os: "linux",
    architecture: "amd64",
    glibcVersion: process.platform === "linux" ? "2.41" : null,
    requireOpenshellSandboxAbi: process.platform === "linux",
    minGlibcVersion: "2.39",
  };
  const provenance = `${createSandboxBaseImageBuildProvenanceKey(resolutionOptions)}.${"c".repeat(64)}`;
  return { agent, sourceRef, handoffRef, imageId, metadata, provenance };
}

function installInspections(
  input: ReturnType<typeof fixture>,
  overrides: {
    source?: Partial<LocalImageMetadata>;
    handoff?: Partial<LocalImageMetadata>;
    sourceProvenance?: string | null;
    handoffProvenance?: string | null;
  } = {},
): void {
  dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) => {
    const handoff = ref === input.handoffRef && input.handoffRef !== input.sourceRef;
    const imageOverrides = handoff ? overrides.handoff : overrides.source;
    const provenance = handoff
      ? overrides.handoffProvenance === undefined
        ? input.provenance
        : overrides.handoffProvenance
      : overrides.sourceProvenance === undefined
        ? input.provenance
        : overrides.sourceProvenance;
    return format === "{{json .}}"
      ? JSON.stringify({
          Id: input.imageId,
          Os: input.metadata.os,
          Architecture: input.metadata.architecture,
          RepoDigests: [],
          Config: {
            Labels: {
              ...(provenance ? { [SANDBOX_BASE_BUILD_PROVENANCE_LABEL]: provenance } : {}),
            },
          },
          ...imageOverrides,
        })
      : input.imageId;
  });
}

describe("agent base-image local handoff authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
  });

  it.each([
    ["stable local alias", false],
    ["canonical content-addressed source", true],
  ])("binds an exact reused hint from a %s", (_case, canonicalSource) => {
    const input = fixture({ canonicalSource });
    installInspections(input);

    expect(
      bindLocalAgentBaseImageHandoffToResolution(
        input.agent,
        input.sourceRef,
        input.handoffRef,
        input.metadata,
        input.metadata,
      ),
    ).toEqual({ ref: input.handoffRef, provenance: input.provenance });
  });

  it.each([
    "fresh metadata object",
    "wrong schema",
    "wrong key",
    "wrong image name",
    "non-local source",
    "non-null digest",
    "noncanonical stable ref",
    "wrong image ID",
  ])("refuses %s as handoff authority", (invalidCase) => {
    const input = fixture();
    installInspections(input);
    const metadata: SandboxBaseImageResolutionMetadata = {
      ...input.metadata,
      ...(invalidCase === "wrong schema" ? { schema: 2 } : {}),
      ...(invalidCase === "wrong key" ? { key: "wrong-key" } : {}),
      ...(invalidCase === "wrong image name" ? { imageName: "registry.invalid/base" } : {}),
      ...(invalidCase === "non-local source" ? { source: "pinned" as const } : {}),
      ...(invalidCase === "non-null digest" ? { digest: `sha256:${"d".repeat(64)}` } : {}),
      ...(invalidCase === "noncanonical stable ref"
        ? { ref: "nemoclaw-hermes-sandbox-base-local:moved" }
        : {}),
      ...(invalidCase === "wrong image ID" ? { imageId: `sha256:${"d".repeat(64)}` } : {}),
    };
    const sourceRef = invalidCase === "noncanonical stable ref" ? metadata.ref : input.sourceRef;
    const reusedHint = invalidCase === "fresh metadata object" ? input.metadata : metadata;

    expect(
      bindLocalAgentBaseImageHandoffToResolution(
        input.agent,
        sourceRef,
        input.handoffRef,
        metadata,
        reusedHint,
      ),
    ).toBeNull();
  });

  it.each([
    "source OS mismatch",
    "source architecture mismatch",
    "source image ID mismatch",
    "handoff OS mismatch",
    "handoff architecture mismatch",
    "stale provenance",
    "missing source provenance",
    "missing handoff provenance",
    "moved handoff image",
  ])("refuses %s", (invalidCase) => {
    const input = fixture();
    installInspections(input, {
      source:
        invalidCase === "source OS mismatch"
          ? { Os: "windows" }
          : invalidCase === "source architecture mismatch"
            ? { Architecture: "arm64" }
            : invalidCase === "source image ID mismatch"
              ? { Id: `sha256:${"d".repeat(64)}` }
              : undefined,
      handoff:
        invalidCase === "handoff OS mismatch"
          ? { Os: "windows" }
          : invalidCase === "handoff architecture mismatch"
            ? { Architecture: "arm64" }
            : invalidCase === "moved handoff image"
              ? { Id: `sha256:${"d".repeat(64)}` }
              : undefined,
      sourceProvenance:
        invalidCase === "stale provenance"
          ? `${"d".repeat(64)}.${"c".repeat(64)}`
          : invalidCase === "missing source provenance"
            ? null
            : undefined,
      handoffProvenance: invalidCase === "missing handoff provenance" ? null : undefined,
    });

    expect(
      bindLocalAgentBaseImageHandoffToResolution(
        input.agent,
        input.sourceRef,
        input.handoffRef,
        input.metadata,
        input.metadata,
      ),
    ).toBeNull();
  });
});
