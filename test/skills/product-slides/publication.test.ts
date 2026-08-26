// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPptx,
  finalizePptxArtifacts,
  freezePptxArtifactInput,
  hyperlinkInventoryFromSlideXml,
  stagePowerPointBlob,
  validatePptxFilesystemIsolation,
  validatePptxModel,
  validatePptxParityReceipt,
  validatePptxPublicationFiles,
  validatePptxPublicationInputs,
  validatePptxPublicationSourceModel,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts";
import { compareParity } from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/compare-output-parity.mts";
import {
  calculateModelSha256,
  canonicalSha256,
  classifyTemplateDrift,
  planManagedSlideRefresh,
  validatePublicationBinding,
  withoutTopLevelKey,
} from "../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";
import {
  buildSyntheticModel,
  fixturePath,
  readJson,
  semanticReadback,
  slideModelSchemaPath,
  syntheticFixtureInputs,
  verifiedDocumentationFixture,
} from "../../helpers/nemoclaw-product-slides-fixture";

const replacements = [
  { id: "new-executive", managedRole: "roadmap-executive" as const },
  { id: "new-capability", managedRole: "roadmap-capability" as const },
  { id: "new-markitecture", managedRole: "markitecture" as const },
  { id: "new-weekly", managedRole: "weekly-release" as const },
];

const requiredPowerPointArguments: Array<[string, string]> = [
  ["--model", "model.json"],
  ["--template-pptx", "template.pptx"],
  ["--template-workspace", "template-workspace"],
  ["--template-frame-map", "template-workspace/template-frame-map.json"],
  ["--role-map", "role-map.json"],
  ["--output", "output.pptx"],
  ["--preview-dir", "preview"],
  ["--layout-dir", "layout"],
  ["--readback", "readback.json"],
];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function templateWorkflowOptions(temp: string) {
  const templateWorkspace = path.join(temp, "template-workspace");
  return {
    templateWorkspace,
    templateFrameMap: path.join(templateWorkspace, "template-frame-map.json"),
  };
}

function runBuildPptxCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      path.resolve(".agents/skills/nemoclaw-maintainer-product-slides/scripts/build-pptx.mts"),
      ...args,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
}

function writeParityFixture(options: {
  temp: string;
  model: Record<string, unknown>;
  previewPptxPath: string;
  previewPptxSha256: string;
  roleMapSha256: string;
  templateSha256: string;
}): {
  parityReceiptPath: string;
  parityReceiptSha256: string;
  googleReadbackPath: string;
  pptxReadbackPath: string;
} {
  const googleReadbackPath = path.join(options.temp, "google-readback.json");
  const pptxReadbackPath = path.join(options.temp, "pptx-readback.json");
  const googleReadback = {
    ...semanticReadback(options.model),
    artifact: {
      kind: "google-slides",
      id: "synthetic-google-deck",
      revisionId: "synthetic-google-revision",
    },
  };
  const pptxReadback = {
    ...semanticReadback(options.model),
    templateSha256: options.templateSha256,
    roleMapSha256: options.roleMapSha256,
    artifact: {
      kind: "pptx",
      id: options.previewPptxPath,
      revisionId: options.previewPptxSha256,
      sha256: options.previewPptxSha256,
    },
  };
  const googleBytes = JSON.stringify(googleReadback);
  const pptxBytes = JSON.stringify(pptxReadback);
  fs.writeFileSync(googleReadbackPath, googleBytes);
  fs.writeFileSync(pptxReadbackPath, pptxBytes);
  const comparison = compareParity(options.model, googleReadback, pptxReadback);
  const parityReceipt = {
    ...comparison,
    googleArtifact: {
      id: googleReadback.artifact.id,
      revisionId: googleReadback.artifact.revisionId,
      readbackPath: googleReadbackPath,
      readbackSha256: sha256(googleBytes),
    },
    pptxArtifact: {
      id: options.previewPptxPath,
      revisionId: options.previewPptxSha256,
      sha256: options.previewPptxSha256,
      readbackPath: pptxReadbackPath,
      readbackSha256: sha256(pptxBytes),
    },
  };
  const parityReceiptPath = path.join(options.temp, "parity-receipt.json");
  const parityBytes = JSON.stringify(parityReceipt);
  fs.writeFileSync(parityReceiptPath, parityBytes);
  return {
    parityReceiptPath,
    parityReceiptSha256: sha256(parityBytes),
    googleReadbackPath,
    pptxReadbackPath,
  };
}

function parityReceiptValidationFixture(temp: string) {
  const model = buildSyntheticModel();
  const previewPptxPath = path.join(temp, "reviewed-preview.pptx");
  const previewPptxSha256 = "e".repeat(64);
  const roleMapSha256 = "f".repeat(64);
  const templateSha256 = "d".repeat(64);
  const parity = writeParityFixture({
    temp,
    model,
    previewPptxPath,
    previewPptxSha256,
    roleMapSha256,
    templateSha256,
  });
  const receipt = JSON.parse(fs.readFileSync(parity.parityReceiptPath, "utf8"));
  const googleReadback = JSON.parse(fs.readFileSync(parity.googleReadbackPath, "utf8"));
  const pptxReadback = JSON.parse(fs.readFileSync(parity.pptxReadbackPath, "utf8"));
  const comparison = compareParity(model, googleReadback, pptxReadback);
  return {
    receipt,
    comparison,
    args: {
      receipt,
      comparison,
      model,
      current: {
        previewPptxPath,
        previewPptxSha256,
        roleMapSha256,
        templateSha256,
      },
      googleReadback,
      pptxReadback,
      googleReadbackPath: parity.googleReadbackPath,
      pptxReadbackPath: parity.pptxReadbackPath,
      googleReadbackSha256: sha256(fs.readFileSync(parity.googleReadbackPath)),
      pptxReadbackSha256: sha256(fs.readFileSync(parity.pptxReadbackPath)),
    },
  };
}

describe("NemoClaw product slide refresh and publication contracts", () => {
  it.each(requiredPowerPointArguments)(
    "names required PowerPoint option %s by its public flag",
    (missingFlag) => {
      const args = requiredPowerPointArguments.filter(([flag]) => flag !== missingFlag).flat();
      const result = runBuildPptxCli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${missingFlag} is required`);
    },
    30_000,
  );

  it("refreshes idempotently while preserving unrelated slide order", () => {
    const deck = [
      { id: "title" },
      { id: "unrelated-a" },
      { id: "old-executive", managedRole: "roadmap-executive" as const },
      { id: "old-capability", managedRole: "roadmap-capability" as const },
      { id: "old-markitecture", managedRole: "markitecture" as const },
      { id: "old-weekly", managedRole: "weekly-release" as const },
      { id: "unrelated-b" },
    ];
    const first = planManagedSlideRefresh({
      slides: deck,
      replacements,
      insertionIndex: 1,
    });
    const second = planManagedSlideRefresh({
      slides: first,
      replacements,
      insertionIndex: 1,
    });

    expect(second).toEqual(first);
    expect(first.map((slide) => slide.id)).toEqual([
      "title",
      "new-executive",
      "new-capability",
      "new-markitecture",
      "new-weekly",
      "unrelated-a",
      "unrelated-b",
    ]);
  });

  it("rejects a deck with duplicate singleton managed roles", () => {
    expect(() =>
      planManagedSlideRefresh({
        slides: [
          { id: "one", managedRole: "weekly-release" },
          { id: "two", managedRole: "weekly-release" },
        ],
        replacements,
        insertionIndex: 1,
      }),
    ).toThrow(/Duplicate managed slide role/u);
  });

  it("rejects an unknown future managed role instead of deleting it", () => {
    expect(() =>
      planManagedSlideRefresh({
        slides: [{ id: "future", managedRole: "future-role" as never }],
        replacements,
        insertionIndex: 1,
      }),
    ).toThrow(/Unknown managed slide role/u);
  });

  it("requires approval bound to the exact target revision and evidence", () => {
    const current = {
      targetId: "synthetic-target",
      targetRevision: "revision-2",
      snapshotSha256: "a".repeat(64),
      modelSha256: "b".repeat(64),
      templateFingerprint: "c".repeat(64),
    };
    expect(validatePublicationBinding(null, current)[0].code).toBe("PUBLICATION_APPROVAL_MISSING");
    expect(validatePublicationBinding(current, current)).toEqual([]);
    expect(
      validatePublicationBinding({ ...current, targetRevision: "revision-1" }, current)[0],
    ).toMatchObject({ code: "PUBLICATION_BINDING_STALE" });
  });

  it("classifies unrelated changes as immaterial and native-object drift as material", () => {
    const baseline = readJson<Record<string, unknown>>(fixturePath("template", "baseline.json"));
    const unrelated = readJson<Record<string, unknown>>(
      fixturePath("template", "unrelated-slide-added.json"),
    );
    const changed = readJson<Record<string, unknown>>(
      fixturePath("template", "changed-object-type.json"),
    );

    expect(classifyTemplateDrift(baseline as never, unrelated as never).material).toBe(false);
    expect(classifyTemplateDrift(baseline as never, changed as never).material).toBe(true);
  });

  it("connects PowerPoint publication to approval and reviewed validation evidence", () => {
    const current = {
      targetId: "/tmp/reviewed-output.pptx",
      outputPath: "/tmp/reviewed-output.pptx",
      targetRevision: "absent",
      snapshotSha256: "a".repeat(64),
      modelSha256: "b".repeat(64),
      templateFingerprint: "c".repeat(64),
      templateSha256: "d".repeat(64),
      roleMapSha256: "f".repeat(64),
      previewPptxPath: "/tmp/reviewed-preview.pptx",
      previewPptxSha256: "e".repeat(64),
      parityReceiptPath: "/tmp/parity-receipt.json",
      parityReceiptSha256: "1".repeat(64),
    };
    const evidence = {
      schemaVersion: 1,
      snapshotSha256: current.snapshotSha256,
      modelSha256: current.modelSha256,
      templateFingerprint: current.templateFingerprint,
      templateSha256: current.templateSha256,
      roleMapSha256: current.roleMapSha256,
      previewPptxPath: current.previewPptxPath,
      previewPptxSha256: current.previewPptxSha256,
      outputPath: current.outputPath,
      parityReceiptPath: current.parityReceiptPath,
      parityReceiptSha256: current.parityReceiptSha256,
      inspectedRoles: replacements.map((slide) => slide.managedRole),
      fullSizeVisualReview: true,
      nativeEditability: true,
      notesAndLinksMatch: true,
      crossFormatParity: true,
      overflow: false,
      clipping: false,
      fontSubstitution: false,
      staleText: false,
    };
    const approval = {
      targetId: current.targetId,
      targetRevision: current.targetRevision,
      snapshotSha256: current.snapshotSha256,
      modelSha256: current.modelSha256,
      templateFingerprint: current.templateFingerprint,
      roleMapSha256: current.roleMapSha256,
      parityReceiptSha256: current.parityReceiptSha256,
    };

    expect(() => validatePptxPublicationInputs({ approval, evidence, current })).not.toThrow();
    expect(() =>
      validatePptxPublicationInputs({
        approval,
        evidence: { ...evidence, templateSha256: "f".repeat(64) },
        current,
      }),
    ).toThrow(/templateSha256/u);
    expect(() =>
      validatePptxPublicationInputs({
        approval,
        evidence: { ...evidence, previewPptxSha256: "0".repeat(64) },
        current,
      }),
    ).toThrow(/previewPptxSha256/u);
    expect(() =>
      validatePptxPublicationInputs({
        approval,
        evidence: { ...evidence, outputPath: "/tmp/other-output.pptx" },
        current,
      }),
    ).toThrow(/outputPath/u);
    expect(() =>
      validatePptxPublicationInputs({
        approval: { ...approval, roleMapSha256: "0".repeat(64) },
        evidence,
        current,
      }),
    ).toThrow(/roleMapSha256/u);
    expect(() =>
      validatePptxPublicationInputs({
        approval,
        evidence: { ...evidence, crossFormatParity: false },
        current,
      }),
    ).toThrow(/crossFormatParity/u);
  });

  it("reads native PowerPoint run hyperlinks with exact coalescing and multiplicity", () => {
    const relationships = `
      <Relationships>
        <Relationship Id="rId1" Target="https://example.com/one?x=1&amp;y=2" />
        <Relationship Id="rId2" Target="https://example.com/two" />
      </Relationships>`;
    const linkedRun = (text: string, relationshipId: string) =>
      `<a:r><a:rPr><a:hlinkClick r:id="${relationshipId}"/></a:rPr><a:t>${text}</a:t></a:r>`;
    const unlinkedRun = (text: string) => `<a:r><a:t>${text}</a:t></a:r>`;
    const slideXml = `
      <p:sld><p:cSld><p:spTree>
        <a:p>${linkedRun("Alpha ", "rId1")}${linkedRun("beta", "rId1")}</a:p>
        <a:p>${linkedRun("Alpha ", "rId1")}${linkedRun("beta", "rId1")}</a:p>
        <a:p>${linkedRun("Gamma", "rId2")}${unlinkedRun(" break ")}${linkedRun("delta&#10;", "rId2")}</a:p>
      </p:spTree></p:cSld></p:sld>`;

    expect(hyperlinkInventoryFromSlideXml(slideXml, relationships)).toEqual([
      { text: "Alpha beta", url: "https://example.com/one?x=1&y=2" },
      { text: "Alpha beta", url: "https://example.com/one?x=1&y=2" },
      { text: "Gamma", url: "https://example.com/two" },
      { text: "delta", url: "https://example.com/two" },
    ]);
    expect(() =>
      hyperlinkInventoryFromSlideXml(
        `<a:p>${linkedRun("Broken", "rId-missing")}</a:p>`,
        relationships,
      ),
    ).toThrow(/unresolved hyperlink relationship/u);
  });

  it.each([
    "expectedHyperlinkSha256",
    "googleHyperlinkSha256",
    "pptxHyperlinkSha256",
    "expectedConnectorSha256",
    "googleConnectorSha256",
    "pptxConnectorSha256",
  ])("rejects publication parity evidence with stale %s", (key) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-link-receipt-"));
    try {
      const { args, receipt } = parityReceiptValidationFixture(temp);
      expect(() => validatePptxParityReceipt(args)).not.toThrow();
      expect(() =>
        validatePptxParityReceipt({
          ...args,
          receipt: { ...receipt, [key]: "0".repeat(64) },
        }),
      ).toThrow(new RegExp(key, "u"));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each([
    ["hyperlink", "pptxHyperlinkSha256"],
    ["connector", "pptxConnectorSha256"],
  ] as const)("rejects publication when current %s hashes are unequal", (_case, key) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-link-equality-"));
    try {
      const { args, comparison, receipt } = parityReceiptValidationFixture(temp);
      const forgedComparison = {
        ...comparison,
        equal: true,
        errors: [],
        [key]: "0".repeat(64),
      };
      expect(() =>
        validatePptxParityReceipt({
          ...args,
          comparison: forgedComparison,
          receipt: {
            ...receipt,
            [key]: forgedComparison[key],
          },
        }),
      ).toThrow(/parity hashes are not equal/u);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects fabricated preview bytes and matching fabricated readbacks", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-publish-"));
    try {
      const model = buildSyntheticModel();
      const previewPptxPath = path.join(temp, "reviewed-preview.pptx");
      const outputPath = path.join(temp, "published-output.pptx");
      const approvalPath = path.join(temp, "approval.json");
      const evidencePath = path.join(temp, "evidence.json");
      const previewBytes = Buffer.from("reviewed preview artifact");
      const previewPptxSha256 = sha256(previewBytes);
      const roleMapSha256 = "f".repeat(64);
      const templateSha256 = "d".repeat(64);
      fs.writeFileSync(previewPptxPath, previewBytes);
      const parity = writeParityFixture({
        temp,
        model,
        previewPptxPath,
        previewPptxSha256,
        roleMapSha256,
        templateSha256,
      });
      const current = {
        targetRevision: "absent",
        snapshotSha256: model.snapshotSha256,
        modelSha256: model.modelSha256,
        templateFingerprint: model.templateFingerprint,
        templateSha256,
        roleMapSha256,
      };
      const evidence = {
        schemaVersion: 1,
        ...current,
        outputPath,
        previewPptxPath,
        previewPptxSha256,
        parityReceiptPath: parity.parityReceiptPath,
        parityReceiptSha256: parity.parityReceiptSha256,
        inspectedRoles: replacements.map((slide) => slide.managedRole),
        fullSizeVisualReview: true,
        nativeEditability: true,
        notesAndLinksMatch: true,
        crossFormatParity: true,
        overflow: false,
        clipping: false,
        fontSubstitution: false,
        staleText: false,
      };
      fs.writeFileSync(
        approvalPath,
        JSON.stringify({
          targetId: outputPath,
          targetRevision: current.targetRevision,
          snapshotSha256: current.snapshotSha256,
          modelSha256: current.modelSha256,
          templateFingerprint: current.templateFingerprint,
          roleMapSha256,
          parityReceiptSha256: parity.parityReceiptSha256,
        }),
      );
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));

      await expect(
        validatePptxPublicationFiles({
          approvalPath,
          evidencePath,
          parityEvidencePath: parity.parityReceiptPath,
          reviewedPreviewPptxPath: previewPptxPath,
          outputPath,
          current,
          model,
          protectedTextSha256ByRole: {},
        }),
      ).rejects.toThrow(/artifact-derived verification/u);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("enforces the canonical slide-model schema in the PowerPoint entrypoint", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-schema-"));
    try {
      const model = buildSyntheticModel();
      const capability = (model.slides as Array<Record<string, unknown>>)[1];
      const firstColumn = (capability.columns as Array<Record<string, unknown>>)[0];
      firstColumn.focus = "x".repeat(81);
      model.modelSha256 = calculateModelSha256(model);
      const modelPath = path.join(temp, "model.json");
      const roleMapPath = path.join(temp, "role-map.json");
      const templatePath = path.join(temp, "template.pptx");
      fs.writeFileSync(modelPath, JSON.stringify(model));
      fs.writeFileSync(roleMapPath, "{}");
      fs.writeFileSync(templatePath, "not reached");

      await expect(
        buildPptx({
          model: modelPath,
          roleMap: roleMapPath,
          template: templatePath,
          ...templateWorkflowOptions(temp),
          output: path.join(temp, "output.pptx"),
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "preview",
        }),
      ).rejects.toThrow(/schema validation failed.*maxLength/u);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("requires every frozen model source for PowerPoint publication", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-publish-sources-"));
    try {
      const model = buildSyntheticModel();
      const templatePath = path.join(temp, "template.pptx");
      const roleMapPath = path.join(temp, "role-map.json");
      const templateBytes = Buffer.from("not reached");
      fs.writeFileSync(templatePath, templateBytes);
      fs.writeFileSync(
        roleMapPath,
        JSON.stringify({
          schemaVersion: 1,
          templateFingerprint: model.templateFingerprint,
          templateSha256: sha256(templateBytes),
          roles: Object.fromEntries(
            replacements.map(({ managedRole }) => [
              managedRole,
              {
                preArchive: true,
                ...(managedRole === "weekly-release"
                  ? {
                      milestoneRowOperations: [0, 1, 2].flatMap((rowIndex) =>
                        ["label", "updates", "risks"].map((kind) => ({
                          target: { name: `weekly-${rowIndex}-${kind}` },
                          rowIndex,
                          kind,
                          ...(kind === "label"
                            ? {
                                placement: "left",
                                fillColor: "#76B900",
                                textStyle: { color: "#FFFFFF", bold: true },
                                paragraphStyle: { bulletCharacter: "" },
                              }
                            : {
                                nativeBullets: true,
                                paragraphStyle: { bulletCharacter: "•" },
                              }),
                        })),
                      ),
                    }
                  : {}),
              },
            ]),
          ),
        }),
      );
      const modelPath = path.join(temp, "model.json");
      fs.writeFileSync(modelPath, JSON.stringify(model));

      await expect(
        buildPptx({
          model: modelPath,
          roleMap: roleMapPath,
          template: templatePath,
          ...templateWorkflowOptions(temp),
          output: path.join(temp, "output.pptx"),
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "publish",
          approval: path.join(temp, "approval.json"),
          validationEvidence: path.join(temp, "validation.json"),
          parityEvidence: path.join(temp, "parity.json"),
          reviewedPreviewPptx: path.join(temp, "preview.pptx"),
        }),
      ).rejects.toThrow(/--snapshot, --docs, --presentation-map, --claims, and --narrative-input/u);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a self-rehashed model whose source-only blockers were erased", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-source-rebuild-"));
    try {
      const inputs = syntheticFixtureInputs();
      const documentation = verifiedDocumentationFixture();
      const docs = documentation.evidence;
      const claimsPath = path.resolve(
        ".agents/skills/nemoclaw-maintainer-product-slides/references/markitecture-claims.json",
      );
      const paths = {
        repoRoot: documentation.repoRoot,
        snapshotPath: path.join(temp, "snapshot.json"),
        docsPath: path.join(temp, "docs.json"),
        presentationMapPath: path.join(temp, "presentation-map.json"),
        claimsPath,
        narrativeInputPath: path.join(temp, "narrative.json"),
      };
      fs.writeFileSync(paths.snapshotPath, JSON.stringify(inputs.snapshot));
      fs.writeFileSync(paths.docsPath, JSON.stringify(docs));
      fs.writeFileSync(paths.presentationMapPath, JSON.stringify(inputs.presentation));
      fs.writeFileSync(paths.narrativeInputPath, JSON.stringify(inputs.narrative));

      const exactModel = buildSyntheticModel({
        snapshot: inputs.snapshot,
        presentation: inputs.presentation,
        narrative: inputs.narrative,
      });
      await expect(
        validatePptxPublicationSourceModel({ model: exactModel, ...paths }),
      ).resolves.toEqual(exactModel);

      const blockedSnapshot = structuredClone(inputs.snapshot);
      (blockedSnapshot.findings as Array<Record<string, unknown>>).push({
        code: "WORK_TRACKING_REFERENCE_INVALID",
        message: "Synthetic unresolved source reference.",
        remediation: "Resolve the exact source reference.",
        role: "roadmap-executive",
      });
      blockedSnapshot.snapshotSha256 = canonicalSha256(
        withoutTopLevelKey(blockedSnapshot, "snapshotSha256"),
      );
      const blockedModel = buildSyntheticModel({
        snapshot: blockedSnapshot,
        presentation: inputs.presentation,
        narrative: inputs.narrative,
      });
      fs.writeFileSync(paths.snapshotPath, JSON.stringify(blockedSnapshot));
      expect((blockedModel.publication as Record<string, unknown>).eligible).toBe(false);

      const forgedModel = structuredClone(blockedModel);
      forgedModel.publication = { eligible: true, blockers: [], findings: [] };
      const blockedModelSha256 = String(blockedModel.modelSha256);
      forgedModel.modelSha256 = calculateModelSha256(forgedModel);
      forgedModel.slides = (forgedModel.slides as Array<Record<string, unknown>>).map((slide) => ({
        ...slide,
        managedNotes: String(slide.managedNotes).replace(
          blockedModelSha256,
          String(forgedModel.modelSha256),
        ),
      }));
      const schema = readJson<Record<string, unknown>>(slideModelSchemaPath);
      expect(() => validatePptxModel(forgedModel, schema, "publish")).not.toThrow();
      await expect(
        validatePptxPublicationSourceModel({ model: forgedModel, ...paths }),
      ).rejects.toThrow(/canonical model rebuilt from the exact source inputs/u);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("enforces semantic publication invariants in the PowerPoint entrypoint", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-semantic-"));
    try {
      const model = buildSyntheticModel();
      const weekly = (model.slides as Array<Record<string, unknown>>)[3];
      const row = (weekly.milestoneRows as Array<Record<string, unknown>>)[0];
      const update = (row.updates as Array<Record<string, unknown>>)[0];
      update.sourceDigest = "0".repeat(64);
      model.publication = { eligible: true, blockers: [], findings: [] };
      model.modelSha256 = calculateModelSha256(model);
      const modelPath = path.join(temp, "model.json");
      const roleMapPath = path.join(temp, "role-map.json");
      const templatePath = path.join(temp, "template.pptx");
      fs.writeFileSync(modelPath, JSON.stringify(model));
      fs.writeFileSync(roleMapPath, "{}");
      fs.writeFileSync(templatePath, "not reached");

      await expect(
        buildPptx({
          model: modelPath,
          roleMap: roleMapPath,
          template: templatePath,
          ...templateWorkflowOptions(temp),
          output: path.join(temp, "output.pptx"),
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "publish",
        }),
      ).rejects.toThrow(
        /semantic validation failed.*(?:MANAGED_NOTES_INVALID|WEEKLY_REPORT_BINDING_INVALID)/u,
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(["preview", "publish"] as const)(
    "refuses to overwrite the PowerPoint source template in %s mode",
    async (mode) => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-template-output-"));
      try {
        const templatePath = path.join(temp, "source-template.pptx");
        const sentinel = "source template sentinel";
        fs.writeFileSync(templatePath, sentinel);

        await expect(
          buildPptx({
            model: path.join(temp, "missing-model.json"),
            roleMap: path.join(temp, "missing-role-map.json"),
            template: templatePath,
            ...templateWorkflowOptions(temp),
            output: path.join(temp, ".", "source-template.pptx"),
            previewDir: path.join(temp, "preview"),
            layoutDir: path.join(temp, "layout"),
            readback: path.join(temp, "readback.json"),
            mode,
          }),
        ).rejects.toThrow(/source template and output must be different files/u);

        expect(fs.readFileSync(templatePath, "utf8")).toBe(sentinel);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("rejects a source-template collision through a symlinked parent", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-parent-alias-"));
    try {
      const sourceDirectory = path.join(temp, "source");
      const aliasDirectory = path.join(temp, "alias");
      fs.mkdirSync(sourceDirectory);
      fs.symlinkSync(sourceDirectory, aliasDirectory, "dir");
      const templatePath = path.join(sourceDirectory, "source-template.pptx");
      const sentinel = Buffer.from("source template alias sentinel");
      fs.writeFileSync(templatePath, sentinel);

      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: templatePath,
          ...templateWorkflowOptions(temp),
          output: path.join(aliasDirectory, "source-template.pptx"),
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "preview",
        }),
      ).rejects.toThrow(/source template and output must be different files/u);
      expect(fs.readFileSync(templatePath)).toEqual(sentinel);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a preexisting destination alias into the template workspace", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-workspace-alias-"));
    try {
      const templateWorkflow = templateWorkflowOptions(temp);
      const aliasDirectory = path.join(temp, "destination-alias");
      fs.mkdirSync(templateWorkflow.templateWorkspace);
      fs.symlinkSync(templateWorkflow.templateWorkspace, aliasDirectory, "dir");
      const outputPath = path.join(aliasDirectory, "generated-preview.pptx");

      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: path.join(temp, "missing-template.pptx"),
          ...templateWorkflow,
          output: outputPath,
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "preview",
        }),
      ).rejects.toThrow(/output must be outside --template-workspace/u);
      expect(
        fs.existsSync(path.join(templateWorkflow.templateWorkspace, "generated-preview.pptx")),
      ).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects output, readback, and inspection aliases before reading or writing", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-output-alias-"));
    try {
      const templatePath = path.join(temp, "source-template.pptx");
      const inspectPath = path.join(temp, "inspect-hard-link.ndjson");
      const sentinel = Buffer.from("source template inode sentinel");
      fs.writeFileSync(templatePath, sentinel);
      fs.linkSync(templatePath, inspectPath);

      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: templatePath,
          ...templateWorkflowOptions(temp),
          output: path.join(temp, "output.pptx"),
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "output.pptx"),
          inspectOutput: inspectPath,
          mode: "preview",
        }),
      ).rejects.toThrow(/output and readback output must be different files/u);

      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: templatePath,
          ...templateWorkflowOptions(temp),
          output: path.join(temp, "output.pptx"),
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          inspectOutput: inspectPath,
          mode: "preview",
        }),
      ).rejects.toThrow(/source template and inspect output must be different files/u);
      expect(fs.readFileSync(templatePath)).toEqual(sentinel);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects absent output and readback leaves that differ only by case", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-output-case-alias-"));
    try {
      const outputPath = path.join(temp, "Reviewed-Output.PPTX");
      const readbackPath = path.join(temp, "reviewed-output.pptx");
      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: path.join(temp, "missing-template.pptx"),
          ...templateWorkflowOptions(temp),
          output: outputPath,
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: readbackPath,
          mode: "preview",
        }),
      ).rejects.toThrow(/output and readback output must be different files/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.existsSync(readbackPath)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects an output path that is an ancestor of the readback path", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-output-ancestor-"));
    try {
      const outputPath = path.join(temp, "published.pptx");
      const readbackPath = path.join(outputPath, "readback.json");
      const previewDir = path.join(temp, "preview");
      const layoutDir = path.join(temp, "layout");
      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: path.join(temp, "missing-template.pptx"),
          ...templateWorkflowOptions(temp),
          output: outputPath,
          previewDir,
          layoutDir,
          readback: readbackPath,
          mode: "preview",
        }),
      ).rejects.toThrow(
        /output and readback output must not have an ancestor\/descendant file-path conflict/u,
      );
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.existsSync(previewDir)).toBe(false);
      expect(fs.existsSync(layoutDir)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects an output path that is also a generated-artifact directory", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-output-directory-alias-"));
    try {
      const outputPath = path.join(temp, "approved-output.pptx");
      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: path.join(temp, "missing-template.pptx"),
          ...templateWorkflowOptions(temp),
          output: outputPath,
          previewDir: outputPath,
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "preview",
        }),
      ).rejects.toThrow(/output and preview directory path must be different files/u);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects layout, slide-preview, and montage aliases to source inputs", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-support-alias-"));
    try {
      const templatePath = path.join(temp, "source-template.pptx");
      const roleMapPath = path.join(temp, "role-map.json");
      const modelPath = path.join(temp, "model.json");
      const layoutDir = path.join(temp, "layout");
      const previewDir = path.join(temp, "preview");
      const templateSentinel = Buffer.from("source template support sentinel");
      fs.writeFileSync(templatePath, templateSentinel);
      fs.writeFileSync(roleMapPath, "role map sentinel");
      fs.writeFileSync(modelPath, "model sentinel");
      fs.mkdirSync(layoutDir);
      fs.mkdirSync(previewDir);
      const baseOptions = {
        model: modelPath,
        roleMap: roleMapPath,
        template: templatePath,
        ...templateWorkflowOptions(temp),
        output: path.join(temp, "output.pptx"),
        previewDir,
        layoutDir,
        readback: path.join(temp, "readback.json"),
        mode: "preview" as const,
      };

      const layoutPath = path.join(layoutDir, "01-roadmap-executive.json");
      fs.linkSync(templatePath, layoutPath);
      await expect(buildPptx(baseOptions)).rejects.toThrow(
        /source template and roadmap-executive layout output must be different files/u,
      );
      fs.unlinkSync(layoutPath);

      const previewPath = path.join(previewDir, "01-roadmap-executive.png");
      fs.symlinkSync(roleMapPath, previewPath);
      await expect(buildPptx(baseOptions)).rejects.toThrow(
        /role map and roadmap-executive preview output must be different files/u,
      );
      fs.unlinkSync(previewPath);

      const montagePath = path.join(previewDir, "managed-montage.webp");
      fs.linkSync(modelPath, montagePath);
      await expect(buildPptx(baseOptions)).rejects.toThrow(
        /slide model and preview montage output must be different files/u,
      );
      expect(fs.readFileSync(templatePath)).toEqual(templateSentinel);
      expect(fs.readFileSync(roleMapPath, "utf8")).toBe("role map sentinel");
      expect(fs.readFileSync(modelPath, "utf8")).toBe("model sentinel");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("freezes reviewed preview bytes before artifact import", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-preview-freeze-"));
    let frozenDirectory = temp;
    try {
      const previewPath = path.join(temp, "reviewed-preview.pptx");
      const reviewedBytes = Buffer.from("reviewed preview version one");
      fs.writeFileSync(previewPath, reviewedBytes);
      const frozen = await freezePptxArtifactInput(previewPath);
      frozenDirectory = frozen.directory;
      fs.writeFileSync(previewPath, "unreviewed preview version two");

      expect(frozen.sourcePath).toBe(previewPath);
      expect(frozen.sha256).toBe(sha256(reviewedBytes));
      expect(fs.readFileSync(frozen.path)).toEqual(reviewedBytes);
    } finally {
      fs.rmSync(frozenDirectory, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("stages PowerPoint bytes in a private regular file without inspect sidecars", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-private-stage-"));
    let stagedDirectory = temp;
    try {
      const outputPath = path.join(temp, "output.pptx");
      const templatePath = path.join(temp, "source-template.pptx");
      const sentinel = Buffer.from("source template staging sentinel");
      fs.writeFileSync(templatePath, sentinel);
      const predictableTemporaryPath = path.join(
        temp,
        `.${path.basename(outputPath)}.nemoclaw-${process.pid}-1720000000000.tmp.pptx`,
      );
      fs.symlinkSync(templatePath, predictableTemporaryPath);

      const staged = await stagePowerPointBlob(
        {
          data: Buffer.from("new PowerPoint bytes"),
          sidecars: [
            {
              pathSuffix: ".inspect.ndjson",
              data: Buffer.from("private managed notes"),
            },
          ],
        },
        outputPath,
      );
      stagedDirectory = staged.directory;
      const stagedStat = fs.lstatSync(staged.path);
      expect(staged.path).not.toBe(predictableTemporaryPath);
      expect(stagedStat.isFile()).toBe(true);
      expect(stagedStat.isSymbolicLink()).toBe(false);
      expect(fs.statSync(staged.directory).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(staged.path, "utf8")).toBe("new PowerPoint bytes");
      expect(fs.existsSync(`${staged.path}.inspect.ndjson`)).toBe(false);
      expect(fs.readFileSync(templatePath)).toEqual(sentinel);
    } finally {
      fs.rmSync(stagedDirectory, { recursive: true, force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses an existing publication output before reading evidence or rendering", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-publish-existing-"));
    try {
      const outputPath = path.join(temp, "published-output.pptx");
      fs.writeFileSync(outputPath, "published sentinel");

      await expect(
        buildPptx({
          model: path.join(temp, "missing-model.json"),
          roleMap: path.join(temp, "missing-role-map.json"),
          template: path.join(temp, "missing-template.pptx"),
          ...templateWorkflowOptions(temp),
          output: outputPath,
          previewDir: path.join(temp, "preview"),
          layoutDir: path.join(temp, "layout"),
          readback: path.join(temp, "readback.json"),
          mode: "publish",
        }),
      ).rejects.toThrow(/already exists and will not be overwritten/u);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("published sentinel");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("leaves the publication output absent when the readback target exists", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-publish-partial-"));
    try {
      const temporaryOutputPath = path.join(temp, "temporary.pptx");
      const outputPath = path.join(temp, "published-output.pptx");
      const temporaryReadbackPath = path.join(temp, "temporary-readback.json");
      const readbackPath = path.join(temp, "existing-readback.json");
      fs.writeFileSync(temporaryOutputPath, "published bytes");
      fs.writeFileSync(temporaryReadbackPath, "{}\n");
      fs.writeFileSync(readbackPath, "existing readback sentinel");

      await expect(
        finalizePptxArtifacts({
          temporaryOutputPath,
          outputPath,
          temporaryReadbackPath,
          readbackPath,
          mode: "publish",
        }),
      ).rejects.toThrow(/EEXIST|file already exists/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readFileSync(readbackPath, "utf8")).toBe("existing readback sentinel");
      expect(fs.existsSync(temporaryOutputPath)).toBe(false);
      expect(fs.existsSync(temporaryReadbackPath)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses no-clobber supporting-first finalization for preview artifacts", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-preview-partial-"));
    try {
      const temporaryOutputPath = path.join(temp, "temporary.pptx");
      const outputPath = path.join(temp, "preview-output.pptx");
      const temporaryReadbackPath = path.join(temp, "temporary-readback.json");
      const readbackPath = path.join(temp, "existing-readback.json");
      fs.writeFileSync(temporaryOutputPath, "preview bytes");
      fs.writeFileSync(temporaryReadbackPath, "{}\n");
      fs.writeFileSync(readbackPath, "existing readback sentinel");

      await expect(
        finalizePptxArtifacts({
          temporaryOutputPath,
          outputPath,
          temporaryReadbackPath,
          readbackPath,
          mode: "preview",
        }),
      ).rejects.toThrow(/EEXIST|file already exists/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readFileSync(readbackPath, "utf8")).toBe("existing readback sentinel");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a preview destination parent swapped to the template parent before commit", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-preview-parent-swap-"));
    try {
      const sourceParent = path.join(temp, "source");
      const outputParent = path.join(temp, "output");
      const stageParent = path.join(temp, "stage");
      fs.mkdirSync(sourceParent);
      fs.mkdirSync(outputParent);
      fs.mkdirSync(stageParent);
      const templatePath = path.join(sourceParent, "template.pptx");
      const outputPath = path.join(outputParent, "template.pptx");
      const readbackPath = path.join(outputParent, "readback.json");
      const temporaryOutputPath = path.join(stageParent, "temporary.pptx");
      const temporaryReadbackPath = path.join(stageParent, "temporary-readback.json");
      fs.writeFileSync(templatePath, "approved template sentinel");
      fs.writeFileSync(temporaryOutputPath, "redirected preview bytes");
      fs.writeFileSync(temporaryReadbackPath, "{}\n");
      const isolation = {
        outputs: [
          { label: "output", value: outputPath },
          { label: "readback output", value: readbackPath },
        ],
        inputs: [{ label: "source template", value: templatePath }],
      };
      await expect(validatePptxFilesystemIsolation(isolation)).resolves.toBeUndefined();
      fs.rmSync(outputParent, { recursive: true });
      fs.symlinkSync(sourceParent, outputParent, "dir");

      await expect(
        finalizePptxArtifacts({
          temporaryOutputPath,
          outputPath,
          temporaryReadbackPath,
          readbackPath,
          mode: "preview",
          isolation,
        }),
      ).rejects.toThrow(/must be different files/u);
      expect(fs.readFileSync(templatePath, "utf8")).toBe("approved template sentinel");
      expect(fs.existsSync(path.join(sourceParent, "readback.json"))).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a destination parent swapped into the template workspace before commit", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-workspace-swap-"));
    try {
      const templateWorkspace = path.join(temp, "template-workspace");
      const outputParent = path.join(temp, "output");
      const stageParent = path.join(temp, "stage");
      fs.mkdirSync(templateWorkspace);
      fs.mkdirSync(outputParent);
      fs.mkdirSync(stageParent);
      const frameMapPath = path.join(templateWorkspace, "template-frame-map.json");
      const outputPath = path.join(outputParent, "generated-preview.pptx");
      const readbackPath = path.join(outputParent, "generated-readback.json");
      const temporaryOutputPath = path.join(stageParent, "temporary.pptx");
      const temporaryReadbackPath = path.join(stageParent, "temporary-readback.json");
      fs.writeFileSync(frameMapPath, "template frame map sentinel");
      fs.writeFileSync(temporaryOutputPath, "redirected preview bytes");
      fs.writeFileSync(temporaryReadbackPath, "{}\n");
      const isolation = {
        outputs: [
          { label: "output", value: outputPath },
          { label: "readback output", value: readbackPath },
        ],
        inputs: [{ label: "template frame map", value: frameMapPath }],
        protectedDirectories: [
          {
            label: "--template-workspace",
            value: templateWorkspace,
          },
        ],
      };
      await expect(validatePptxFilesystemIsolation(isolation)).resolves.toBeUndefined();
      fs.rmSync(outputParent, { recursive: true });
      fs.symlinkSync(templateWorkspace, outputParent, "dir");

      await expect(
        finalizePptxArtifacts({
          temporaryOutputPath,
          outputPath,
          temporaryReadbackPath,
          readbackPath,
          mode: "preview",
          isolation,
        }),
      ).rejects.toThrow(/output must be outside --template-workspace/u);
      expect(fs.readFileSync(frameMapPath, "utf8")).toBe("template frame map sentinel");
      expect(fs.existsSync(path.join(templateWorkspace, "generated-preview.pptx"))).toBe(false);
      expect(fs.existsSync(path.join(templateWorkspace, "generated-readback.json"))).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("removes invocation-created pre-output artifacts when a later destination exists", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slide-publish-rollback-"));
    try {
      const temporaryOutputPath = path.join(temp, "temporary.pptx");
      const outputPath = path.join(temp, "published-output.pptx");
      const temporaryReadbackPath = path.join(temp, "temporary-readback.json");
      const readbackPath = path.join(temp, "readback.json");
      const temporaryInspectPath = path.join(temp, "temporary-inspect.ndjson");
      const inspectOutputPath = path.join(temp, "existing-inspect.ndjson");
      fs.writeFileSync(temporaryOutputPath, "published bytes");
      fs.writeFileSync(temporaryReadbackPath, "{}\n");
      fs.writeFileSync(temporaryInspectPath, "generated inspection");
      fs.writeFileSync(inspectOutputPath, "existing inspection sentinel");

      await expect(
        finalizePptxArtifacts({
          temporaryOutputPath,
          outputPath,
          temporaryReadbackPath,
          readbackPath,
          temporaryInspectPath,
          inspectOutputPath,
          mode: "publish",
        }),
      ).rejects.toThrow(/EEXIST|file already exists/u);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.existsSync(readbackPath)).toBe(false);
      expect(fs.readFileSync(inspectOutputPath, "utf8")).toBe("existing inspection sentinel");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
