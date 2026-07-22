// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types";
import {
  buildRebuildHermesChildEnv,
  planRebuildHermesBaseReuse,
} from "../live/rebuild-hermes-env.ts";

const digest = "a".repeat(64);
const pinnedRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${digest}`;
const preparedRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";

function metadata(
  overrides: Partial<SandboxBaseImageResolutionMetadata> = {},
): SandboxBaseImageResolutionMetadata {
  return {
    schema: 1,
    key: "fixture-key",
    imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
    ref: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"b".repeat(64)}`,
    digest: `sha256:${"b".repeat(64)}`,
    source: "pinned",
    pinnedRemoteRef: pinnedRef,
    imageId: `sha256:${"c".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.41",
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
    ...overrides,
  };
}

describe("rebuild-Hermes base reuse", () => {
  it("retags the immutable pinned base selected during normal setup (#7144)", () => {
    const selected = metadata();

    expect(planRebuildHermesBaseReuse(false, selected, preparedRef)).toEqual({
      sourceRef: selected.ref,
      preparedRef,
      childEnv: { NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: preparedRef },
    });
  });

  it("retags the repository-built local base selected during normal setup (#7144)", () => {
    const localRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";

    expect(
      planRebuildHermesBaseReuse(
        false,
        metadata({ source: "local", ref: localRef, digest: null, pinnedRemoteRef: undefined }),
        preparedRef,
      ),
    ).toEqual({
      sourceRef: localRef,
      preparedRef,
      childEnv: { NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: preparedRef },
    });
  });

  it("fails closed when normal setup lacks a trusted reusable base (#7144)", () => {
    expect(() => planRebuildHermesBaseReuse(false, null, preparedRef)).toThrow(
      "did not record base-image resolution metadata",
    );
    expect(() =>
      planRebuildHermesBaseReuse(false, metadata({ source: "latest" }), preparedRef),
    ).toThrow("unsupported base-image source 'latest'");
    expect(() => planRebuildHermesBaseReuse(false, metadata(), "latest")).toThrow(
      "requires a test-owned local base-image ref",
    );
  });

  it("leaves stale-base rebuilds unoverridden (#7144)", () => {
    expect(planRebuildHermesBaseReuse(true, metadata(), preparedRef)).toBeNull();
    expect(planRebuildHermesBaseReuse(true, null, preparedRef)).toBeNull();
  });

  it("forwards only supported OpenShell compatibility inputs (#7144)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        BUILDX_BUILDER: "external-builder",
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
        NVIDIA_API_KEY: "must-not-reach-child",
      },
      {},
    );

    expect(childEnv.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL).toBe("1");
    expect(childEnv.NEMOCLAW_OPENSHELL_CHANNEL).toBe("dev");
    expect(childEnv.NVIDIA_API_KEY).toBeUndefined();
    expect(childEnv.BUILDX_BUILDER).toBeUndefined();
  });
});
