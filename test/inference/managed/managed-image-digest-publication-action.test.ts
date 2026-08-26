// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  managedPromoter,
  managedPublisher,
  readAction,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

describe("managed-image digest publication action", () => {
  it("keeps digest publication in one focused action and out of the Pi PR lane", () => {
    const managedWorkflow = readWorkflow("managed-images.yaml");
    const action = readAction("publish-managed-image-digest");
    const actionInputs = Object.keys(action.inputs ?? {});
    const actionSource = JSON.stringify(action);
    const actionValidation = step(
      { steps: action.runs?.steps },
      "Validate published exact digest",
      "managed-image publication action",
    );
    const prCandidate = required(managedWorkflow.jobs?.["pi-candidate"], "missing Pi PR candidate");
    const publisher = required(
      managedWorkflow.jobs?.["pi-candidate-publish"],
      "missing Pi candidate publisher",
    );
    const production = managedPublisher(managedWorkflow);
    const piPublication = step(publisher, "Publish and validate the Pi candidate image by digest");
    const productionPublication = step(production, "Publish and validate managed image by digest");

    expect(actionInputs).toHaveLength(12);
    expect(actionInputs.length).toBeLessThanOrEqual(14);
    expect(actionSource).toContain("push-by-digest=true,name-canonical=true,push=true");
    expect(actionValidation.run).toContain('imagetools inspect "$reference" --raw');
    expect(actionValidation.run).toContain('DOCKER_CONFIG="$anonymous_config" docker pull');
    expect(piPublication.uses).toBe("./.github/actions/publish-managed-image-digest");
    expect(piPublication.with?.["build-contexts"]).toContain("nemoclaw-pi-base=oci-layout://");
    expect(piPublication.with?.provenance).toBe(false);
    expect(piPublication.with?.sbom).toBe(false);
    expect(productionPublication.uses).toBe("./.github/actions/publish-managed-image-digest");
    expect(prCandidate.permissions).toEqual({ contents: "read" });
    const prPublication = step(
      prCandidate,
      "Publish and validate the Pi candidate image by digest",
    );
    expect(prPublication.if).toBe("github.event_name != 'pull_request'");
    expect(publisher.permissions).toEqual({ contents: "read", packages: "write" });
    expect(publisher.needs).toBeUndefined();
    expect(managedPromoter(managedWorkflow).needs).toEqual([
      "publication-identity",
      "build-and-validate",
    ]);
  });
});
