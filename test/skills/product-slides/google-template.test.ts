// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const skillDirectory = path.resolve(".agents/skills/nemoclaw-maintainer-product-slides");
const templateContractPath = path.join(skillDirectory, "references", "google-template.json");

type GoogleTemplateContract = {
  schemaVersion: number;
  presentationId: string;
  presentationUrl: string;
  title: string;
  requiredAccess: string;
  requiredCapabilities: string[];
  slideSize: { widthEmu: number; heightEmu: number };
  copyPolicy: {
    requireFreshCopy: boolean;
    honorUserDestinationFolder: boolean;
    defaultParentFolder: string;
    requiredGeneralAccess: string;
    addSharingPermissions: boolean;
    defaultOwner: string;
    sharedDriveOwner: string;
    sourceWriteAllowed: boolean;
  };
  slides: Array<{
    semanticRole: string;
    objectId: string;
    managedObjects?: {
      nativeTableObjectId: string;
      topRowIndex: number;
      topRowMustBeBlank: boolean;
      milestoneTargets: Array<{
        objectId: string;
        shapeType: string;
        tableColumnIndex: number;
      }>;
    };
  }>;
};

function readTemplateContract(): GoogleTemplateContract {
  return JSON.parse(fs.readFileSync(templateContractPath, "utf8")) as GoogleTemplateContract;
}

describe("NemoClaw public Google Slides template contract", () => {
  it("selects the approved public deck as the default", () => {
    const contract = readTemplateContract();

    expect(contract).toMatchObject({
      schemaVersion: 1,
      presentationId: "1wnVoqkjV_KTGwLkm6fFGnIGJ1-1YKfpOAg4HIqrXvBk",
      presentationUrl:
        "https://docs.google.com/presentation/d/1wnVoqkjV_KTGwLkm6fFGnIGJ1-1YKfpOAg4HIqrXvBk/edit",
      title: "[Public] NemoClaw Product Slides Template",
      requiredAccess: "anyone-with-link-viewer",
      requiredCapabilities: ["view", "copy", "download"],
      slideSize: { widthEmu: 36576000, heightEmu: 20574000 },
      copyPolicy: {
        requireFreshCopy: true,
        honorUserDestinationFolder: true,
        defaultParentFolder: "root",
        requiredGeneralAccess: "restricted",
        addSharingPermissions: false,
        defaultOwner: "invoking-user",
        sharedDriveOwner: "shared-drive",
        sourceWriteAllowed: false,
      },
    });
  });

  it("binds each reusable role to the inspected public exemplar", () => {
    const contract = readTemplateContract();

    expect(
      contract.slides.map(({ semanticRole, objectId }) => ({ semanticRole, objectId })),
    ).toEqual([
      { semanticRole: "title", objectId: "nemoclaw_whiteboard_title" },
      { semanticRole: "roadmap-executive", objectId: "nemoclaw_exec_roadmap_final" },
      {
        semanticRole: "roadmap-capability",
        objectId: "nemoclaw_matrix_reference_taxonomy",
      },
      { semanticRole: "markitecture", objectId: "nemoclaw_markitecture_public" },
      { semanticRole: "weekly-release", objectId: "nemoclaw_weekly_scorecard_combined" },
    ]);
    expect(new Set(contract.slides.map((slide) => slide.objectId)).size).toBe(
      contract.slides.length,
    );
  });

  it("pins the slide 3 native table and top-row milestone targets", () => {
    const contract = readTemplateContract();
    const capability = contract.slides.find((slide) => slide.semanticRole === "roadmap-capability");

    expect(capability?.managedObjects).toEqual({
      nativeTableObjectId: "nemoclaw_matrix_reference_table",
      topRowIndex: 0,
      topRowMustBeBlank: true,
      milestoneTargets: [
        {
          objectId: "nemoclaw_matrix_reference_q3",
          shapeType: "HOME_PLATE",
          tableColumnIndex: 1,
        },
        {
          objectId: "nemoclaw_matrix_reference_berlin",
          shapeType: "HOME_PLATE",
          tableColumnIndex: 2,
        },
        {
          objectId: "nemoclaw_matrix_reference_q4",
          shapeType: "HOME_PLATE",
          tableColumnIndex: 3,
        },
      ],
    });
    expect(
      new Set(capability?.managedObjects?.milestoneTargets.map((target) => target.objectId)).size,
    ).toBe(3);
  });

  it("routes the skill through the checked-in public template contract", () => {
    const skill = fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toContain("references/google-template.json");
  });
});
