// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  deriveTemplateFingerprint,
  parseSemanticTemplateContract,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/derive-template-fingerprint.mts";
import { semanticTemplateFingerprint } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";
import { fixturePath, readJson } from "../../helpers/nemoclaw-product-slides-fixture";

describe("NemoClaw product slide template fingerprint derivation", () => {
  it("prints the repository-runnable command form", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(
          ".agents/skills/nemoclaw-maintainer-product-slides/scripts/derive-template-fingerprint.mts",
        ),
        "--help",
      ],
      { encoding: "utf8" },
    );

    expect(output).toBe("Usage: node --import tsx derive-template-fingerprint.mts --input PATH\n");
  });

  it("derives the validator fingerprint from the exact runtime input", () => {
    const input = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;

    expect(deriveTemplateFingerprint(input)).toBe(
      "dbe2e03966fdca71a17913bb706f36c8a85dcb167ba3e1c168fa8b70e4a17056",
    );
    expect(deriveTemplateFingerprint(input)).toBe(semanticTemplateFingerprint(input as never));
  });

  it("excludes only the declared nonsemantic top-level fields", () => {
    const input = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;
    const changedNonsemanticFields = {
      ...input,
      comments: ["different runtime comment"],
      revision: "different-runtime-revision",
      unrelatedSlides: ["different unrelated slide"],
    };
    const slideSize = input.slideSize as Record<string, unknown>;
    const changedSemanticField = {
      ...input,
      slideSize: {
        ...slideSize,
        widthEmu: Number(slideSize.widthEmu) + 1,
      },
    };

    expect(deriveTemplateFingerprint(changedNonsemanticFields)).toBe(
      deriveTemplateFingerprint(input),
    );
    expect(deriveTemplateFingerprint(changedSemanticField)).not.toBe(
      deriveTemplateFingerprint(input),
    );
    expect(() => deriveTemplateFingerprint({ ...input, undeclaredField: true })).toThrow(
      /unknown top-level fields/u,
    );
  });

  it("treats only the three declared runtime fields as nonsemantic", () => {
    const baseline = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;
    const unrelated = readJson(fixturePath("template", "unrelated-slide-added.json")) as Record<
      string,
      unknown
    >;
    const changedObjectType = readJson(
      fixturePath("template", "changed-object-type.json"),
    ) as Record<string, unknown>;

    expect(deriveTemplateFingerprint(unrelated)).toBe(deriveTemplateFingerprint(baseline));
    expect(deriveTemplateFingerprint(changedObjectType)).not.toBe(
      deriveTemplateFingerprint(baseline),
    );
  });

  it("rejects unknown nested fields and invalid nested types", () => {
    const baseline = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;
    const unknownNested = structuredClone(baseline);
    const slideSize = unknownNested.slideSize as Record<string, unknown>;
    slideSize.unit = "EMU";
    const invalidNestedType = structuredClone(baseline);
    const fontRoles = invalidNestedType.fontRoles as Record<string, unknown>;
    const roles = fontRoles.roles as Array<Record<string, unknown>>;
    roles[0].weight = "regular";

    expect(() => parseSemanticTemplateContract(unknownNested)).toThrow(
      /slideSize must contain exactly/u,
    );
    expect(() => parseSemanticTemplateContract(invalidNestedType)).toThrow(
      /fontRoles\.roles\[0\]\.weight must be a finite number/u,
    );
  });

  it("rejects nondeterministic semantic order", () => {
    const baseline = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;
    const misordered = structuredClone(baseline);
    const layouts = misordered.layouts as unknown[];
    [layouts[0], layouts[1]] = [layouts[1], layouts[0]];

    expect(() => parseSemanticTemplateContract(misordered)).toThrow(
      /layouts must have unique entries in semantic-role order/u,
    );
  });

  it("rejects missing and inconsistent master and layout references", () => {
    const baseline = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;
    const missingLayout = structuredClone(baseline);
    const missingLayoutRoles = missingLayout.roles as Record<string, Record<string, unknown>>;
    missingLayoutRoles.markitecture.layoutRole = "layout.missing";
    const inconsistentMaster = structuredClone(baseline);
    const inconsistentMasterRoles = inconsistentMaster.roles as Record<
      string,
      Record<string, unknown>
    >;
    inconsistentMasterRoles.markitecture.masterRole = "master.missing";

    expect(() => parseSemanticTemplateContract(missingLayout)).toThrow(
      /roles\.markitecture\.layoutRole must reference layouts\.semanticRole/u,
    );
    expect(() => parseSemanticTemplateContract(inconsistentMaster)).toThrow(
      /roles\.markitecture\.masterRole must reference masters\.semanticRole/u,
    );
  });

  it("rejects an incomplete semantic input", () => {
    const input = readJson(fixturePath("template", "baseline.json")) as Record<string, unknown>;
    const { roles: _roles, ...incomplete } = input;

    expect(() => deriveTemplateFingerprint(incomplete)).toThrow(/missing required fields: roles/u);
  });
});
