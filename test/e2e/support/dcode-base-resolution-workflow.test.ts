// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  managedPublisher,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow.ts";

function prBuilder() {
  return required(
    readWorkflow("managed-images.yaml").jobs?.["pr-build-and-entrypoint"],
    "managed-image workflow is missing its PR builder",
  );
}

describe("Deep Agents Code base-resolution publication boundary (#9386)", () => {
  it("carries the exact PR base authority through every final-image path", () => {
    const publisher = prBuilder();
    const resolver = step(publisher, "Resolve exact linux/amd64 PR base");
    const exporter = step(publisher, "Export immutable Deep Agents Code base resolution labels");
    const localBuild = step(publisher, "Build PR managed image from local base");
    const registryBuild = step(publisher, "Build PR managed image from registry base");
    const localContract = step(publisher, "Validate exact PR managed image contract");
    const publishedContract = step(publisher, "Export exact published PR managed-image contract");

    expect(resolver.run).toContain("identity_ref=%s@%s");
    expect(resolver.run).toContain("source_revision=%s");
    expect(exporter.if).toBe("matrix.agent == 'langchain-deepagents-code'");
    expect(exporter.run).toContain("export-dcode-base-resolution-label.mts");
    expect(exporter.run).toContain('--reference "$BASE_IDENTITY_REFERENCE"');
    expect(exporter.run).toContain('--local-oci-receipt "$BASE_LOCAL_OCI_RECEIPT"');
    expect(localBuild.run).toContain("com.nvidia.nemoclaw.base-resolution-key");
    expect(localBuild.run).toContain("com.nvidia.nemoclaw.base-resolution");
    expect(String(registryBuild.with?.labels)).toContain("com.nvidia.nemoclaw.base-resolution-key");
    expect(String(registryBuild.with?.labels)).toContain("com.nvidia.nemoclaw.base-resolution");
    expect(localContract.run).toContain("lost immutable base resolution metadata");
    expect(publishedContract.run).toContain(
      "published Deep Agents Code image lost immutable base resolution metadata",
    );
  });

  it("carries contract-owned authority into exact production platform images", () => {
    const publisher = managedPublisher(readWorkflow("managed-images.yaml"));
    const node = step(publisher, "Set up Node.js");
    const contract = step(publisher, "Validate exact base image contract");
    const exporter = step(publisher, "Export immutable Deep Agents Code base resolution labels");
    const build = step(publisher, "Build and push managed image by digest");
    const validation = step(publisher, "Validate exact managed image before promotion");

    expect(node.with?.["node-version"]).toBe("22.19.0");
    expect(contract.run).toContain("source_revision=");
    expect(exporter.if).toBe("matrix.agent == 'langchain-deepagents-code'");
    expect(exporter.run).toContain('--reference "$BASE_REFERENCE"');
    expect(exporter.run).toContain('--expected-source-revision "$BASE_SOURCE_REVISION"');
    expect(String(build.with?.labels)).toContain("com.nvidia.nemoclaw.base-resolution-key");
    expect(String(build.with?.labels)).toContain("com.nvidia.nemoclaw.base-resolution");
    expect(validation.run).toContain(
      "Deep Agents Code image lost immutable base resolution metadata",
    );
  });
});
