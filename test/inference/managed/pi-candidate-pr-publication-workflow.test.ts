// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

describe("Pi candidate pull-request publication", () => {
  it("publishes same-repository candidates by digest without entering the release cohort", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const candidate = required(
      workflow.jobs?.["pi-candidate"],
      "managed-image workflow is missing its same-repository PR Pi candidate publisher",
    );
    const production = required(
      workflow.jobs?.["pi-candidate-publish"],
      "managed-image workflow is missing its main and tag Pi candidate publisher",
    );
    const sourceRevision =
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
    const steps = candidate.steps ?? [];
    const login = step(candidate, "Log in to GHCR");
    const publish = step(candidate, "Publish the Pi candidate image by digest");
    const logout = step(candidate, "Remove Pi publication credentials");
    const validate = step(candidate, "Validate the published Pi candidate digest");
    const exercise = step(candidate, "Exercise the Pi candidate through its declared entrypoint");
    const record = step(candidate, "Record the exact Pi candidate contract");
    const upload = step(candidate, "Upload the exact Pi candidate contract");

    expect(candidate.if).toBe(
      "github.repository == 'NVIDIA/NemoClaw' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(candidate.permissions).toEqual({ contents: "read", packages: "write" });
    expect(candidate.env?.SOURCE_REVISION).toBe(sourceRevision);
    expect(candidate.env?.LOCAL_BASE_REFERENCE).toBe(
      `nemoclaw-managed-candidate/pi-base:${sourceRevision}`,
    );
    expect(step(candidate, "Checkout").with).toMatchObject({
      ref: sourceRevision,
      "persist-credentials": false,
    });
    expect(step(candidate, "Build the Pi candidate managed image").with).toMatchObject({
      tags: "nemoclaw-managed-candidate/pi:${{ env.SOURCE_REVISION }}",
      push: false,
      load: true,
    });
    expect(login.if).toBeUndefined();
    expect(publish.if).toBeUndefined();
    expect(publish.with).toMatchObject({
      outputs:
        "type=image,name=ghcr.io/nvidia/nemoclaw/pi-sandbox,push-by-digest=true,name-canonical=true,push=true",
      platforms: "${{ matrix.platform }}",
      provenance: false,
      sbom: false,
    });
    expect(publish.with?.tags).toBeUndefined();
    expect(publish.with?.labels).toContain(
      "org.opencontainers.image.revision=${{ env.SOURCE_REVISION }}",
    );
    expect(logout).toMatchObject({ if: "always()", run: "docker logout ghcr.io" });
    expect(steps.indexOf(logout)).toBeGreaterThan(steps.indexOf(publish));
    expect(steps.indexOf(logout)).toBeLessThan(steps.indexOf(validate));
    expect(validate.if).toBeUndefined();
    expect(exercise.env).toEqual({ DIGEST: "${{ steps.publish.outputs.digest }}" });
    expect(exercise.run).toContain('reference="${REPOSITORY}@${DIGEST}"');
    expect(exercise.run).not.toContain("EVENT_NAME");
    expect(record.if).toBeUndefined();
    expect(record.run).toContain('--arg revision "$SOURCE_REVISION"');
    expect(record.run).not.toContain('--arg revision "$GITHUB_SHA"');
    expect(upload.if).toBeUndefined();
    expect(upload.with).toMatchObject({
      name: "managed-candidate-contract-${{ github.run_id }}-${{ github.run_attempt }}-pi-${{ matrix.arch }}",
      "if-no-files-found": "error",
      "retention-days": 7,
    });
    expect(JSON.stringify(candidate)).not.toContain("managed-pr-contract-");
    expect(JSON.stringify(candidate).match(/secrets\.GITHUB_TOKEN/gu)).toHaveLength(1);
    expect(production.if).toBe(
      "github.repository == 'NVIDIA/NemoClaw' && github.event_name != 'pull_request'",
    );
    expect(production.permissions).toEqual({ contents: "read", packages: "write" });
  });
});
