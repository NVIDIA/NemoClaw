// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { buildSlideModel } from "./build-slide-model.mts";
import { verifyDocumentationEvidence } from "./collect-doc-evidence.mts";
import {
  type CapabilityStructureInventory,
  type ClassifiedArtifactText,
  type WeeklyMilestoneStructureInventory,
  capabilityEpicDisplayText,
  capabilityEpicReferenceText,
  classifyArtifactTextInventories,
  compareParity,
  managedOperationTextByIdentity,
  NATIVE_KINDS,
  normalizeNativeKinds,
  type ProtectedTextSha256ByRole,
  protectedTextPolicyFromRoleMap,
  roadmapEpicDisplayText,
  roadmapFocusText,
} from "./compare-output-parity.mts";
import { canonicalJson, canonicalSha256, validateSlideModel } from "./validate-slide-model.mts";

type DynamicValue = ReturnType<typeof JSON.parse>;
type ManagedRole = (typeof MANAGED_ROLES)[number];
type ValidationMode = "preview" | "publish";
export const COMPLETED_EPIC_CONTEXT_COLOR = "#5B5B5B";
export const WEEKLY_MILESTONE_LABEL_FILL_COLOR = "#76B900";
export const WEEKLY_MILESTONE_LABEL_TEXT_COLOR = "#FFFFFF";
export const WEEKLY_NATIVE_BULLET_CHARACTER = "•";
export type HyperlinkInventoryEntry = {
  text: string;
  url: string;
};
export type ConnectorInventoryEntry = {
  contentId: string;
  from: string;
  to: string;
  direction: "from-to";
  lineStyle: "solid" | "dashed";
};
export type ThemePackageContract = {
  themeSha256ByPath: Record<string, string>;
  themeRelationshipTargetByPath: Record<string, string>;
  themeContentTypeParts: string[];
};
type RuntimeModules = {
  FileBlob: DynamicValue;
  PresentationFile: DynamicValue;
  JSZip: DynamicValue;
  sharp: DynamicValue;
};

export type BuildPptxOptions = {
  model: string;
  template: string;
  templateFrameMap: string;
  templateWorkspace: string;
  roleMap: string;
  output: string;
  previewDir: string;
  layoutDir: string;
  readback: string;
  mode: ValidationMode;
  inspectOutput?: string;
  approval?: string;
  validationEvidence?: string;
  parityEvidence?: string;
  reviewedPreviewPptx?: string;
  repoRoot?: string;
  snapshot?: string;
  docs?: string;
  presentationMap?: string;
  claims?: string;
  narrativeInput?: string;
};

type CliOptions = Partial<Omit<BuildPptxOptions, "mode">> & {
  mode: ValidationMode;
};

let runtimePromise: Promise<RuntimeModules> | undefined;
const artifactVerifiedReadbacks = new WeakSet<object>();
type PresentationRuntimePaths = {
  runtimeNode: string;
  runtimeNodeModules: string;
  runtimeBinDir: string;
  skillDir: string;
  tmpDir: string;
};

async function loadRuntime(): Promise<RuntimeModules> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtimeNodeModules = process.env.RUNTIME_NODE_MODULES;
      if (!runtimeNodeModules || !path.isAbsolute(runtimeNodeModules)) {
        throw new Error(
          "RUNTIME_NODE_MODULES must name the absolute bundled runtime node_modules path",
        );
      }
      const requireFromRuntime = createRequire(
        path.join(runtimeNodeModules, "__nemoclaw_runtime__.cjs"),
      );
      const artifactToolEntry = requireFromRuntime.resolve("@oai/artifact-tool");
      const artifactTool = await import(pathToFileURL(artifactToolEntry).href);
      const jsZipModule = requireFromRuntime("jszip");
      const sharpModule = requireFromRuntime("sharp");
      return {
        ...artifactTool,
        JSZip: jsZipModule.default ?? jsZipModule,
        sharp: sharpModule.default ?? sharpModule,
      };
    })();
  }
  return runtimePromise;
}

async function requireAbsoluteRuntimePath(
  value: string | undefined,
  name: string,
  kind: "file" | "directory",
): Promise<string> {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must name an absolute bundled runtime ${kind} path`);
  }
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`${name} must name an existing bundled runtime ${kind}`);
  }
  return resolved;
}

export async function validatePresentationRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
): Promise<PresentationRuntimePaths> {
  const [runtimeNode, runtimeNodeModules, runtimeBinDir, skillDir, tmpDir] = await Promise.all([
    requireAbsoluteRuntimePath(environment.RUNTIME_NODE, "RUNTIME_NODE", "file"),
    requireAbsoluteRuntimePath(
      environment.RUNTIME_NODE_MODULES,
      "RUNTIME_NODE_MODULES",
      "directory",
    ),
    requireAbsoluteRuntimePath(environment.RUNTIME_BIN_DIR, "RUNTIME_BIN_DIR", "directory"),
    requireAbsoluteRuntimePath(environment.SKILL_DIR, "SKILL_DIR", "directory"),
    requireAbsoluteRuntimePath(environment.TMP_DIR, "TMP_DIR", "directory"),
  ]);
  const [actualExecutable, requiredExecutable] = await Promise.all([
    fs.realpath(executablePath),
    fs.realpath(runtimeNode),
  ]);
  if (actualExecutable !== requiredExecutable) {
    throw new Error("The PowerPoint launcher must run with the exact RUNTIME_NODE executable");
  }
  const markerPath = path.join(skillDir, "container_tools", "mark_artifact_operation_started.mjs");
  const fidelityPath = path.join(
    skillDir,
    "template_following_scripts",
    "check_template_fidelity.mjs",
  );
  const starterPath = path.join(
    skillDir,
    "template_following_scripts",
    "prepare_template_starter_deck.mjs",
  );
  const planPath = path.join(skillDir, "template_following_scripts", "validate_template_plan.mjs");
  await Promise.all([
    requireAbsoluteRuntimePath(markerPath, "artifact operation marker", "file"),
    requireAbsoluteRuntimePath(fidelityPath, "template fidelity helper", "file"),
    requireAbsoluteRuntimePath(starterPath, "template starter helper", "file"),
    requireAbsoluteRuntimePath(planPath, "template plan validator", "file"),
  ]);
  return { runtimeNode, runtimeNodeModules, runtimeBinDir, skillDir, tmpDir };
}

type TemporaryAuthoringSurface = {
  directory: string;
  modulePath: string;
};

export type FrozenPptxAuthoringInputs = {
  templatePath: string;
  modelPath: string;
  roleMapPath: string;
  frameMapPath: string;
  inspectPath: string;
};

type TemplateWorkflowPaths = {
  workspace: string;
  frameMap: string;
  inspect: string;
  inspectManifest: string;
  audit: string;
  deviationLog: string;
  starterPptx: string;
  starterPreviewDir: string;
  starterLayoutDir: string;
  finalLayoutDir: string;
};

export async function createTemporaryPptxAuthoringSurface({
  tmpDir,
  runtimeNodeModules,
  authoringSourcePath = fileURLToPath(new URL("./pptx-authoring-module.mts", import.meta.url)),
}: {
  tmpDir: string;
  runtimeNodeModules: string;
  authoringSourcePath?: string;
}): Promise<TemporaryAuthoringSurface> {
  const directory = await fs.mkdtemp(path.join(path.resolve(tmpDir), "nemoclaw-pptx-authoring-"));
  await fs.chmod(directory, 0o700);
  const modulePath = path.join(directory, "build-pptx-authoring.mjs");
  const moduleSource = await fs.readFile(path.resolve(authoringSourcePath));
  await fs.writeFile(modulePath, moduleSource, { flag: "wx", mode: 0o600 });
  await fs.symlink(runtimeNodeModules, path.join(directory, "node_modules"), "dir");
  return { directory, modulePath };
}

export async function freezePptxAuthoringInputs({
  surface,
  templateBytes,
  modelBytes,
  roleMapBytes,
  frameMapBytes,
  inspectBytes,
}: {
  surface: TemporaryAuthoringSurface;
  templateBytes: Buffer;
  modelBytes: Buffer;
  roleMapBytes: Buffer;
  frameMapBytes: Buffer;
  inspectBytes: Buffer;
}): Promise<FrozenPptxAuthoringInputs> {
  const frozen: FrozenPptxAuthoringInputs = {
    templatePath: path.join(surface.directory, "validated-template.pptx"),
    modelPath: path.join(surface.directory, "validated-slide-model.json"),
    roleMapPath: path.join(surface.directory, "validated-role-map.json"),
    frameMapPath: path.join(surface.directory, "validated-template-frame-map.json"),
    inspectPath: path.join(surface.directory, "validated-template-inspect.ndjson"),
  };
  await Promise.all([
    fs.writeFile(frozen.templatePath, templateBytes, {
      flag: "wx",
      mode: 0o600,
    }),
    fs.writeFile(frozen.modelPath, modelBytes, { flag: "wx", mode: 0o600 }),
    fs.writeFile(frozen.roleMapPath, roleMapBytes, { flag: "wx", mode: 0o600 }),
    fs.writeFile(frozen.frameMapPath, frameMapBytes, {
      flag: "wx",
      mode: 0o600,
    }),
    fs.writeFile(frozen.inspectPath, inspectBytes, { flag: "wx", mode: 0o600 }),
  ]);
  return frozen;
}

async function runRuntimeProcess(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    const suffix = result.signal ? ` (signal ${result.signal})` : "";
    throw new Error(`Presentation runtime command failed with exit ${result.code}${suffix}`);
  }
}

function runtimeChildEnvironment(runtime: PresentationRuntimePaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNTIME_NODE: runtime.runtimeNode,
    RUNTIME_NODE_MODULES: runtime.runtimeNodeModules,
    RUNTIME_BIN_DIR: runtime.runtimeBinDir,
    SKILL_DIR: runtime.skillDir,
    TMP_DIR: runtime.tmpDir,
    PATH: [runtime.runtimeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}

async function runTemplatePlanPreflight(
  runtime: PresentationRuntimePaths,
  workflow: TemplateWorkflowPaths,
  frozenInputs: FrozenPptxAuthoringInputs,
): Promise<void> {
  await runRuntimeProcess(
    runtime.runtimeNode,
    [
      path.join(runtime.skillDir, "template_following_scripts", "validate_template_plan.mjs"),
      "--workspace",
      workflow.workspace,
      "--map",
      frozenInputs.frameMapPath,
      "--inspect",
      frozenInputs.inspectPath,
      "--no-report",
    ],
    runtimeChildEnvironment(runtime),
  );
}

async function authorPowerPointWithTemporaryModule({
  runtime,
  workflow,
  surface,
  frozenInputs,
}: {
  runtime: PresentationRuntimePaths;
  workflow: TemplateWorkflowPaths;
  surface: TemporaryAuthoringSurface;
  frozenInputs: FrozenPptxAuthoringInputs;
}): Promise<{ surface: TemporaryAuthoringSurface; authoredOutput: string }> {
  const markerPath = path.join(
    runtime.skillDir,
    "container_tools",
    "mark_artifact_operation_started.mjs",
  );
  const environment = {
    ...runtimeChildEnvironment(runtime),
    NEMOCLAW_PPTX_AUTHORING_DIR: surface.directory,
  };
  const authoredOutput = path.join(surface.directory, "authored-output.pptx");
  try {
    await runRuntimeProcess(
      runtime.runtimeNode,
      [
        markerPath,
        "--operation-kind",
        "edit",
        "--expected-output-count",
        "1",
        "--output-format",
        "pptx",
      ],
      environment,
    );
    await runRuntimeProcess(
      runtime.runtimeNode,
      [
        path.join(
          runtime.skillDir,
          "template_following_scripts",
          "prepare_template_starter_deck.mjs",
        ),
        "--workspace",
        workflow.workspace,
        "--pptx",
        frozenInputs.templatePath,
        "--map",
        frozenInputs.frameMapPath,
        "--out",
        workflow.starterPptx,
        "--preview-dir",
        workflow.starterPreviewDir,
        "--layout-dir",
        workflow.starterLayoutDir,
        "--inspect",
        frozenInputs.inspectPath,
      ],
      environment,
    );
    await runRuntimeProcess(
      runtime.runtimeNode,
      [
        surface.modulePath,
        "--model",
        frozenInputs.modelPath,
        "--role-map",
        frozenInputs.roleMapPath,
        "--template-frame-map",
        frozenInputs.frameMapPath,
        "--template-starter-pptx",
        workflow.starterPptx,
        "--output",
        authoredOutput,
      ],
      environment,
    );
    return { surface, authoredOutput };
  } catch (error) {
    await fs.rm(surface.directory, { recursive: true, force: true });
    throw error;
  }
}

const MANAGED_ROLES = [
  "roadmap-executive",
  "roadmap-capability",
  "markitecture",
  "weekly-release",
] as const;
const MANAGED_MARKER = /^\[NEMOCLAW-MANAGED-SLIDE v1\]\nrole=([^\n]+)\n/u;
const SLIDE_MODEL_SCHEMA = new URL("../references/slide-model.schema.json", import.meta.url);

export async function templateSlideCountFromPptxBytes(
  JSZip: DynamicValue,
  templateBytes: Buffer | Uint8Array,
): Promise<number> {
  const zip = await JSZip.loadAsync(templateBytes);
  const slideNumbers = Object.keys(zip.files)
    .map((entry) => /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.exec(entry)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
  if (slideNumbers.length === 0 || slideNumbers.some((slide, index) => slide !== index + 1)) {
    throw new Error("Approved template PPTX has a missing or nonsequential slide part");
  }
  return slideNumbers.length;
}

export function validateTemplateSourceInventoryBinding({
  manifest,
  actualTemplateSlideCount,
  templatePath,
}: {
  manifest: DynamicValue;
  actualTemplateSlideCount: number;
  templatePath: string;
}): void {
  if (!Number.isInteger(actualTemplateSlideCount) || actualTemplateSlideCount <= 0) {
    throw new Error("Approved template PPTX lacks a positive actual slide count");
  }
  if (
    manifest.slideCount !== actualTemplateSlideCount ||
    manifest.packageParts?.slideXmlCount !== actualTemplateSlideCount ||
    path.resolve(String(manifest.sourcePptx ?? "")) !== path.resolve(templatePath)
  ) {
    throw new Error("Template inspection manifest is not bound to the exact approved template");
  }
  const artifactSlides = (manifest.slideArtifacts ?? []).map(
    (artifact: DynamicValue) => artifact.slide,
  );
  if (
    artifactSlides.length !== actualTemplateSlideCount ||
    artifactSlides.some((slide: DynamicValue, index: number) => slide !== index + 1)
  ) {
    throw new Error("Template inspection manifest omits an actual source slide");
  }
}

function isWithinPath(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function requireRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`${label} is missing: ${filePath}`);
}

async function requireAbsentPath(filePath: string, label: string): Promise<void> {
  const exists = await fs.lstat(filePath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) throw new Error(`${label} must be absent before PowerPoint authoring: ${filePath}`);
}

function resolveTemplateWorkflowPaths(options: BuildPptxOptions): TemplateWorkflowPaths {
  const workspace = path.resolve(options.templateWorkspace);
  const frameMap = path.resolve(options.templateFrameMap);
  if (
    path.basename(frameMap) !== "template-frame-map.json" ||
    path.dirname(frameMap) !== workspace
  ) {
    throw new Error(
      "--template-frame-map must name template-frame-map.json directly under --template-workspace",
    );
  }
  return {
    workspace,
    frameMap,
    inspect: path.join(workspace, "template-inspect", "template-inspect.ndjson"),
    inspectManifest: path.join(workspace, "template-inspect", "template-manifest.json"),
    audit: path.join(workspace, "template-audit.txt"),
    deviationLog: path.join(workspace, "deviation-log.txt"),
    starterPptx: path.join(workspace, "template-starter.pptx"),
    starterPreviewDir: path.join(workspace, "template-starter-preview"),
    starterLayoutDir: path.join(workspace, "template-starter-layout"),
    finalLayoutDir: path.join(workspace, "template-final-layout"),
  };
}

function frameMapTargetNames(
  target: DynamicValue,
  sourceElementNameById: Map<string, string> = new Map(),
): string[] {
  return [
    target?.name,
    target?.sourceElementName,
    ...(Array.isArray(target?.names) ? target.names : []),
    ...(Array.isArray(target?.sourceElementNames) ? target.sourceElementNames : []),
    ...[
      target?.sourceElementId,
      ...(Array.isArray(target?.sourceElementIds) ? target.sourceElementIds : []),
      target?.shapeId,
      ...(Array.isArray(target?.shapeIds) ? target.shapeIds : []),
    ].map((id) => sourceElementNameById.get(String(id))),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function roleMapTargetNames(contract: DynamicValue): string[] {
  const operationGroups = [
    contract.operations,
    contract.richTextOperations,
    contract.outcomeOperations,
    contract.outcomeListOperations,
    contract.metricOperations,
    contract.milestoneRowOperations,
    contract.geometryOperations,
  ];
  return [
    ...operationGroups.flatMap((operations) =>
      (operations ?? []).flatMap((operation: DynamicValue) => operation.target?.name ?? []),
    ),
    contract.table?.target?.name,
    contract.unclassifiedTarget?.name,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export { managedOperationTextByIdentity };

export function validateWeeklyMilestoneRowRoleMap(roleMap: DynamicValue): void {
  const contract = roleMap?.roles?.["weekly-release"];
  if (!contract || !Array.isArray(contract.milestoneRowOperations)) {
    throw new Error("Runtime weekly role must declare milestoneRowOperations");
  }
  if (
    Object.hasOwn(contract, "releaseBulletOperations") ||
    Object.hasOwn(contract, "releaseOperations")
  ) {
    throw new Error("Runtime weekly role must not declare release row operations");
  }
  const expected = new Set(
    [0, 1, 2].flatMap((rowIndex) =>
      ["label", "updates", "risks"].map((kind) => `${rowIndex}:${kind}`),
    ),
  );
  const seen = new Set<string>();
  const targets = new Set<string>();
  for (const operation of contract.milestoneRowOperations) {
    if (
      !Number.isInteger(operation?.rowIndex) ||
      operation.rowIndex < 0 ||
      operation.rowIndex > 2 ||
      !["label", "updates", "risks"].includes(operation?.kind)
    ) {
      throw new Error("Runtime weekly milestone row operation has an invalid rowIndex or kind");
    }
    if (typeof operation.target?.name !== "string" || operation.target.name.length === 0) {
      throw new Error("Runtime weekly milestone row operation requires one inspected named target");
    }
    if (operation.kind === "label") {
      if (
        operation.placement !== "left" ||
        String(operation.fillColor ?? "").toUpperCase() !== WEEKLY_MILESTONE_LABEL_FILL_COLOR ||
        String(operation.textStyle?.color ?? "").toUpperCase() !==
          WEEKLY_MILESTONE_LABEL_TEXT_COLOR ||
        operation.textStyle?.bold !== true ||
        operation.paragraphStyle?.bulletCharacter !== ""
      ) {
        throw new Error(
          "Runtime weekly milestone labels must declare left placement, NVIDIA-green fill, bold white text, and no bullet",
        );
      }
    } else if (
      operation.nativeBullets !== true ||
      operation.paragraphStyle?.bulletCharacter !== WEEKLY_NATIVE_BULLET_CHARACTER
    ) {
      throw new Error(
        "Runtime weekly Updates and Risks / Blockers must declare native bullet paragraphs",
      );
    }
    const key = `${operation.rowIndex}:${operation.kind}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new Error(`Runtime weekly milestone row operation is duplicate: ${key}`);
    }
    seen.add(key);
    const target = JSON.stringify(operation.target ?? null);
    if (target === "null" || targets.has(target)) {
      throw new Error("Runtime weekly milestone row operations must use distinct targets");
    }
    targets.add(target);
  }
  if (seen.size !== expected.size || [...expected].some((key) => !seen.has(key))) {
    throw new Error("Runtime weekly role must map label, updates, and risks for all three rows");
  }
}

export function validateCapabilityClassificationWarningAuthorization({
  capabilityEntry,
  capabilityContract,
  modelSlide,
}: {
  capabilityEntry: DynamicValue;
  capabilityContract: DynamicValue;
  modelSlide: DynamicValue;
}): void {
  const capabilityAdds = capabilityEntry.editTargets.filter(
    (target: DynamicValue) => target.action === "add",
  );
  if ((modelSlide.unclassified?.length ?? 0) === 0) {
    if (capabilityAdds.length > 0) {
      throw new Error(
        `${modelSlide.instanceId ?? modelSlide.role} frame map must not authorize a classification warning without unclassified Epics`,
      );
    }
    return;
  }
  const capabilityContentIds = capabilityAdds
    .flatMap((target: DynamicValue) => [target.contentId, ...(target.contentIds ?? [])])
    .filter((value: DynamicValue) => typeof value === "string");
  const warningAdd = capabilityAdds[0];
  if (
    capabilityAdds.length !== 1 ||
    JSON.stringify(capabilityContentIds) !== JSON.stringify(["matrix-needs-classification"]) ||
    warningAdd.newPrimitiveAllowed !== true ||
    warningAdd.mustNotOverlapInherited !== true ||
    !warningAdd.zone ||
    !capabilityContract.unclassifiedWarning?.position ||
    canonicalJson(warningAdd.zone) !==
      canonicalJson(capabilityContract.unclassifiedWarning.position)
  ) {
    throw new Error(
      `${modelSlide.instanceId ?? modelSlide.role} frame map must authorize the exact native classification warning zone`,
    );
  }
}

function missingRoadmapExecutiveTargetNames(
  executiveContract: DynamicValue,
  modelSlide: DynamicValue,
): string[] {
  const missingOperations = [
    ...(executiveContract.operations ?? []).filter(
      (operation: DynamicValue) =>
        /^milestones\.\d+\.(?:title|focus)$/u.test(operation.valuePath ?? "") &&
        getPath(modelSlide, operation.valuePath) === undefined,
    ),
    ...(executiveContract.outcomeListOperations ?? []).filter(
      (operation: DynamicValue) =>
        /^milestones\.\d+\.outcomes$/u.test(operation.outcomesPath ?? "") &&
        getPath(modelSlide, operation.outcomesPath) === undefined,
    ),
  ];
  return missingOperations
    .flatMap((operation: DynamicValue) => frameMapTargetNames(operation.target))
    .sort(compareUtf16);
}

function capabilityMilestoneTitleOperations(capabilityContract: DynamicValue): DynamicValue[] {
  const table = capabilityContract?.table;
  if (
    table?.milestoneColumnCount !== 3 ||
    table.topRow !== 0 ||
    Object.hasOwn(table, "headerRow") ||
    Object.hasOwn(table, "cornerLabel")
  ) {
    throw new Error(
      "Capability matrix runtime map requires three milestone columns, one blank topRow, and no native-table header text",
    );
  }
  const allColumnTitleBindings: DynamicValue[] = [];
  const collectColumnTitleBindings = (value: DynamicValue): void => {
    if (Array.isArray(value)) {
      for (const child of value) collectColumnTitleBindings(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (/^columns\.\d+\.title$/u.test(value.valuePath ?? "")) {
      allColumnTitleBindings.push(value);
    }
    for (const child of Object.values(value)) collectColumnTitleBindings(child);
  };
  collectColumnTitleBindings(capabilityContract);
  if (
    allColumnTitleBindings.length !== 3 ||
    allColumnTitleBindings.some(
      (binding) =>
        !Array.isArray(capabilityContract.operations) ||
        !capabilityContract.operations.includes(binding),
    )
  ) {
    throw new Error(
      "Capability milestone title operations require exactly three direct contract.operations bindings",
    );
  }
  const byIndex = new Map<number, DynamicValue>();
  const targetNames = new Set<string>();
  for (const operation of capabilityContract.operations ?? []) {
    const match = /^columns\.(\d+)\.title$/u.exec(operation.valuePath ?? "");
    if (!match) continue;
    const index = Number(match[1]);
    const forbiddenBindingFields = Object.keys(operation).filter(
      (key) =>
        ["literal", "prefix", "suffix", "search"].includes(key) || /fallback|transform/iu.test(key),
    );
    if (
      index >= table.milestoneColumnCount ||
      operation.valuePath !== `columns.${index}.title` ||
      byIndex.has(index) ||
      typeof operation.target?.name !== "string" ||
      operation.target.name.length === 0 ||
      targetNames.has(operation.target.name) ||
      Object.keys(operation.target).some((key) => key !== "name") ||
      forbiddenBindingFields.length > 0 ||
      Object.hasOwn(operation, "link") ||
      Object.hasOwn(operation, "linkPath")
    ) {
      throw new Error(
        "Capability milestone title operations require one distinct named, unlinked HOME_PLATE target for each top-row slot",
      );
    }
    byIndex.set(index, operation);
    targetNames.add(operation.target.name);
  }
  const operations = Array.from({ length: table.milestoneColumnCount }, (_value, index) =>
    byIndex.get(index),
  );
  if (operations.some((operation) => operation === undefined)) {
    throw new Error(
      "Capability milestone title operations require one distinct named, unlinked HOME_PLATE target for each top-row slot",
    );
  }
  return operations;
}

function missingRoadmapCapabilityTargetNames(
  capabilityContract: DynamicValue,
  modelSlide: DynamicValue,
): string[] {
  return capabilityMilestoneTitleOperations(capabilityContract)
    .filter((operation: DynamicValue) => getPath(modelSlide, operation.valuePath) === undefined)
    .flatMap((operation: DynamicValue) => frameMapTargetNames(operation.target))
    .sort(compareUtf16);
}

export function validateRoadmapExecutiveDeleteAuthorization({
  executiveEntry,
  executiveContract,
  modelSlide,
  sourceElementNameById = new Map(),
}: {
  executiveEntry: DynamicValue;
  executiveContract: DynamicValue;
  modelSlide: DynamicValue;
  sourceElementNameById?: Map<string, string>;
}): void {
  const expected = missingRoadmapExecutiveTargetNames(executiveContract, modelSlide);
  const actual = executiveEntry.editTargets
    .filter((target: DynamicValue) => target.action === "delete")
    .flatMap((target: DynamicValue) => frameMapTargetNames(target, sourceElementNameById))
    .sort(compareUtf16);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `${modelSlide.instanceId ?? modelSlide.role} frame-map deletes must equal its unused executive milestone targets`,
    );
  }
}

export function validateRoadmapCapabilityDeleteAuthorization({
  capabilityEntry,
  capabilityContract,
  modelSlide,
  sourceElementNameById = new Map(),
}: {
  capabilityEntry: DynamicValue;
  capabilityContract: DynamicValue;
  modelSlide: DynamicValue;
  sourceElementNameById?: Map<string, string>;
}): void {
  const expected = missingRoadmapCapabilityTargetNames(capabilityContract, modelSlide);
  const actual = capabilityEntry.editTargets
    .filter((target: DynamicValue) => target.action === "delete")
    .flatMap((target: DynamicValue) => frameMapTargetNames(target, sourceElementNameById))
    .sort(compareUtf16);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `${modelSlide.instanceId ?? modelSlide.role} frame-map deletes must equal its unused capability milestone HOME_PLATE targets`,
    );
  }
}

export function validateTemplateFrameMapContract({
  frameMap,
  roleMap,
  model,
  sourceSlideCount,
  sourceElementNameById = new Map(),
}: {
  frameMap: DynamicValue;
  roleMap: DynamicValue;
  model: DynamicValue;
  sourceSlideCount: number;
  sourceElementNameById?: Map<string, string>;
}): void {
  if (!Array.isArray(frameMap.outputSlides)) {
    throw new Error("Template frame map requires outputSlides");
  }
  const sorted = [...frameMap.outputSlides].sort(
    (left, right) => Number(left.outputSlide) - Number(right.outputSlide),
  );
  sorted.forEach((entry, index) => {
    if (entry.outputSlide !== index + 1 || entry.reuseMode !== "duplicate-slide") {
      throw new Error("Template frame-map outputs must be sequential duplicate-slide entries");
    }
    if (!Array.isArray(entry.editTargets)) {
      throw new Error(`Template frame-map output ${entry.outputSlide} lacks editTargets`);
    }
  });
  const managedEntries = new Set<DynamicValue>();
  const managedSourceSlides = new Set<number>();
  for (const [roleIndex, role] of MANAGED_ROLES.entries()) {
    const contract = roleMap.roles?.[role];
    const expectedTargetSlideIndex = Number(roleMap.insertionIndex) + roleIndex;
    if (
      !contract ||
      !Number.isInteger(expectedTargetSlideIndex) ||
      contract.targetSlideIndex !== expectedTargetSlideIndex
    ) {
      throw new Error(`${role} targetSlideIndex must equal insertionIndex plus its role offset`);
    }
    if (
      Object.hasOwn(contract, "deleteSourceAfterDuplicate") ||
      Object.hasOwn(contract, "clearSourceElements") ||
      Object.hasOwn(contract, "preserveSourceText")
    ) {
      throw new Error(`${role} uses a forbidden broad source deletion contract`);
    }
    managedSourceSlides.add(Number(contract.sourceSlideIndex) + 1);
  }
  const modelSlides = model.slides as DynamicValue[];
  for (const [modelIndex, modelSlide] of modelSlides.entries()) {
    const role = modelSlide.role as ManagedRole;
    const contract = roleMap.roles?.[role];
    const expectedOutputSlide = Number(roleMap.insertionIndex) + modelIndex + 1;
    const entry = sorted[expectedOutputSlide - 1];
    if (
      !contract ||
      entry?.narrativeRole !== role ||
      entry?.sourceSlide !== Number(contract.sourceSlideIndex) + 1 ||
      (modelSlide.instanceId
        ? entry.instanceId !== modelSlide.instanceId
        : entry.instanceId !== undefined)
    ) {
      throw new Error(
        `${modelSlide.instanceId ?? role} does not match its template frame-map source and output slide`,
      );
    }
    managedEntries.add(entry);
    if (role === "roadmap-executive") {
      validateRoadmapExecutiveDeleteAuthorization({
        executiveEntry: entry,
        executiveContract: contract,
        modelSlide,
        sourceElementNameById,
      });
    } else if (role === "roadmap-capability") {
      validateRoadmapCapabilityDeleteAuthorization({
        capabilityEntry: entry,
        capabilityContract: contract,
        modelSlide,
        sourceElementNameById,
      });
    }
    const authorizedNames = new Set(
      entry.editTargets
        .filter((target: DynamicValue) => target.action !== "keep")
        .flatMap((target: DynamicValue) => frameMapTargetNames(target, sourceElementNameById)),
    );
    for (const name of roleMapTargetNames(contract)) {
      if (!authorizedNames.has(name)) {
        throw new Error(
          `${modelSlide.instanceId ?? role} frame map does not authorize editing ${name}`,
        );
      }
    }
    const geometryNames = (contract.geometryOperations ?? [])
      .flatMap((operation: DynamicValue) => frameMapTargetNames(operation.target))
      .sort(compareUtf16);
    if (
      (contract.geometryOperations ?? []).some(
        (operation: DynamicValue) =>
          typeof operation.target?.name !== "string" ||
          !["left", "top", "width", "height"].every(
            (key) =>
              Number.isInteger(operation.positionEmu?.[key]) && operation.positionEmu[key] >= 0,
          ),
      )
    ) {
      throw new Error(
        `${modelSlide.instanceId ?? role} geometryOperations require named nonnegative integer-EMU positions`,
      );
    }
    const repositionNames = entry.editTargets
      .filter((target: DynamicValue) => target.action === "rewrite-and-reposition")
      .flatMap((target: DynamicValue) => frameMapTargetNames(target, sourceElementNameById))
      .sort(compareUtf16);
    if (canonicalJson(geometryNames) !== canonicalJson(repositionNames)) {
      throw new Error(
        `${modelSlide.instanceId ?? role} frame-map rewrite-and-reposition targets differ from geometryOperations`,
      );
    }
    for (const target of entry.editTargets.filter(
      (candidate: DynamicValue) => candidate.action === "delete",
    )) {
      if (
        typeof target.sourceElementName !== "string" &&
        !(
          Array.isArray(target.sourceElementNames) &&
          target.sourceElementNames.every(
            (name: DynamicValue) => typeof name === "string" && name.length > 0,
          ) &&
          target.sourceElementNames.length > 0
        )
      ) {
        throw new Error(
          `${modelSlide.instanceId ?? role} frame-map deletes require sourceElementName`,
        );
      }
    }
  }
  const preservedEntries = sorted.filter((entry) => !managedEntries.has(entry));
  const expectedPreservedSourceSlides = Array.from(
    { length: sourceSlideCount },
    (_value, index) => index + 1,
  ).filter((sourceSlide) => !managedSourceSlides.has(sourceSlide));
  if (
    preservedEntries.some((entry) => entry.editTargets.length > 0) ||
    JSON.stringify(
      preservedEntries.map((entry) => entry.sourceSlide).sort((left, right) => left - right),
    ) !== JSON.stringify(expectedPreservedSourceSlides)
  ) {
    throw new Error("Template frame map must preserve every unrelated source slide untouched");
  }
  if (sorted.length !== modelSlides.length + expectedPreservedSourceSlides.length) {
    throw new Error("Template frame map has unexpected duplicate or omitted outputs");
  }

  const capabilityContract = roleMap.roles["roadmap-capability"];
  for (const capabilityEntry of [...managedEntries].filter(
    (entry) => entry.narrativeRole === "roadmap-capability",
  )) {
    const capabilityModelSlide = modelSlides.find(
      (slide: DynamicValue) =>
        slide.role === "roadmap-capability" &&
        (capabilityEntry.instanceId
          ? slide.instanceId === capabilityEntry.instanceId
          : !slide.instanceId),
    );
    if (!capabilityModelSlide) {
      throw new Error("Capability frame map has no matching model page");
    }
    validateCapabilityClassificationWarningAuthorization({
      capabilityEntry,
      capabilityContract,
      modelSlide: capabilityModelSlide,
    });
  }

  const markitectureEntry = [...managedEntries].find(
    (entry) => entry.narrativeRole === "markitecture",
  );
  if (!markitectureEntry) throw new Error("Template frame map lacks the markitecture output");
  const authorizedContentIds = new Set<string>(
    markitectureEntry.editTargets
      .filter((target: DynamicValue) => target.action === "add")
      .flatMap((target: DynamicValue) => [target.contentId, ...(target.contentIds ?? [])])
      .filter((value: DynamicValue) => typeof value === "string"),
  );
  const boundedAdds = markitectureEntry.editTargets.filter(
    (target: DynamicValue) =>
      target.action === "add" &&
      target.newPrimitiveAllowed === true &&
      target.mustNotOverlapInherited === true &&
      target.zone &&
      ["left", "top", "width", "height"].every((key) => Number.isFinite(target.zone[key])),
  );
  const markitectureModel = model.slides.find(
    (slide: DynamicValue) => slide.role === "markitecture",
  );
  const expectedContentIds = new Set<string>([
    ...(markitectureModel?.nodes ?? []).map((node: DynamicValue) => node.contentId),
    ...(markitectureModel?.connectors ?? []).flatMap((connector: DynamicValue) => [
      connector.contentId,
      `${connector.contentId}:label`,
    ]),
  ]);
  if (
    boundedAdds.length === 0 ||
    JSON.stringify([...authorizedContentIds].sort(compareUtf16)) !==
      JSON.stringify([...expectedContentIds].sort(compareUtf16))
  ) {
    throw new Error(
      "Markitecture frame map must authorize exactly the modeled native nodes, connectors, and labels",
    );
  }

  const connectorGroups = new Map<string, DynamicValue[]>();
  for (const connector of markitectureModel?.connectors ?? []) {
    const pair = [connector.from, connector.to].sort(compareUtf16).join("\u0000");
    const group = connectorGroups.get(pair) ?? [];
    group.push(connector);
    connectorGroups.set(pair, group);
  }
  const validSides = new Set(["top", "left", "bottom", "right"]);
  for (const connectors of connectorGroups.values()) {
    if (connectors.length < 2) continue;
    const attachmentSignatures = new Set<string>();
    for (const connector of connectors) {
      const frame = roleMap.roles.markitecture.geometry?.connectorFrames?.[connector.contentId];
      if (!validSides.has(frame?.fromSide) || !validSides.has(frame?.toSide)) {
        throw new Error(
          `Reciprocal connector ${connector.contentId} requires explicit real-node side attachments`,
        );
      }
      const signature = [`${connector.from}:${frame.fromSide}`, `${connector.to}:${frame.toSide}`]
        .sort(compareUtf16)
        .join("\u0000");
      if (attachmentSignatures.has(signature)) {
        throw new Error("Reciprocal native connectors must use visibly distinct attachment sites");
      }
      attachmentSignatures.add(signature);
    }
  }
}

async function validateTemplateWorkflowInputs({
  workflow,
  runtime,
  templatePath,
  frameMapBytes,
  frameMap,
  manifest,
  inspectText,
  actualTemplateSlideCount,
  frozenInputs,
  roleMap,
  model,
}: {
  workflow: TemplateWorkflowPaths;
  runtime: PresentationRuntimePaths;
  templatePath: string;
  frameMapBytes: Buffer;
  frameMap: DynamicValue;
  manifest: DynamicValue;
  inspectText: string;
  actualTemplateSlideCount: number;
  frozenInputs: FrozenPptxAuthoringInputs;
  roleMap: DynamicValue;
  model: DynamicValue;
}): Promise<DynamicValue> {
  if (!isWithinPath(workflow.workspace, runtime.tmpDir)) {
    throw new Error("--template-workspace must be inside TMP_DIR");
  }
  await Promise.all([
    requireRegularFile(workflow.frameMap, "template frame map"),
    requireRegularFile(workflow.inspect, "template inspection"),
    requireRegularFile(workflow.inspectManifest, "template inspection manifest"),
    requireRegularFile(workflow.audit, "template audit"),
    requireRegularFile(workflow.deviationLog, "template deviation log"),
    requireAbsentPath(workflow.starterPptx, "template starter PPTX"),
    requireAbsentPath(workflow.starterPreviewDir, "template starter preview directory"),
    requireAbsentPath(workflow.starterLayoutDir, "template starter layout directory"),
    requireAbsentPath(workflow.finalLayoutDir, "template final layout directory"),
  ]);
  if (roleMap.templateFrameMapSha256 !== sha256Bytes(frameMapBytes)) {
    throw new Error("Runtime role map does not match the exact template frame-map hash");
  }
  validateTemplateSourceInventoryBinding({
    manifest,
    actualTemplateSlideCount,
    templatePath,
  });
  const inspectRecords = inspectText
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const inspectedSlides = new Set(
    inspectRecords
      .filter((record) => record.kind === "slide" && Number.isInteger(record.slide))
      .map((record) => record.slide),
  );
  if (
    inspectedSlides.size !== actualTemplateSlideCount ||
    Array.from({ length: actualTemplateSlideCount }, (_value, index) => index + 1).some(
      (slide) => !inspectedSlides.has(slide),
    )
  ) {
    throw new Error("Template inspection does not inventory every source slide");
  }
  const omissionNotices = inspectRecords
    .filter((record) => record.kind === "notice")
    .map((record) => /Truncated:\s*omitted ([0-9]+) lines/u.exec(String(record.message))?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  if (
    omissionNotices.some((omitted) => omitted > 0) ||
    (manifest.inspectTruncated === true && !omissionNotices.includes(0))
  ) {
    throw new Error("Template inspection is truncated with omitted records");
  }
  for (let slide = 1; slide <= actualTemplateSlideCount; slide += 1) {
    const entry = manifest.slideArtifacts?.find(
      (candidate: DynamicValue) => candidate.slide === slide,
    );
    if (!entry?.layoutPath)
      throw new Error(`Template inspection lacks layout evidence for slide ${slide}`);
    const layoutPath = path.resolve(entry.layoutPath);
    if (!isWithinPath(layoutPath, path.join(workflow.workspace, "template-inspect"))) {
      throw new Error(`Template source layout ${slide} escapes the template workspace`);
    }
    await requireRegularFile(layoutPath, `template source layout ${slide}`);
  }
  validateTemplateFrameMapContract({
    frameMap,
    roleMap,
    model,
    sourceSlideCount: actualTemplateSlideCount,
  });
  await runTemplatePlanPreflight(runtime, workflow, frozenInputs);
  return frameMap;
}

function withoutArtifactAnchors(value: DynamicValue): DynamicValue {
  if (Array.isArray(value)) return value.map(withoutArtifactAnchors);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, child]) =>
          key !== "aid" &&
          key !== "id" &&
          key !== "assetId" &&
          key !== "ownedElementAids" &&
          key !== "tableAid" &&
          !(key === "bulletCharacter" && child === ""),
      )
      .map(([key, child]) => [key, withoutArtifactAnchors(child)]),
  );
}

function withoutArtifactElementMetadata(value: DynamicValue): DynamicValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return withoutArtifactAnchors(value);
  }
  const { order: _order, ...rest } = value;
  return withoutArtifactAnchors(rest);
}

function withoutTopLevelElementGeometry(value: DynamicValue): DynamicValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    bbox: _bbox,
    position: _position,
    frame: _frame,
    pixelRect: _pixelRect,
    previewFrame: _previewFrame,
    ...rest
  } = value;
  return rest;
}

function assertLayoutGeometryMatchesEmu(
  element: DynamicValue,
  positionEmu: DynamicValue,
  context: string,
): void {
  if (
    !Array.isArray(element?.bbox) ||
    element.bbox.length !== 4 ||
    !element.bbox.every((value: DynamicValue) => Number.isFinite(value)) ||
    !["left", "top", "width", "height"].every(
      (key) => Number.isInteger(positionEmu?.[key]) && positionEmu[key] >= 0,
    )
  ) {
    throw new Error(`${context} lacks an exact integer-EMU geometry contract`);
  }
  const expected = ["left", "top", "width", "height"].map((key) => Number(positionEmu[key]) / 9525);
  if (
    element.bbox.some(
      (value: DynamicValue, index: number) => Math.abs(value - expected[index]) > 0.02,
    )
  ) {
    throw new Error(`${context} differs from its exact integer-EMU geometry contract`);
  }
}

const REWRITE_CONTENT_KEYS = new Set([
  "text",
  "textPreview",
  "textLayout",
  "hyperlink",
  "hyperlinks",
  "link",
  "links",
  "url",
  "uri",
  "href",
]);

function uniqueCanonicalValues(values: DynamicValue[]): DynamicValue[] {
  const byCanonicalValue = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...byCanonicalValue.entries()]
    .sort(([left], [right]) => compareUtf16(left, right))
    .map(([_canonical, value]) => value);
}

function coalesceAdjacentCanonicalValues(values: DynamicValue[]): DynamicValue[] {
  const coalesced: DynamicValue[] = [];
  let previousCanonical: string | undefined;
  for (const value of values) {
    const canonical = canonicalJson(value);
    if (canonical !== previousCanonical) {
      coalesced.push(value);
      previousCanonical = canonical;
    }
  }
  return coalesced;
}

function rewriteContentStyle(
  value: DynamicValue,
  variableParagraphs: boolean,
  profileParagraphs = false,
  completedContextBaseColor?: string,
): DynamicValue {
  if (Array.isArray(value)) {
    return value.map((child) =>
      rewriteContentStyle(child, variableParagraphs, profileParagraphs, completedContextBaseColor),
    );
  }
  if (!value || typeof value !== "object") return value;
  const entries: Array<[string, DynamicValue]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (REWRITE_CONTENT_KEYS.has(key)) continue;
    if (key === "paragraphs" && Array.isArray(child)) {
      const paragraphProfiles = child.map((paragraph: DynamicValue) => {
        const paragraphStyle = Object.fromEntries(
          Object.entries(paragraph ?? {})
            .filter(
              ([paragraphKey]) =>
                paragraphKey !== "index" &&
                paragraphKey !== "runs" &&
                !REWRITE_CONTENT_KEYS.has(paragraphKey),
            )
            .map(([paragraphKey, paragraphValue]) => [
              paragraphKey,
              rewriteContentStyle(
                paragraphValue,
                variableParagraphs,
                profileParagraphs,
                completedContextBaseColor,
              ),
            ]),
        );
        const runStyles = (paragraph?.runs ?? [])
          .filter(
            (run: DynamicValue) => typeof run?.text !== "string" || run.text.trim().length > 0,
          )
          .map((run: DynamicValue) =>
            withoutArtifactAnchors(
              Object.fromEntries(
                Object.entries(run ?? {})
                  .filter(([runKey]) => runKey !== "index" && !REWRITE_CONTENT_KEYS.has(runKey))
                  .map(([runKey, runValue]) => [
                    runKey,
                    runKey === "color" &&
                    completedContextBaseColor &&
                    String(runValue).toUpperCase() === COMPLETED_EPIC_CONTEXT_COLOR
                      ? completedContextBaseColor
                      : rewriteContentStyle(
                          runValue,
                          variableParagraphs,
                          profileParagraphs,
                          completedContextBaseColor,
                        ),
                  ]),
              ),
            ),
          );
        return {
          paragraphStyle: withoutArtifactAnchors(paragraphStyle),
          runStyles: variableParagraphs ? coalesceAdjacentCanonicalValues(runStyles) : runStyles,
        };
      });
      if (profileParagraphs) {
        entries.push([
          "paragraphStyleProfiles",
          uniqueCanonicalValues(paragraphProfiles.map((profile) => profile.paragraphStyle)),
        ]);
        entries.push([
          "runStyleProfiles",
          uniqueCanonicalValues(paragraphProfiles.flatMap((profile) => profile.runStyles)),
        ]);
        continue;
      }
      entries.push([
        key,
        variableParagraphs ? uniqueCanonicalValues(paragraphProfiles) : paragraphProfiles,
      ]);
      continue;
    }
    entries.push([
      key,
      rewriteContentStyle(child, variableParagraphs, profileParagraphs, completedContextBaseColor),
    ]);
  }
  return Object.fromEntries(entries);
}

function protectedRewriteStyle(
  value: DynamicValue,
  ignoreOrder: boolean,
  variableParagraphs: boolean,
  profileParagraphs = false,
  completedContextBaseColor?: string,
): DynamicValue {
  if (value?.kind === "table" && Array.isArray(value.cells)) {
    const { cells, ...tableRest } = value;
    const artifactContract = ignoreOrder
      ? withoutArtifactElementMetadata(tableRest)
      : withoutArtifactAnchors(tableRest);
    const styleProfiles: Record<string, DynamicValue[]> = {
      top: [],
      area: [],
      body: [],
    };
    const protectedCells = cells.map((cell: DynamicValue) => {
      const { paragraphs = [], ...cellRest } = cell;
      const category = cell.row === 1 ? "top" : cell.column === 1 ? "area" : "body";
      const paragraphProfiles = rewriteContentStyle({ paragraphs }, true)?.paragraphs ?? [];
      styleProfiles[category].push(...paragraphProfiles);
      return withoutArtifactAnchors(rewriteContentStyle(cellRest, false));
    });
    return {
      ...rewriteContentStyle(artifactContract, false),
      cells: protectedCells,
      cellStyleProfiles: Object.fromEntries(
        Object.entries(styleProfiles).map(([category, profiles]) => [
          category,
          uniqueCanonicalValues(profiles),
        ]),
      ),
    };
  }
  const artifactContract = ignoreOrder
    ? withoutArtifactElementMetadata(value)
    : withoutArtifactAnchors(value);
  return rewriteContentStyle(
    artifactContract,
    variableParagraphs,
    profileParagraphs,
    completedContextBaseColor,
  );
}

function profiledParagraphRewriteContractMatches(
  starter: DynamicValue,
  final: DynamicValue,
  declaredRunStyles: DynamicValue[] = [],
  declaredParagraphStyles: DynamicValue[] = [],
): boolean {
  const {
    paragraphStyleProfiles: starterParagraphStyles = [],
    runStyleProfiles: starterRunStyles = [],
    ...starterRest
  } = starter ?? {};
  const {
    paragraphStyleProfiles: finalParagraphStyles = [],
    runStyleProfiles: finalRunStyles = [],
    ...finalRest
  } = final ?? {};
  if (canonicalJson(starterRest) !== canonicalJson(finalRest)) return false;
  const approvedParagraphStyles = new Set(
    [...starterParagraphStyles, ...declaredParagraphStyles].map((profile: DynamicValue) =>
      canonicalJson(profile),
    ),
  );
  const approvedRunStyles = new Set(
    [...starterRunStyles, ...declaredRunStyles].map((profile: DynamicValue) =>
      canonicalJson(profile),
    ),
  );
  return (
    finalParagraphStyles.length > 0 &&
    finalRunStyles.length > 0 &&
    finalParagraphStyles.every((profile: DynamicValue) =>
      approvedParagraphStyles.has(canonicalJson(profile)),
    ) &&
    finalRunStyles.every((profile: DynamicValue) => approvedRunStyles.has(canonicalJson(profile)))
  );
}

function runtimeTextStyleAsLayoutRunStyle(style: DynamicValue): DynamicValue {
  if (!style || typeof style !== "object") return {};
  const allowedKeys = new Set([
    "fontSize",
    "typeface",
    "bold",
    "italic",
    "underline",
    "strikethrough",
  ]);
  return Object.fromEntries(
    Object.entries(style)
      .filter(([key]) => allowedKeys.has(key) || key === "color")
      .map(([key, value]) => [
        key,
        key === "color" && typeof value === "string" && value.startsWith("#")
          ? value.toUpperCase()
          : value,
      ]),
  );
}

function runtimeOperationAsLayoutRunStyles(operation: DynamicValue): DynamicValue[] {
  const declared = [
    operation.textStyle,
    operation.labelStyle,
    operation.valueStyle,
    operation.detailStyle,
  ]
    .filter(Boolean)
    .map(runtimeTextStyleAsLayoutRunStyle);
  if (operation.textStyle && operation.linkTextStyle) {
    const effectiveLinkStyle = runtimeTextStyleAsLayoutRunStyle({
      ...operation.textStyle,
      ...operation.linkTextStyle,
    });
    if (operation.linkTextStyle.underline === true) delete effectiveLinkStyle.underline;
    declared.push(effectiveLinkStyle);
  }
  return declared;
}

function runtimeOperationAsLayoutParagraphStyle(operation: DynamicValue): DynamicValue {
  const paragraphStyle: DynamicValue =
    operation?.paragraphStyle &&
    typeof operation.paragraphStyle === "object" &&
    !Array.isArray(operation.paragraphStyle)
      ? { ...operation.paragraphStyle }
      : {};
  if (
    Number.isFinite(operation?.textFrameStyle?.lineSpacing) &&
    paragraphStyle.lineSpacingPercent === undefined
  ) {
    paragraphStyle.lineSpacingPercent = Math.round(
      Number(operation.textFrameStyle.lineSpacing) * 100_000,
    );
  }
  if (typeof operation?.textFrameStyle?.alignment === "string") {
    paragraphStyle.resolvedTextStyle = {
      alignment: operation.textFrameStyle.alignment,
    };
  }
  return paragraphStyle;
}

function runtimeOperationAsLayoutTextFrameStyle(operation: DynamicValue): DynamicValue | undefined {
  const verticalAlignment = operation?.textFrameStyle?.verticalAlignment;
  if (verticalAlignment === undefined) return undefined;
  const anchorByVerticalAlignment: Record<string, number> = {
    top: 1,
    middle: 2,
    bottom: 3,
  };
  if (typeof verticalAlignment !== "string" || !(verticalAlignment in anchorByVerticalAlignment)) {
    throw new Error(`Unsupported text-frame vertical alignment ${String(verticalAlignment)}`);
  }
  return {
    anchor: anchorByVerticalAlignment[verticalAlignment],
    verticalAlignment,
  };
}

function withoutDeclaredLayoutTextFrameStyle(
  value: DynamicValue,
  declaredStyle: DynamicValue | undefined,
): DynamicValue {
  if (!declaredStyle || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = structuredClone(value);
  if (!normalized.resolvedTextStyle || typeof normalized.resolvedTextStyle !== "object") {
    return normalized;
  }
  for (const key of Object.keys(declaredStyle)) delete normalized.resolvedTextStyle[key];
  if (Object.keys(normalized.resolvedTextStyle).length === 0) {
    delete normalized.resolvedTextStyle;
  }
  return normalized;
}

function assertDeclaredLayoutTextFrameStyle(
  element: DynamicValue,
  declaredStyle: DynamicValue | undefined,
  label: string,
): void {
  if (!declaredStyle) return;
  const actualStyle = element?.resolvedTextStyle;
  for (const [key, expected] of Object.entries(declaredStyle)) {
    if (actualStyle?.[key] !== expected) {
      throw new Error(`${label} does not match its declared text-frame ${key}`);
    }
  }
}

function tableRewriteContractMatches(starter: DynamicValue, final: DynamicValue): boolean {
  const { cellStyleProfiles: starterProfiles = {}, ...starterRest } = starter ?? {};
  const { cellStyleProfiles: finalProfiles = {}, ...finalRest } = final ?? {};
  if (canonicalJson(starterRest) !== canonicalJson(finalRest)) return false;
  return ["top", "area", "body"].every((category) => {
    const approved = new Set(
      (starterProfiles[category] ?? []).map((profile: DynamicValue) => canonicalJson(profile)),
    );
    return (finalProfiles[category] ?? []).every((profile: DynamicValue) =>
      approved.has(canonicalJson(profile)),
    );
  });
}

function layoutElementsByIdentity(layout: DynamicValue): Map<string, DynamicValue> {
  const elements = Array.isArray(layout?.elements) ? layout.elements : [];
  const byIdentity = new Map<string, DynamicValue>();
  for (const element of elements) {
    const identity = String(element?.name ?? element?.id ?? "");
    if (!identity) throw new Error("Template layout contains an element without an identity");
    if (byIdentity.has(identity)) {
      throw new Error(`Template layout duplicates element identity ${identity}`);
    }
    byIdentity.set(identity, element);
  }
  return byIdentity;
}

function layoutElementText(element: DynamicValue): string {
  const paragraphText = Array.isArray(element?.paragraphs)
    ? element.paragraphs
        .map((paragraph: DynamicValue) => paragraph?.text)
        .filter((value: DynamicValue) => typeof value === "string")
    : [];
  const value = paragraphText.length > 0 ? paragraphText.join("\n") : element?.text;
  return typeof value === "string" ? value.replace(/\r\n?/gu, "\n") : "";
}

function bboxCenterIsInside(inner: DynamicValue, outer: DynamicValue): boolean {
  if (
    !Array.isArray(inner) ||
    !Array.isArray(outer) ||
    inner.length !== 4 ||
    outer.length !== 4 ||
    [...inner, ...outer].some((value) => !Number.isFinite(Number(value)))
  ) {
    return false;
  }
  const centerX = Number(inner[0]) + Number(inner[2]) / 2;
  const centerY = Number(inner[1]) + Number(inner[3]) / 2;
  return (
    centerX >= Number(outer[0]) &&
    centerX <= Number(outer[0]) + Number(outer[2]) &&
    centerY >= Number(outer[1]) &&
    centerY <= Number(outer[1]) + Number(outer[3])
  );
}

function bboxesOverlap(left: DynamicValue, right: DynamicValue): boolean {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== 4 ||
    right.length !== 4 ||
    [...left, ...right].some((value) => !Number.isFinite(Number(value)))
  ) {
    return false;
  }
  return (
    Number(left[0]) < Number(right[0]) + Number(right[2]) &&
    Number(left[0]) + Number(left[2]) > Number(right[0]) &&
    Number(left[1]) < Number(right[1]) + Number(right[3]) &&
    Number(left[1]) + Number(left[3]) > Number(right[1])
  );
}

function bboxesOverlapVertically(left: DynamicValue, right: DynamicValue): boolean {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== 4 ||
    right.length !== 4 ||
    [...left, ...right].some((value) => !Number.isFinite(Number(value)))
  ) {
    return false;
  }
  return (
    Number(left[1]) < Number(right[1]) + Number(right[3]) &&
    Number(left[1]) + Number(left[3]) > Number(right[1])
  );
}

/** Verifies the inspected green label rail and its relative left-of-row placement. */
export function validateWeeklyMilestoneRowLayout(
  layout: DynamicValue,
  contract: DynamicValue,
  label: string,
): void {
  const elements = layoutElementsByIdentity(layout);
  const rowTopPositions: number[] = [];
  for (const rowIndex of [0, 1, 2]) {
    const operations = Object.fromEntries(
      ["label", "updates", "risks"].map((kind) => [
        kind,
        contract.milestoneRowOperations.find(
          (operation: DynamicValue) => operation.rowIndex === rowIndex && operation.kind === kind,
        ),
      ]),
    );
    const labelOperation = operations.label;
    const labelElement = elements.get(labelOperation?.target?.name);
    const updatesElement = elements.get(operations.updates?.target?.name);
    const risksElement = elements.get(operations.risks?.target?.name);
    if (!labelElement || !updatesElement || !risksElement) {
      throw new Error(`${label} lacks all three inspected targets for weekly row ${rowIndex + 1}`);
    }
    const labelBox = labelElement.bbox;
    const updatesBox = updatesElement.bbox;
    const risksBox = risksElement.bbox;
    if (
      ![labelBox, updatesBox, risksBox].every(
        (bbox) =>
          Array.isArray(bbox) &&
          bbox.length === 4 &&
          bbox.every((value: DynamicValue) => Number.isFinite(Number(value))),
      )
    ) {
      throw new Error(`${label} weekly row ${rowIndex + 1} lacks inspected geometry`);
    }
    const labelRight = Number(labelBox[0]) + Number(labelBox[2]);
    const leftOfBothContentColumns =
      labelRight <= Math.min(Number(updatesBox[0]), Number(risksBox[0])) + 0.02;
    if (
      !leftOfBothContentColumns ||
      !bboxesOverlapVertically(labelBox, updatesBox) ||
      !bboxesOverlapVertically(labelBox, risksBox)
    ) {
      throw new Error(
        `${label} weekly row ${rowIndex + 1} must keep its milestone label left of and aligned with Updates and Risks / Blockers`,
      );
    }
    const inspectedFill = String(labelElement.fillColor ?? "").toUpperCase();
    const declaredFill = String(labelOperation.fillColor ?? "").toUpperCase();
    const usesTemplateGreenThemeToken =
      inspectedFill === "ACCENT1" && declaredFill === WEEKLY_MILESTONE_LABEL_FILL_COLOR;
    if (inspectedFill !== declaredFill && !usesTemplateGreenThemeToken) {
      throw new Error(
        `${label} weekly row ${rowIndex + 1} milestone label changes its inspected green fill`,
      );
    }
    rowTopPositions.push(Number(labelBox[1]));
  }
  if (rowTopPositions.some((top, index) => index > 0 && top <= rowTopPositions[index - 1])) {
    throw new Error(`${label} weekly milestone labels do not preserve top-to-bottom row order`);
  }
}

type CapabilityLayoutStructure = Omit<CapabilityStructureInventory, "table"> & {
  table: Omit<CapabilityStructureInventory["table"], "dividers">;
};

function capabilityLayoutStructureFromLayout(
  layout: DynamicValue,
  contract: DynamicValue,
  targetCount: number,
): CapabilityLayoutStructure {
  const operations = capabilityMilestoneTitleOperations(contract);
  const elements = layoutElementsByIdentity(layout);
  const table = elements.get(contract.table.target?.name);
  const topRow = Number(contract.table.topRow) + 1;
  const firstMilestoneColumn = Number(contract.table.firstMilestoneColumn);
  const cells = Array.isArray(table?.cells) ? table.cells : [];
  const topCells = cells
    .filter((cell: DynamicValue) => Number(cell.row) === topRow)
    .sort((left: DynamicValue, right: DynamicValue) => Number(left.column) - Number(right.column));
  const milestoneTargets = operations.slice(0, targetCount).flatMap((operation, index) => {
    const target = elements.get(operation.target.name);
    if (!target) return [];
    const tableColumnIndex = firstMilestoneColumn + index;
    const cell = topCells.find(
      (candidate: DynamicValue) => Number(candidate.column) === tableColumnIndex + 1,
    );
    const geometry = String(target.geometry ?? "");
    return [
      {
        tableColumnIndex,
        text: layoutElementText(target),
        shapeType: geometry === "homePlate" ? "HOME_PLATE" : geometry.toUpperCase(),
        inTopRowCell: bboxCenterIsInside(target.bbox, cell?.bbox),
      },
    ];
  });
  const usedTargetNames = new Set(
    operations.slice(0, targetCount).map((operation) => String(operation.target.name)),
  );
  const milestoneTopCells = topCells.filter((cell: DynamicValue) => {
    const columnIndex = Number(cell.column) - 1;
    return (
      columnIndex >= firstMilestoneColumn &&
      columnIndex < firstMilestoneColumn + Number(contract.table.milestoneColumnCount)
    );
  });
  const unusedTopRowMilestoneTargetCount = [...elements].filter(
    ([identity, element]) =>
      element?.geometry === "homePlate" &&
      !usedTargetNames.has(identity) &&
      milestoneTopCells.some((cell: DynamicValue) => bboxesOverlap(element.bbox, cell.bbox)),
  ).length;
  const unusedBodyCellNonemptyCount = cells.filter((cell: DynamicValue) => {
    const columnIndex = Number(cell.column) - 1;
    return (
      Number(cell.row) > topRow &&
      columnIndex >= firstMilestoneColumn + targetCount &&
      columnIndex < firstMilestoneColumn + Number(contract.table.milestoneColumnCount) &&
      layoutElementText(cell).trim().length > 0
    );
  }).length;
  const tableBottom =
    Array.isArray(table?.bbox) && table.bbox.length === 4
      ? Number(table.bbox[1]) + Number(table.bbox[3])
      : Number.NaN;
  const normalizeMilestoneText = (value: string): string =>
    value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  const declaredMilestoneTargetText = new Set(
    operations.flatMap((operation) => {
      const text = normalizeMilestoneText(layoutElementText(elements.get(operation.target.name)));
      return text.length > 0 ? [text] : [];
    }),
  );
  const bottomMilestoneTargetCount = [...elements.values()].filter((element) => {
    const elementText = normalizeMilestoneText(layoutElementText(element));
    return (
      Array.isArray(element.bbox) &&
      Number.isFinite(tableBottom) &&
      Number(element.bbox[1]) >= tableBottom - 1 &&
      (element?.geometry === "homePlate" ||
        (elementText.length > 0 &&
          [...declaredMilestoneTargetText].some((targetText) => elementText.includes(targetText))))
    );
  }).length;
  return {
    table: {
      rowCount: Number.isInteger(table?.rows) ? Number(table.rows) : 0,
      columnCount: Number.isInteger(table?.cols) ? Number(table.cols) : 0,
      topRowText: topCells.map(layoutElementText),
    },
    milestoneTargets,
    unusedTopRowMilestoneTargetCount,
    unusedBodyCellNonemptyCount,
    bottomMilestoneTargetCount,
  };
}

export function capabilityStructureInventoryFromLayout(
  layout: DynamicValue,
  contract: DynamicValue,
  slideModel: DynamicValue,
  dividers: CapabilityStructureInventory["table"]["dividers"],
): CapabilityStructureInventory {
  const structure = capabilityLayoutStructureFromLayout(
    layout,
    contract,
    Array.isArray(slideModel?.columns) ? slideModel.columns.length : 0,
  );
  return { ...structure, table: { ...structure.table, dividers } };
}

function normalizedLayoutColor(value: DynamicValue, layout?: DynamicValue): string {
  if (typeof value !== "string" || value.length === 0) return "#MISSING";
  const themeColor = layout?.theme?.colors?.[value];
  if (typeof themeColor === "string" && themeColor.length > 0) {
    return normalizedLayoutColor(themeColor);
  }
  return value.startsWith("#") ? value.toUpperCase() : `#${value.toUpperCase()}`;
}

function layoutElementTextColor(element: DynamicValue, layout: DynamicValue): string {
  const paragraphRuns = Array.isArray(element?.paragraphs)
    ? element.paragraphs.flatMap((paragraph: DynamicValue) => paragraph?.runs ?? [])
    : [];
  const visibleRun = paragraphRuns.find(
    (run: DynamicValue) => typeof run?.text === "string" && run.text.length > 0,
  );
  return normalizedLayoutColor(visibleRun?.color ?? element?.resolvedTextStyle?.color, layout);
}

function nativeBulletParagraphInventory(shapeXml: string): Array<{
  text: string;
  bulletCharacter: string;
}> {
  return (shapeXml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? []).map((paragraph) => {
    const properties = /<a:pPr\b[\s\S]*?<\/a:pPr>/u.exec(paragraph)?.[0] ?? "";
    const bullet = /<a:buChar\s+char="([^"]+)"\s*\/>/u.exec(properties)?.[1] ?? "";
    const text = (paragraph.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu) ?? [])
      .map((textXml) =>
        decodeXmlText(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/u.exec(textXml)?.[1] ?? ""),
      )
      .join("");
    return { text, bulletCharacter: decodeXmlText(bullet) };
  });
}

/** Derives weekly row placement, styling, and bullet semantics from the final artifact. */
export function weeklyMilestoneStructureInventoryFromLayoutAndSlideXml(
  layout: DynamicValue,
  slideXml: string,
  contract: DynamicValue,
  slideModel: DynamicValue,
): WeeklyMilestoneStructureInventory {
  validateWeeklyMilestoneRowLayout(layout, contract, "PowerPoint artifact");
  validateWeeklyMilestoneParagraphsFromSlideXml(
    slideXml,
    contract.milestoneRowOperations,
    slideModel,
  );
  const elements = layoutElementsByIdentity(layout);
  const shapeBlocks = [...slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map((match) => match[0]);
  return {
    rows: slideModel.milestoneRows.map((_row: DynamicValue, rowIndex: number) => {
      const operation = (kind: string): DynamicValue =>
        contract.milestoneRowOperations.find(
          (candidate: DynamicValue) => candidate.rowIndex === rowIndex && candidate.kind === kind,
        );
      const labelOperation = operation("label");
      const updatesOperation = operation("updates");
      const risksOperation = operation("risks");
      const labelElement = elements.get(labelOperation.target.name);
      const updatesElement = elements.get(updatesOperation.target.name);
      const risksElement = elements.get(risksOperation.target.name);
      const labelRight = Number(labelElement.bbox[0]) + Number(labelElement.bbox[2]);
      const labelIsLeftOfContent =
        labelRight <= Math.min(Number(updatesElement.bbox[0]), Number(risksElement.bbox[0])) + 0.02;
      const shapeFor = (rowOperation: DynamicValue): string => {
        const matches = shapeBlocks.filter(
          (shape) => shapeBlockName(shape) === rowOperation.target.name,
        );
        if (matches.length !== 1) {
          throw new Error(
            `PowerPoint weekly target ${rowOperation.target.name} resolved to ${matches.length} shapes`,
          );
        }
        return matches[0];
      };
      return {
        rowIndex,
        title: layoutElementText(labelElement),
        labelFillColor: normalizedLayoutColor(labelElement.fillColor, layout),
        labelTextColor: layoutElementTextColor(labelElement, layout),
        labelIsLeftOfContent,
        updates: nativeBulletParagraphInventory(shapeFor(updatesOperation)),
        risks: nativeBulletParagraphInventory(shapeFor(risksOperation)),
      };
    }),
  };
}

function assertCapabilityTopRowLayout(
  layout: DynamicValue,
  contract: DynamicValue,
  targetCount: number,
  label: string,
): void {
  const structure = capabilityLayoutStructureFromLayout(layout, contract, targetCount);
  const expectedColumns = Array.from({ length: targetCount }, (_value, index) => index + 1);
  if (
    structure.table.rowCount !== 5 ||
    structure.table.columnCount !== 4 ||
    JSON.stringify(structure.table.topRowText) !== JSON.stringify(["", "", "", ""]) ||
    JSON.stringify(structure.milestoneTargets.map((target) => target.tableColumnIndex)) !==
      JSON.stringify(expectedColumns) ||
    structure.milestoneTargets.some(
      (target) => target.shapeType !== "HOME_PLATE" || !target.inTopRowCell,
    ) ||
    structure.unusedTopRowMilestoneTargetCount !== 0 ||
    structure.unusedBodyCellNonemptyCount !== 0 ||
    structure.bottomMilestoneTargetCount !== 0
  ) {
    throw new Error(
      `${label} must preserve one native 5×4 table with four blank top-row cells, aligned used HOME_PLATE targets, no unused top-row targets, empty unused body cells, and no bottom milestone labels`,
    );
  }
}

export async function validateTemplateLayoutFidelity({
  frameMap,
  model,
  roleMap,
  starterLayoutDir,
  finalLayoutDir,
}: {
  frameMap: DynamicValue;
  model: DynamicValue;
  roleMap: DynamicValue;
  starterLayoutDir: string;
  finalLayoutDir: string;
}): Promise<void> {
  for (const entry of frameMap.outputSlides) {
    const padded = String(entry.outputSlide).padStart(2, "0");
    const [starter, final] = await Promise.all([
      fs
        .readFile(path.join(starterLayoutDir, `starter-slide-${padded}.layout.json`), "utf8")
        .then(JSON.parse),
      fs
        .readFile(path.join(finalLayoutDir, `final-slide-${padded}.layout.json`), "utf8")
        .then(JSON.parse),
    ]);
    if (
      canonicalJson(withoutArtifactAnchors(starter.inheritedLayers ?? [])) !==
      canonicalJson(withoutArtifactAnchors(final.inheritedLayers ?? []))
    ) {
      throw new Error(
        `Final slide ${entry.outputSlide} changes its template master or layout hierarchy`,
      );
    }
    const starterElements = layoutElementsByIdentity(starter);
    const finalElements = layoutElementsByIdentity(final);
    const rewriteNames = new Set(
      entry.editTargets
        .filter((target: DynamicValue) => target.action === "rewrite")
        .flatMap((target: DynamicValue) => frameMapTargetNames(target)),
    );
    const roleContract = roleMap.roles?.[entry.narrativeRole];
    const entryModelSlide = model.slides.find(
      (slide: DynamicValue) =>
        slide.role === entry.narrativeRole &&
        (entry.instanceId ? slide.instanceId === entry.instanceId : !slide.instanceId),
    );
    if (
      entry.narrativeRole === "roadmap-capability" &&
      roleContract?.table?.target &&
      entryModelSlide
    ) {
      assertCapabilityTopRowLayout(
        starter,
        roleContract,
        Number(roleContract.table.milestoneColumnCount),
        `Starter slide ${entry.outputSlide}`,
      );
      assertCapabilityTopRowLayout(
        final,
        roleContract,
        Array.isArray(entryModelSlide.columns) ? entryModelSlide.columns.length : 0,
        `Final slide ${entry.outputSlide}`,
      );
    }
    if (
      entry.narrativeRole === "weekly-release" &&
      Array.isArray(roleContract?.milestoneRowOperations) &&
      roleContract.milestoneRowOperations.length === 9
    ) {
      validateWeeklyMilestoneRowLayout(starter, roleContract, `Starter slide ${entry.outputSlide}`);
      validateWeeklyMilestoneRowLayout(final, roleContract, `Final slide ${entry.outputSlide}`);
    }
    const repositionNames = new Set(
      entry.editTargets
        .filter((target: DynamicValue) => target.action === "rewrite-and-reposition")
        .flatMap((target: DynamicValue) => frameMapTargetNames(target)),
    );
    const geometryByName = new Map<string, DynamicValue>(
      (roleContract?.geometryOperations ?? [])
        .filter((operation: DynamicValue) => typeof operation.target?.name === "string")
        .map((operation: DynamicValue) => [operation.target.name, operation.positionEmu]),
    );
    const variableParagraphNames = new Set<string>(
      [
        roleContract?.outcomeListOperations,
        (roleContract?.milestoneRowOperations ?? []).filter(
          (operation: DynamicValue) => operation.kind === "updates" || operation.kind === "risks",
        ),
      ]
        .flatMap((operations) => operations ?? [])
        .map((operation: DynamicValue) => operation.target?.name)
        .filter((name: DynamicValue) => typeof name === "string"),
    );
    const completedContextBaseColorByName = new Map<string, string>(
      [roleContract?.outcomeOperations, roleContract?.outcomeListOperations]
        .flatMap((operations) => operations ?? [])
        .filter(
          (operation: DynamicValue) =>
            typeof operation.target?.name === "string" &&
            /^#[0-9A-Fa-f]{6}$/u.test(operation.textStyle?.color),
        )
        .map((operation: DynamicValue) => [
          operation.target.name,
          String(operation.textStyle.color).toUpperCase(),
        ]),
    );
    const profiledParagraphOperations = [
      ...(roleContract?.operations ?? []).filter((operation: DynamicValue) => operation.textStyle),
      ...(roleContract?.metricOperations ?? []).filter(
        (operation: DynamicValue) => operation.kind === "momentum",
      ),
      ...(roleContract?.milestoneRowOperations ?? []).filter(
        (operation: DynamicValue) => operation.textStyle,
      ),
    ];
    const declaredRunStylesByName = new Map<string, DynamicValue[]>(
      profiledParagraphOperations
        .filter((operation: DynamicValue) => typeof operation.target?.name === "string")
        .map((operation: DynamicValue) => [
          operation.target.name,
          runtimeOperationAsLayoutRunStyles(operation),
        ]),
    );
    const declaredParagraphStylesByName = new Map<string, DynamicValue[]>(
      profiledParagraphOperations
        .filter((operation: DynamicValue) => typeof operation.target?.name === "string")
        .map((operation: DynamicValue) => [
          operation.target.name,
          [runtimeOperationAsLayoutParagraphStyle(operation)],
        ]),
    );
    const declaredTextFrameStylesByName = new Map<string, DynamicValue>();
    for (const operation of profiledParagraphOperations) {
      if (typeof operation.target?.name !== "string") continue;
      const declaredTextFrameStyle = runtimeOperationAsLayoutTextFrameStyle(operation);
      if (declaredTextFrameStyle) {
        declaredTextFrameStylesByName.set(operation.target.name, declaredTextFrameStyle);
      }
    }
    const profiledParagraphNames = new Set(declaredRunStylesByName.keys());
    const deleteNames = new Set(
      entry.editTargets
        .filter((target: DynamicValue) => target.action === "delete")
        .flatMap((target: DynamicValue) => frameMapTargetNames(target)),
    );
    const protectedNames = new Set(
      [...starterElements.keys()].filter((identity) => !deleteNames.has(identity)),
    );
    const protectedOrder = (elements: Map<string, DynamicValue>): string[] =>
      [...elements]
        .filter(([identity]) => protectedNames.has(identity))
        .sort(
          ([leftIdentity, left], [rightIdentity, right]) =>
            Number(left.order) - Number(right.order) || compareUtf16(leftIdentity, rightIdentity),
        )
        .map(([identity]) => identity);
    if (
      JSON.stringify(protectedOrder(starterElements)) !==
      JSON.stringify(protectedOrder(finalElements))
    ) {
      throw new Error(`Final slide ${entry.outputSlide} reorders protected source objects`);
    }
    const includeClassificationWarning = (entryModelSlide?.unclassified?.length ?? 0) > 0;
    const addedNames = new Set<string>(
      entry.editTargets
        .filter((target: DynamicValue) => target.action === "add")
        .flatMap((target: DynamicValue) => [target.contentId, ...(target.contentIds ?? [])])
        .filter((contentId: DynamicValue) => typeof contentId === "string")
        .filter(
          (contentId: string) =>
            contentId !== "matrix-needs-classification" || includeClassificationWarning,
        )
        .map((contentId: string) => `nemoclaw:${contentId}`),
    );
    const changesElementOrder = entry.editTargets.some(
      (target: DynamicValue) => target.action === "add" || target.action === "delete",
    );
    for (const [identity, starterElement] of starterElements) {
      const finalElement = finalElements.get(identity);
      if (deleteNames.has(identity)) {
        if (finalElement) {
          throw new Error(
            `Final slide ${entry.outputSlide} retains deleted source object ${identity}`,
          );
        }
        continue;
      }
      if (!finalElement) {
        throw new Error(
          `Final slide ${entry.outputSlide} deleted protected source object ${identity}`,
        );
      }
      let starterContract = rewriteNames.has(identity)
        ? protectedRewriteStyle(
            starterElement,
            changesElementOrder,
            variableParagraphNames.has(identity),
            profiledParagraphNames.has(identity),
            completedContextBaseColorByName.get(identity),
          )
        : changesElementOrder
          ? withoutArtifactElementMetadata(starterElement)
          : withoutArtifactAnchors(starterElement);
      let finalContract = rewriteNames.has(identity)
        ? protectedRewriteStyle(
            finalElement,
            changesElementOrder,
            variableParagraphNames.has(identity),
            profiledParagraphNames.has(identity),
            completedContextBaseColorByName.get(identity),
          )
        : changesElementOrder
          ? withoutArtifactElementMetadata(finalElement)
          : withoutArtifactAnchors(finalElement);
      if (repositionNames.has(identity)) {
        starterContract = withoutTopLevelElementGeometry(starterContract);
        finalContract = withoutTopLevelElementGeometry(finalContract);
        assertLayoutGeometryMatchesEmu(
          finalElement,
          geometryByName.get(identity),
          `Final slide ${entry.outputSlide} object ${identity}`,
        );
      }
      const declaredTextFrameStyle = declaredTextFrameStylesByName.get(identity);
      if (declaredTextFrameStyle) {
        assertDeclaredLayoutTextFrameStyle(
          finalElement,
          declaredTextFrameStyle,
          `Final slide ${entry.outputSlide} object ${identity}`,
        );
        starterContract = withoutDeclaredLayoutTextFrameStyle(
          starterContract,
          declaredTextFrameStyle,
        );
        finalContract = withoutDeclaredLayoutTextFrameStyle(finalContract, declaredTextFrameStyle);
      }
      const rewriteTable = rewriteNames.has(identity) && starterElement.kind === "table";
      const contractsMatch = rewriteTable
        ? tableRewriteContractMatches(starterContract, finalContract)
        : profiledParagraphNames.has(identity)
          ? profiledParagraphRewriteContractMatches(
              starterContract,
              finalContract,
              declaredRunStylesByName.get(identity),
              declaredParagraphStylesByName.get(identity),
            )
          : canonicalJson(starterContract) === canonicalJson(finalContract);
      if (!contractsMatch) {
        throw new Error(
          `Final slide ${entry.outputSlide} changes protected source object ${identity}`,
        );
      }
    }
    for (const identity of finalElements.keys()) {
      if (!starterElements.has(identity) && !addedNames.has(identity)) {
        throw new Error(`Final slide ${entry.outputSlide} adds unauthorized object ${identity}`);
      }
    }
    for (const addedName of addedNames) {
      if (!finalElements.has(addedName)) {
        throw new Error(`Final slide ${entry.outputSlide} lacks authorized object ${addedName}`);
      }
    }
    const nodeOrders = [...finalElements]
      .filter(([identity]) => identity.startsWith("nemoclaw:node."))
      .map(([_identity, element]) => Number(element.order));
    const connectorOrders = [...finalElements]
      .filter(
        ([identity]) => identity.startsWith("nemoclaw:connector.") && !identity.endsWith(":label"),
      )
      .map(([_identity, element]) => Number(element.order));
    if (
      nodeOrders.length > 0 &&
      (connectorOrders.length === 0 ||
        [...nodeOrders, ...connectorOrders].some((order) => !Number.isFinite(order)) ||
        Math.max(...connectorOrders) >= Math.min(...nodeOrders))
    ) {
      throw new Error(`Final slide ${entry.outputSlide} places connectors above entity nodes`);
    }
  }
}

async function exportFinalTemplateLayouts(
  presentation: DynamicValue,
  finalLayoutDir: string,
): Promise<void> {
  await fs.mkdir(finalLayoutDir, { recursive: false, mode: 0o700 });
  for (const [index, slide] of presentation.slides.items.entries()) {
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(
      path.join(finalLayoutDir, `final-slide-${String(index + 1).padStart(2, "0")}.layout.json`),
      await layout.text(),
      { flag: "wx", mode: 0o600 },
    );
  }
}

export async function createTemplateFidelityStarterComparisonLayouts({
  frameMap,
  starterLayoutDir,
  finalLayoutDir,
  comparisonLayoutDir,
}: {
  frameMap: DynamicValue;
  starterLayoutDir: string;
  finalLayoutDir: string;
  comparisonLayoutDir: string;
}): Promise<void> {
  await fs.mkdir(comparisonLayoutDir, { recursive: false, mode: 0o700 });
  for (const entry of frameMap.outputSlides) {
    const padded = String(entry.outputSlide).padStart(2, "0");
    const fileName = `starter-slide-${padded}.layout.json`;
    const [starter, final] = await Promise.all([
      fs.readFile(path.join(starterLayoutDir, fileName), "utf8").then(JSON.parse),
      fs
        .readFile(path.join(finalLayoutDir, `final-slide-${padded}.layout.json`), "utf8")
        .then(JSON.parse),
    ]);
    const comparison = structuredClone(starter);
    const comparisonElements = layoutElementsByIdentity(comparison);
    const finalElements = layoutElementsByIdentity(final);
    const repositionNames = entry.editTargets
      .filter((target: DynamicValue) => target.action === "rewrite-and-reposition")
      .flatMap((target: DynamicValue) => frameMapTargetNames(target));
    for (const identity of repositionNames) {
      const comparisonElement = comparisonElements.get(identity);
      const finalElement = finalElements.get(identity);
      if (
        !comparisonElement ||
        !finalElement ||
        !Array.isArray(finalElement.bbox) ||
        finalElement.bbox.length !== 4 ||
        !finalElement.bbox.every((value: DynamicValue) => Number.isFinite(value))
      ) {
        throw new Error(
          `Template fidelity comparison cannot resolve authorized reposition target ${identity}`,
        );
      }
      comparisonElement.bbox = structuredClone(finalElement.bbox);
    }
    await fs.writeFile(path.join(comparisonLayoutDir, fileName), JSON.stringify(comparison), {
      flag: "wx",
      mode: 0o600,
    });
  }
}

async function runTemplateFidelityCheck({
  runtime,
  workflow,
  frozenInputs,
  frameMap,
  finalPptx,
  authoringSurface,
}: {
  runtime: PresentationRuntimePaths;
  workflow: TemplateWorkflowPaths;
  frozenInputs: FrozenPptxAuthoringInputs;
  frameMap: DynamicValue;
  finalPptx: string;
  authoringSurface: TemporaryAuthoringSurface;
}): Promise<void> {
  const comparisonLayoutDir = path.join(workflow.workspace, "template-fidelity-starter-layout");
  await createTemplateFidelityStarterComparisonLayouts({
    frameMap,
    starterLayoutDir: workflow.starterLayoutDir,
    finalLayoutDir: workflow.finalLayoutDir,
    comparisonLayoutDir,
  });
  await runRuntimeProcess(
    runtime.runtimeNode,
    [
      path.join(runtime.skillDir, "template_following_scripts", "check_template_fidelity.mjs"),
      "--workspace",
      workflow.workspace,
      "--final-pptx",
      finalPptx,
      "--map",
      frozenInputs.frameMapPath,
      "--starter-pptx",
      workflow.starterPptx,
      "--starter-layout-dir",
      comparisonLayoutDir,
      "--final-layout-dir",
      workflow.finalLayoutDir,
      "--edit-dir",
      authoringSurface.directory,
    ],
    runtimeChildEnvironment(runtime),
  );
}

export async function runTemplateFidelityWorkflow({
  runtime,
  workflow,
  frozenInputs,
  frameMap,
  model,
  roleMap,
  finalPptx,
  authoringSurface,
}: {
  runtime: PresentationRuntimePaths;
  workflow: TemplateWorkflowPaths;
  frozenInputs: FrozenPptxAuthoringInputs;
  frameMap: DynamicValue;
  model: DynamicValue;
  roleMap: DynamicValue;
  finalPptx: string;
  authoringSurface: TemporaryAuthoringSurface;
}): Promise<void> {
  await validateTemplateLayoutFidelity({
    frameMap,
    model,
    roleMap,
    starterLayoutDir: workflow.starterLayoutDir,
    finalLayoutDir: workflow.finalLayoutDir,
  });
  await runTemplateFidelityCheck({
    runtime,
    workflow,
    frozenInputs,
    frameMap,
    finalPptx,
    authoringSurface,
  });
}

function sha256Bytes(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function modelHashInput(value: DynamicValue): DynamicValue {
  if (Array.isArray(value)) return value.map(modelHashInput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "managedNotes" && key !== "modelSha256")
      .map(([key, child]) => [key, modelHashInput(child)]),
  );
}

function verifyModel(model: DynamicValue, mode: ValidationMode): void {
  if (model.kind !== "nemoclaw-product-slides" || model.schemaVersion !== 1) {
    throw new Error("Input is not a NemoClaw product-slide model");
  }
  if (canonicalSha256(modelHashInput(model)) !== model.modelSha256) {
    throw new Error("Slide model hash mismatch");
  }
  const slides = model.slides as DynamicValue[];
  const singletonRoles = slides.slice(-2).map((slide) => slide.role);
  const roadmapSlides = slides.slice(0, -2);
  if (
    roadmapSlides.length < 2 ||
    roadmapSlides.length % 2 !== 0 ||
    JSON.stringify(singletonRoles) !== JSON.stringify(["markitecture", "weekly-release"])
  ) {
    throw new Error("Slide model roles are missing or out of order");
  }
  for (let index = 0; index < roadmapSlides.length; index += 2) {
    const pageIndex = index / 2 + 1;
    const executive = roadmapSlides[index];
    const capability = roadmapSlides[index + 1];
    if (
      executive.role !== "roadmap-executive" ||
      capability.role !== "roadmap-capability" ||
      executive.instanceId !== `roadmap-executive.${pageIndex}` ||
      capability.instanceId !== `roadmap-capability.${pageIndex}` ||
      executive.pageIndex !== pageIndex ||
      capability.pageIndex !== pageIndex ||
      executive.pageCount !== roadmapSlides.length / 2 ||
      capability.pageCount !== roadmapSlides.length / 2
    ) {
      throw new Error("Slide model roadmap page instances are missing or out of order");
    }
  }
  if (mode === "publish" && model.publication?.eligible !== true) {
    throw new Error("Publication requires an eligible shared model");
  }
}

function validDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validUri(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function validatePptxModel(
  model: DynamicValue,
  schema: DynamicValue,
  mode: ValidationMode = "preview",
): void {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: {
      "date-time": { type: "string", validate: validDateTime },
      uri: { type: "string", validate: validUri },
    },
  });
  const validate = ajv.compile(schema);
  if (!validate(model)) {
    const details = (validate.errors ?? [])
      .map(
        (error) =>
          `${error.instancePath || "/"} [${error.keyword}] ${error.message ?? "is invalid"}`,
      )
      .join("; ");
    throw new Error(`Slide model schema validation failed: ${details}`);
  }
  verifyModel(model, mode);
  const semantic = validateSlideModel(model, schema, mode);
  if (!semantic.valid) {
    const details = semantic.errors
      .slice(0, 5)
      .map((error) => `${error.code}: ${error.message}`)
      .join("; ");
    throw new Error(`Slide model semantic validation failed: ${details}`);
  }
}

function getPath(value: DynamicValue, dottedPath: string): DynamicValue {
  if (!dottedPath) return undefined;
  return dottedPath.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    const key = /^\d+$/u.test(segment) ? Number(segment) : segment;
    return current[key];
  }, value);
}

function textValue(value: DynamicValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textValue).join("\n");
  return String(value);
}

function elementName(element: DynamicValue): DynamicValue {
  return element?.name ?? element?.data?.name ?? element?.toProto?.()?.name;
}

function resolveTarget(
  presentation: DynamicValue,
  slide: DynamicValue,
  target: DynamicValue,
): DynamicValue {
  if (!target || typeof target !== "object") throw new Error("Runtime edit target is missing");
  if (target.anchorId) return presentation.resolve(target.anchorId);
  if (target.name) {
    const matches = slide.elements.items.filter(
      (element: DynamicValue) => elementName(element) === target.name,
    );
    if (matches.length !== 1) {
      throw new Error(`Runtime target ${target.name} resolved to ${matches.length} elements`);
    }
    return matches[0];
  }
  if (Number.isInteger(target.elementIndex)) {
    const element = slide.elements.items[target.elementIndex];
    if (!element) throw new Error(`Runtime element index ${target.elementIndex} is missing`);
    return element;
  }
  throw new Error("Runtime target requires anchorId, name, or elementIndex");
}

function bindingValue(slideModel: DynamicValue, operation: DynamicValue): DynamicValue {
  if (Object.hasOwn(operation, "literal")) return operation.literal;
  const focusMatch = /^milestones\.(\d+)\.focus$/u.exec(operation.valuePath ?? "");
  if (focusMatch) {
    const milestone = slideModel.milestones?.[Number(focusMatch[1])];
    return milestone ? roadmapFocusText(milestone) : undefined;
  }
  return getPath(slideModel, operation.valuePath);
}

function metricById(slideModel: DynamicValue, contentId: string): DynamicValue {
  const metric = slideModel.metrics.find(
    (candidate: DynamicValue) => candidate.contentId === contentId,
  );
  if (!metric) throw new Error(`Shared model lacks metric ${contentId}`);
  return metric;
}

export function formatSignedMetricDetail(value: DynamicValue): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return textValue(value);
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US")}`;
}

function managedRole(slide: DynamicValue): ManagedRole | null {
  const notes = String(slide.speakerNotes.text ?? "").replace(/\r\n?/gu, "\n");
  return (MANAGED_MARKER.exec(notes)?.[1] as ManagedRole | undefined) ?? null;
}

function managedInstanceId(slide: DynamicValue): string | undefined {
  const notes = String(slide.speakerNotes.text ?? "").replace(/\r\n?/gu, "\n");
  return /\n(?:instance_id|instance|role_instance)=([^\n]+)\n/u.exec(`\n${notes}`)?.[1];
}

function modelSlideIdentity(slide: DynamicValue): string {
  return typeof slide.instanceId === "string" && slide.instanceId.length > 0
    ? slide.instanceId
    : slide.role;
}

export function audienceStrings(slide: DynamicValue): DynamicValue[] {
  if (slide.role === "roadmap-executive") {
    return [
      slide.title,
      slide.summary,
      ...slide.milestones.flatMap((milestone: DynamicValue) => [
        milestone.title,
        milestone.focus,
        ...milestone.outcomes.flatMap((outcome: DynamicValue) => [
          outcome.featureTitle,
          outcome.text,
        ]),
      ]),
    ];
  }
  if (slide.role === "roadmap-capability") {
    return [
      slide.title,
      ...slide.columns.map((column: DynamicValue) => column.title),
      ...slide.rows,
      ...slide.cells.flatMap((cell: DynamicValue) =>
        cell.items.map((item: DynamicValue) => item.title),
      ),
      ...slide.unclassified.map((item: DynamicValue) => item.title),
    ];
  }
  if (slide.role === "markitecture") {
    return [
      slide.title,
      ...slide.nodes.map((node: DynamicValue) => node.text),
      ...slide.connectors.map((connector: DynamicValue) => connector.label),
    ];
  }
  const weeklyMetricById = new Map<string, DynamicValue>(
    slide.metrics.map((metric: DynamicValue) => [metric.contentId, metric]),
  );
  const momentumMetrics = ["metric.stars", "metric.forks", "metric.merged-prs"]
    .map((contentId) => weeklyMetricById.get(contentId))
    .filter(Boolean);
  const validationMetric = weeklyMetricById.get("metric.vdr-uat");
  const latestReleaseMetric = weeklyMetricById.get("metric.latest-release");
  const validationOpened = /(-?\d+)/u.exec(textValue(validationMetric?.value))?.[1];
  return [
    slide.title,
    ...momentumMetrics.flatMap((metric: DynamicValue) => [
      metric.label,
      metric.value,
      metric.detailValue,
    ]),
    validationOpened ? `${validationOpened} OPENED` : undefined,
    validationMetric ? `${textValue(validationMetric.detailValue)} CLOSED` : undefined,
    latestReleaseMetric?.value,
    ...slide.milestoneRows.flatMap((row: DynamicValue) => [
      row.title,
      ...row.updates.flatMap((item: DynamicValue) => [item.label, item.text]),
      ...(row.risks.length > 0
        ? row.risks.flatMap((item: DynamicValue) => [item.label, item.text])
        : ["None"]),
    ]),
  ].filter((value) => value !== undefined);
}

function assertAudienceText(slide: DynamicValue, modelSlide: DynamicValue): void {
  const directText = slide.elements.items
    .map((element: DynamicValue) => String(element.text ?? ""))
    .join("\n")
    .replace(/\r\n?/gu, "\n");
  const serialized = `${directText}\n${JSON.stringify(slide.toProto()).replace(/\\r\\n?/gu, "\\n")}`;
  const compactSerialized = serialized.replace(/\\n/gu, " ").replace(/\s+/gu, " ");
  for (const value of audienceStrings(modelSlide)) {
    const text = textValue(value);
    const candidates = [text.replace(/\n/gu, "\\n"), text];
    if (typeof value === "number") candidates.push(value.toLocaleString("en-US"));
    const compactCandidates = candidates.map((candidate) =>
      candidate.replace(/\\n/gu, " ").replace(/\s+/gu, " "),
    );
    if (
      text &&
      !candidates.some((candidate) => serialized.includes(candidate)) &&
      !compactCandidates.some((candidate) => compactSerialized.includes(candidate))
    ) {
      throw new Error(`${modelSlide.role} is missing audience text: ${text}`);
    }
  }
  const notes = String(slide.speakerNotes.text ?? "").replace(/\r\n?/gu, "\n");
  if (notes !== modelSlide.managedNotes.replace(/\r\n?/gu, "\n")) {
    throw new Error(`${modelSlide.role} speaker notes differ from the shared model`);
  }
}

function normalizedTargetText(target: DynamicValue): string {
  return String(target?.text ?? "").replace(/\r\n?/gu, "\n");
}

function targetKey(target: DynamicValue): string {
  return canonicalJson(target).trimEnd();
}

function assertExactTargetText(
  presentation: DynamicValue,
  slide: DynamicValue,
  targetSpec: DynamicValue,
  expected: DynamicValue,
  context: string,
) {
  const target = resolveTarget(presentation, slide, targetSpec);
  const actual = normalizedTargetText(target);
  const normalizedExpected = textValue(expected).replace(/\r\n?/gu, "\n");
  if (actual !== normalizedExpected) {
    throw new Error(
      `${context} text differs from the shared model: actual=${JSON.stringify(actual)} expected=${JSON.stringify(normalizedExpected)}`,
    );
  }
  return target;
}

function assertTargetLink(
  target: DynamicValue,
  linkedText: DynamicValue,
  expectedUrl: DynamicValue,
  context: string,
): void {
  if (!expectedUrl || !linkedText) return;
  const link = target.text?.get(linkedText)?.link;
  if (link?.uri !== expectedUrl || link?.isExternal !== true) {
    throw new Error(`${context} hyperlink differs from the shared model`);
  }
}

function renderedOperationText(slideModel: DynamicValue, operation: DynamicValue): string {
  const value = bindingValue(slideModel, operation);
  const isRoadmapFocus = /^milestones\.\d+\.focus$/u.test(operation.valuePath ?? "");
  return `${isRoadmapFocus ? "" : (operation.prefix ?? "")}${textValue(value)}${operation.suffix ?? ""}`;
}

function operationTargetsMissingRoadmapSlot(
  slideModel: DynamicValue,
  operation: DynamicValue,
): boolean {
  const pathValue = [operation.valuePath, operation.outcomePath, operation.outcomesPath].find(
    (candidate) =>
      typeof candidate === "string" && /^(?:milestones|columns)\.\d+\./u.test(candidate),
  );
  return typeof pathValue === "string" && getPath(slideModel, pathValue) === undefined;
}

function assertTextOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  operations: DynamicValue[] = [],
  searchedTargetText: Map<string, string> = new Map(),
) {
  for (const operation of operations) {
    if (operationTargetsMissingRoadmapSlot(slideModel, operation)) continue;
    const rendered = renderedOperationText(slideModel, operation);
    const context = `${slideModel.role} target ${targetKey(operation.target)}`;
    let target: DynamicValue;
    if (operation.search === undefined) {
      target = assertExactTargetText(presentation, slide, operation.target, rendered, context);
    } else {
      const expectedFullText = searchedTargetText.get(targetKey(operation.target));
      if (expectedFullText === undefined) {
        throw new Error(`${context} lacks a captured replacement result`);
      }
      target = assertExactTargetText(
        presentation,
        slide,
        operation.target,
        expectedFullText,
        context,
      );
      if (
        operation.search !== rendered &&
        normalizedTargetText(target).includes(operation.search)
      ) {
        throw new Error(`${context} retains replaced exemplar text: ${operation.search}`);
      }
      if (!normalizedTargetText(target).includes(rendered)) {
        throw new Error(`${context} lacks the shared-model replacement`);
      }
    }
    const link = operation.linkPath ? getPath(slideModel, operation.linkPath) : operation.link;
    assertTargetLink(target, rendered, link, context);
  }
}

function assertRichTextOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  operations: DynamicValue[] = [],
) {
  for (const operation of operations) {
    if (operationTargetsMissingRoadmapSlot(slideModel, operation)) continue;
    const expected = textValue(bindingValue(slideModel, operation));
    assertExactTargetText(
      presentation,
      slide,
      operation.target,
      expected,
      `${slideModel.role} rich-text target ${targetKey(operation.target)}`,
    );
  }
}

function assertOutcomeOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  operations: DynamicValue[] = [],
) {
  for (const operation of operations) {
    if (operationTargetsMissingRoadmapSlot(slideModel, operation)) continue;
    const outcome = getPath(slideModel, operation.outcomePath);
    const expected = outcome ? roadmapEpicDisplayText(outcome) : "";
    assertExactTargetText(
      presentation,
      slide,
      operation.target,
      expected,
      `${slideModel.role} outcome ${operation.outcomePath}`,
    );
  }
}

function assertOutcomeListOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  operations: DynamicValue[] = [],
) {
  for (const operation of operations) {
    if (operationTargetsMissingRoadmapSlot(slideModel, operation)) continue;
    const outcomes = getPath(slideModel, operation.outcomesPath);
    if (!Array.isArray(outcomes)) {
      throw new Error(`Shared model has an invalid outcome list ${operation.outcomesPath}`);
    }
    const expected = outcomes.map((outcome) => roadmapEpicDisplayText(outcome)).join("\n");
    assertExactTargetText(
      presentation,
      slide,
      operation.target,
      expected,
      `${slideModel.role} outcome list ${operation.outcomesPath}`,
    );
  }
}

export function expectedMetricText(slideModel: DynamicValue, operation: DynamicValue): string {
  if (operation.kind === "momentum") {
    return operation.metricContentIds
      .map((contentId: string) => metricById(slideModel, contentId))
      .map(
        (metric: DynamicValue) =>
          `${metric.label} ${Number(metric.value).toLocaleString("en-US")} (${formatSignedMetricDetail(metric.detailValue)})`,
      )
      .join("  |  ");
  }
  if (operation.kind === "opened-closed") {
    const metric = metricById(slideModel, operation.metricContentId);
    const opened = /(-?\d+)/u.exec(textValue(metric.value))?.[1] ?? textValue(metric.value);
    return `${opened} OPENED  |  ${textValue(metric.detailValue)} CLOSED`;
  }
  if (operation.kind === "single") {
    return textValue(metricById(slideModel, operation.metricContentId).value);
  }
  throw new Error(`Unknown runtime metric operation: ${operation.kind}`);
}

function assertMetricOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  operations: DynamicValue[] = [],
) {
  for (const operation of operations) {
    assertExactTargetText(
      presentation,
      slide,
      operation.target,
      expectedMetricText(slideModel, operation),
      `${slideModel.role} metric ${operation.kind}`,
    );
  }
}

export function weeklyMilestoneLabelText(title: DynamicValue): string {
  return textValue(title).trim().split(/\s+/u).join("\n").toUpperCase();
}

function expectedMilestoneRowOperationText(row: DynamicValue, operation: DynamicValue): string {
  if (!row) return "";
  if (operation.kind === "label") return weeklyMilestoneLabelText(row.title);
  if (operation.kind === "updates" || operation.kind === "risks") {
    const items = operation.kind === "updates" ? row.updates : row.risks;
    if (items.length === 0) return "None";
    return items
      .map((item: DynamicValue) => `${item.label ? `${item.label}: ` : ""}${item.text}`)
      .join("\n");
  }
  throw new Error(`Unknown runtime milestone row operation: ${String(operation.kind)}`);
}

function assertMilestoneRowOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  operations: DynamicValue[] = [],
) {
  for (const operation of operations) {
    const row = slideModel.milestoneRows[operation.rowIndex];
    assertExactTargetText(
      presentation,
      slide,
      operation.target,
      expectedMilestoneRowOperationText(row, operation),
      `${slideModel.role} milestone row ${operation.rowIndex} ${operation.kind}`,
    );
  }
}

function assertGeometryOperations(
  presentation: DynamicValue,
  slide: DynamicValue,
  operations: DynamicValue[] = [],
): void {
  for (const operation of operations) {
    const target = resolveTarget(presentation, slide, operation.target);
    const actual = target.position;
    for (const key of ["left", "top", "width", "height"]) {
      const expected = Number(operation.positionEmu?.[key]) / 9525;
      if (!Number.isFinite(expected) || Math.abs(Number(actual?.[key]) - expected) > 0.001) {
        throw new Error(
          `Runtime geometry target ${targetKey(operation.target)} differs for ${key}`,
        );
      }
    }
  }
}

function assertMatrix(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  contract: DynamicValue,
  searchedTargetText: Map<string, string>,
) {
  assertTextOperations(presentation, slide, slideModel, contract.operations, searchedTargetText);
  assertRichTextOperations(presentation, slide, slideModel, contract.richTextOperations);
  if (slide.tables.items.length !== 1) {
    throw new Error("Capability matrix must contain exactly one native table");
  }
  const table = resolveTarget(presentation, slide, contract.table.target);
  const tableProto = table.toProto()?.table;
  const expectedRows = Object.keys(contract.table.areaRows).length + 1;
  const milestoneColumnCount = contract.table.milestoneColumnCount ?? 3;
  const expectedColumns = milestoneColumnCount + 1;
  if (
    !tableProto ||
    tableProto.rows?.length !== expectedRows ||
    tableProto.columnWidths?.length !== expectedColumns
  ) {
    throw new Error(
      `Capability matrix must remain a ${expectedColumns}-column by ${expectedRows}-row native table`,
    );
  }
  capabilityMilestoneTitleOperations(contract);
  const topRow = contract.table.topRow;
  const firstColumn = contract.table.firstMilestoneColumn;
  const topRowColumns = [
    contract.table.areaLabelColumn,
    ...Array.from({ length: milestoneColumnCount }, (_value, index) => firstColumn + index),
  ];
  for (const column of topRowColumns) {
    if (normalizedTargetText(table.getCell(topRow, column)) !== "") {
      throw new Error(`Capability matrix top-row cell ${column} is not empty`);
    }
  }
  for (const area of slideModel.rows) {
    const row = contract.table.areaRows[area];
    const actualArea = normalizedTargetText(table.getCell(row, contract.table.areaLabelColumn))
      .replace(/\s+/gu, " ")
      .trim();
    if (actualArea !== area.replace(/\s+/gu, " ").trim()) {
      throw new Error(`Capability matrix row label differs: ${area}`);
    }
    slideModel.columns.forEach((column: DynamicValue, index: number) => {
      const cell = slideModel.cells.find(
        (candidate: DynamicValue) =>
          candidate.roadmapArea === area && candidate.milestoneNodeId === column.milestoneNodeId,
      );
      if (!cell) throw new Error(`Shared model lacks matrix cell ${area} / ${column.title}`);
      const actual = normalizedTargetText(table.getCell(row, firstColumn + index)).replace(
        /\n{2,}/gu,
        "\n",
      );
      const expected = cell.items.map(capabilityEpicDisplayText).join("\n");
      if (actual !== expected) throw new Error(`Capability matrix cell differs: ${area}`);
    });
    for (let index = slideModel.columns.length; index < milestoneColumnCount; index += 1) {
      if (normalizedTargetText(table.getCell(row, firstColumn + index)) !== "") {
        throw new Error(`Capability matrix unused cell ${area} / ${index} is not empty`);
      }
    }
  }
  const unclassifiedText = slideModel.unclassified.map(capabilityEpicDisplayText).join("\n");
  if (contract.unclassifiedTarget) {
    assertExactTargetText(
      presentation,
      slide,
      contract.unclassifiedTarget,
      unclassifiedText,
      "capability matrix classification warning",
    );
  } else if (slideModel.unclassified.length > 0) {
    assertExactTargetText(
      presentation,
      slide,
      { name: "nemoclaw:matrix-needs-classification" },
      slideModel.unclassified.map(capabilityEpicDisplayText).join("; "),
      "capability matrix classification warning",
    );
  } else {
    const warning = slide.elements.items.find(
      (element: DynamicValue) => elementName(element) === "nemoclaw:matrix-needs-classification",
    );
    if (warning) throw new Error("Capability matrix retains a stale classification warning");
  }
}

function assertMarkitecture(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  contract: DynamicValue,
  frameEntry?: DynamicValue,
): void {
  const expectedNames = new Set<string>();
  if (contract.title) {
    const titleNames = contract.title.target?.name
      ? [contract.title.target.name]
      : (frameEntry?.editTargets ?? [])
          .filter((target: DynamicValue) => target.action === "rewrite")
          .flatMap((target: DynamicValue) => frameMapTargetNames(target));
    if (titleNames.length !== 1) {
      throw new Error("Markitecture title lacks one frame-mapped rewrite target");
    }
    assertExactTargetText(
      presentation,
      slide,
      contract.title.target ?? { name: titleNames[0] },
      slideModel.title,
      "markitecture title",
    );
  } else {
    assertTextOperations(presentation, slide, slideModel, contract.operations);
  }
  for (const connector of slideModel.connectors) {
    const lineName = `nemoclaw:${connector.contentId}`;
    const labelName = `${lineName}:label`;
    expectedNames.add(lineName);
    const line = resolveTarget(presentation, slide, { name: lineName });
    if (!line.toProto()?.connector) {
      throw new Error(
        `Markitecture connector is not native connector geometry: ${connector.contentId}`,
      );
    }
    const frame = contract.geometry.connectorFrames[connector.contentId];
    if (frame?.label) {
      expectedNames.add(labelName);
      assertExactTargetText(
        presentation,
        slide,
        { name: labelName },
        connector.label,
        `markitecture connector label ${connector.contentId}`,
      );
    }
  }
  for (const node of slideModel.nodes) {
    const name = `nemoclaw:${node.contentId}`;
    expectedNames.add(name);
    assertExactTargetText(
      presentation,
      slide,
      { name },
      node.text,
      `markitecture node ${node.contentId}`,
    );
  }
  const actualNames = slide.elements.items
    .map((element: DynamicValue) => String(elementName(element) ?? ""))
    .filter((name: string) => name.startsWith("nemoclaw:"));
  if (
    actualNames.length !== expectedNames.size ||
    actualNames.some((name: string) => !expectedNames.has(name))
  ) {
    throw new Error("Markitecture contains missing or stale managed native objects");
  }
}

export function assertForbiddenText(
  slide: DynamicValue,
  contract: DynamicValue,
  modelSlide: DynamicValue,
  mode: ValidationMode,
): void {
  if (mode === "publish" && !Array.isArray(contract.forbiddenText)) {
    throw new Error("Publication requires reviewed forbidden exemplar text for every role");
  }
  const serialized = `${slide.elements.items.map((element: DynamicValue) => normalizedTargetText(element)).join("\n")}\n${JSON.stringify(slide.toProto())}`;
  const modeledAudienceText = audienceStrings(modelSlide).map((value) => textValue(value));
  for (const forbidden of contract.forbiddenText ?? []) {
    const isModeledAudienceText = modeledAudienceText.some((text) => text.includes(forbidden));
    if (forbidden && serialized.includes(forbidden) && !isModeledAudienceText) {
      throw new Error(`Managed slide retains forbidden exemplar text: ${forbidden}`);
    }
  }
}

function collectNativeKinds(proto: DynamicValue, kinds: Set<string>): void {
  if (!proto || typeof proto !== "object") return;
  if (Array.isArray(proto.children) && proto.children.length > 0) kinds.add("group");
  if (proto.table) kinds.add("table");
  if (proto.connector) kinds.add("connector");
  if (proto.type === 5 && !proto.connector) kinds.add("line");
  if (proto.shape) kinds.add("shape");
  if (
    Array.isArray(proto.paragraphs) &&
    proto.paragraphs.some((paragraph: DynamicValue) =>
      paragraph.runs?.some(
        (run: DynamicValue) => typeof run.text === "string" && run.text.length > 0,
      ),
    )
  ) {
    kinds.add("text");
  }
  for (const child of proto.children ?? []) collectNativeKinds(child, kinds);
}

function actualNativeKinds(slide: DynamicValue): string[] {
  const kinds = new Set<string>();
  for (const element of slide.elements.items) collectNativeKinds(element.toProto(), kinds);
  return [...kinds].sort();
}

function assertManagedOrder(
  presentation: DynamicValue,
  model: DynamicValue,
): Array<{
  role: ManagedRole;
  instanceId?: string;
  slide: DynamicValue;
  index: number;
}> {
  const managed: Array<{
    role: ManagedRole;
    instanceId?: string;
    slide: DynamicValue;
    index: number;
  }> = [];
  for (const slide of presentation.slides.items) {
    const role = managedRole(slide);
    if (!role) continue;
    if (!MANAGED_ROLES.includes(role)) throw new Error(`Unknown managed slide role: ${role}`);
    const instanceId = managedInstanceId(slide);
    const identity = instanceId ?? role;
    if (managed.some((entry) => (entry.instanceId ?? entry.role) === identity)) {
      throw new Error(`Duplicate managed slide instance: ${identity}`);
    }
    managed.push({
      role,
      ...(instanceId ? { instanceId } : {}),
      slide,
      index: slide.index,
    });
  }
  if (
    JSON.stringify(managed.map((entry) => entry.instanceId ?? entry.role)) !==
    JSON.stringify(model.slides.map(modelSlideIdentity))
  ) {
    throw new Error("Rendered managed slide order differs from the contract");
  }
  if (managed.some((entry, index) => index > 0 && entry.index !== managed[index - 1].index + 1)) {
    throw new Error("Rendered managed slides are not contiguous");
  }
  return managed;
}

function layoutBoxes(layout: DynamicValue): Array<{ name: DynamicValue; bbox: DynamicValue[] }> {
  const elements = [
    ...(layout.elements ?? []),
    ...(layout.inheritedLayers ?? []).flatMap((layer: DynamicValue) => layer.elements ?? []),
  ];
  return elements.flatMap((element: DynamicValue) => [
    ...(Array.isArray(element.bbox)
      ? [{ name: element.name ?? element.id, bbox: element.bbox }]
      : []),
    ...(element.cells ?? []).flatMap((cell: DynamicValue) =>
      Array.isArray(cell.bbox)
        ? [{ name: `${element.name ?? element.id}:cell`, bbox: cell.bbox }]
        : [],
    ),
  ]);
}

function addVisibleText(element: DynamicValue, inventory: string[]): void {
  if (!element || typeof element !== "object") return;
  if (Array.isArray(element.cells) && element.cells.length > 0) {
    for (const cell of element.cells) addVisibleText(cell, inventory);
    return;
  }
  if (Array.isArray(element.children) && element.children.length > 0) {
    for (const child of element.children) addVisibleText(child, inventory);
    return;
  }
  const paragraphText = Array.isArray(element.paragraphs)
    ? element.paragraphs
        .map((paragraph: DynamicValue) => paragraph?.text)
        .filter((value: DynamicValue) => typeof value === "string" && value.trim().length > 0)
    : [];
  const values = paragraphText.length > 0 ? paragraphText : [element.text];
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      inventory.push(value.replace(/\r\n?/gu, "\n"));
    }
  }
}

export function visibleTextInventoryFromLayout(layout: DynamicValue): string[] {
  const layers = visibleTextLayersFromLayout(layout);
  return [...layers.slideLocalText, ...layers.inheritedText].sort();
}

export function visibleTextLayersFromLayout(layout: DynamicValue): {
  slideLocalText: string[];
  inheritedText: string[];
} {
  if (layout?.schema !== "openai.presentation.layout/v4") {
    throw new Error("Visible-text inventory requires an openai.presentation.layout/v4 export");
  }
  const slideLocalText: string[] = [];
  const inheritedText: string[] = [];
  for (const element of layout.elements ?? []) addVisibleText(element, slideLocalText);
  for (const layer of layout.inheritedLayers ?? []) {
    for (const element of layer.elements ?? []) addVisibleText(element, inheritedText);
  }
  return {
    slideLocalText: slideLocalText.sort(),
    inheritedText: inheritedText.sort(),
  };
}

function assertLayoutBounds(layout: DynamicValue, role: string): void {
  if (layout.schema !== "openai.presentation.layout/v4" || layout.unit !== "px") {
    throw new Error(`${role} layout export has an incompatible schema or unit`);
  }
  const frame = layout.slide?.frame;
  if (!frame) throw new Error(`${role} layout export lacks the slide frame`);
  const tolerance = 0.5;
  for (const { name, bbox } of layoutBoxes(layout)) {
    const [left, top, width, height] = bbox.map(Number);
    if ([left, top, width, height].some((value) => !Number.isFinite(value))) {
      throw new Error(`${role} has an invalid layout box: ${name}`);
    }
    if (
      width < -tolerance ||
      height < -tolerance ||
      left < frame.left - tolerance ||
      top < frame.top - tolerance ||
      left + width > frame.left + frame.width + tolerance ||
      top + height > frame.top + frame.height + tolerance
    ) {
      throw new Error(`${role} has off-slide content: ${name}`);
    }
  }
}

function xmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function xmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    )
    .replace(/&#([0-9]+);/gu, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 10)),
    )
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function normalizeHyperlinkText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function relationshipTargets(relationshipsXml: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const relationship of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gu)) {
    const attributes = relationship[1];
    const id = /\bId="([^"]+)"/u.exec(attributes)?.[1];
    const target = /\bTarget="([^"]+)"/u.exec(attributes)?.[1];
    if (id && target) targets.set(id, decodeXmlText(target));
  }
  return targets;
}

/**
 * Reads text-run hyperlinks from a native PowerPoint slide and its relationship
 * part. The slide XML is the authority because the artifact-tool importer does
 * not currently retain table-cell run links in its facade or serialized proto.
 */
export function hyperlinkInventoryFromSlideXml(
  slideXml: string,
  relationshipsXml: string,
  protectedTextSha256: readonly string[] = [],
): HyperlinkInventoryEntry[] {
  const relationships = relationshipTargets(relationshipsXml);
  const inventory: HyperlinkInventoryEntry[] = [];
  const protectedHashes = new Set(protectedTextSha256);
  let managedSlideXml = slideXml;
  if (protectedHashes.size > 0) {
    const textObjects = [
      ...(slideXml.match(/<p:sp\b[\s\S]*?<\/p:sp>/gu) ?? []),
      ...(slideXml.match(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/gu) ?? []),
    ];
    for (const textObject of textObjects) {
      const paragraphs = textObject.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? [];
      const objectText = paragraphs
        .map((paragraph) =>
          (paragraph.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu) ?? [])
            .map((textXml) =>
              decodeXmlText(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/u.exec(textXml)?.[1] ?? ""),
            )
            .join(""),
        )
        .join("\n");
      if (protectedHashes.has(sha256Bytes(objectText))) {
        managedSlideXml = managedSlideXml.replace(textObject, "");
      }
    }
  }
  const paragraphs = managedSlideXml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? [];
  for (const paragraph of paragraphs) {
    const runs = paragraph.match(/<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/gu) ?? [];
    let active: HyperlinkInventoryEntry | undefined;
    const flush = () => {
      if (!active) return;
      const text = normalizeHyperlinkText(active.text);
      if (text.length > 0) inventory.push({ text, url: active.url });
      active = undefined;
    };
    for (const run of runs) {
      const relationshipId = /<a:hlinkClick\b[^>]*\br:id="([^"]+)"/u.exec(run)?.[1];
      const text = [...run.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
        .map((match) => decodeXmlText(match[1]))
        .join("");
      if (!relationshipId || text.length === 0) {
        flush();
        continue;
      }
      const url = relationships.get(relationshipId);
      if (!url) {
        throw new Error(`PowerPoint slide has unresolved hyperlink relationship ${relationshipId}`);
      }
      if (active?.url === url) active.text += text;
      else {
        flush();
        active = { text, url };
      }
    }
    flush();
  }
  return inventory.sort(
    (left, right) => compareUtf16(left.text, right.text) || compareUtf16(left.url, right.url),
  );
}

/** Reads the physical capability-table divider grid from native PowerPoint XML. */
export function capabilityDividerInventoryFromSlideXml(
  slideXml: string,
): CapabilityStructureInventory["table"]["dividers"] {
  const tables = slideXml.match(/<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>/gu) ?? [];
  if (tables.length !== 1) {
    throw new Error(`Capability slide contains ${tables.length} native PowerPoint tables`);
  }
  const rowBlocks = tables[0].match(/<a:tr(?:\s[^>]*)?>[\s\S]*?<\/a:tr>/gu) ?? [];
  const segmentKeys = new Set<string>();
  const signatures = new Set<string>();
  for (const [rowIndex, row] of rowBlocks.entries()) {
    const cellBlocks = row.match(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/gu) ?? [];
    for (const [columnIndex, cell] of cellBlocks.entries()) {
      const properties = /<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/u.exec(cell)?.[0] ?? "";
      for (const side of ["L", "R", "T", "B"] as const) {
        const line = new RegExp(`<a:ln${side}\\b([^>]*)>([\\s\\S]*?)<\\/a:ln${side}>`, "u").exec(
          properties,
        );
        if (!line) continue;
        const width = /\bw="([0-9]+)"/u.exec(line[1])?.[1] ?? "0";
        const color = /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/u.exec(line[2])?.[1];
        const dash = /<a:prstDash\b[^>]*\bval="([^"]+)"/u.exec(line[2])?.[1] ?? "solid";
        signatures.add(
          `${color ? `#${color.toUpperCase()}` : "#MISSING"}\u0000${dash}\u0000${width}`,
        );
        const segmentKey =
          side === "L"
            ? `v:${rowIndex}:${columnIndex}`
            : side === "R"
              ? `v:${rowIndex}:${columnIndex + 1}`
              : side === "T"
                ? `h:${rowIndex}:${columnIndex}`
                : `h:${rowIndex + 1}:${columnIndex}`;
        segmentKeys.add(segmentKey);
      }
    }
  }
  const [signature] = signatures;
  const [color = "#MISSING", lineStyle = "missing", width = "0"] =
    signatures.size === 1 ? signature.split("\u0000") : ["#MIXED", "mixed", "0"];
  return {
    segmentCount: segmentKeys.size,
    color,
    lineStyle,
    widthEmu: Number(width),
  };
}

function paragraphPropertyValue(paragraphXml: string, property: string): string | undefined {
  return new RegExp(`\\b${property}="([^"]+)"`, "u").exec(paragraphXml)?.[1];
}

/** Verifies native roadmap bullets, indentation, paragraph spacing, and line height. */
export function validateRoadmapOutcomeParagraphsFromSlideXml(
  slideXml: string,
  operations: DynamicValue[] = [],
  slideModel: DynamicValue,
): void {
  const shapeBlocks = [...slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map((match) => match[0]);
  for (const operation of operations) {
    const targetName = operation.target?.name;
    const styles = operation.paragraphStyles;
    const outcomes = getPath(slideModel, operation.outcomesPath);
    if (
      typeof targetName !== "string" ||
      typeof operation.outcomesPath !== "string" ||
      !Array.isArray(styles) ||
      styles.length === 0
    ) {
      throw new Error("Roadmap outcome contract requires a target and indexed paragraph styles");
    }
    const matches = shapeBlocks.filter((block) => shapeBlockName(block) === targetName);
    if (outcomes === undefined) {
      if (matches.length !== 0) {
        throw new Error(`Unused roadmap outcome target ${targetName} remains in the native slide`);
      }
      continue;
    }
    if (!Array.isArray(outcomes)) {
      throw new Error(`Roadmap outcome path ${operation.outcomesPath} is not an array`);
    }
    if (matches.length !== 1) {
      throw new Error(`Roadmap outcome target ${targetName} resolved to ${matches.length} shapes`);
    }
    const paragraphs = matches[0].match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? [];
    if (paragraphs.length !== outcomes.length) {
      throw new Error(
        `Roadmap outcome target ${targetName} has ${paragraphs.length} paragraphs; expected ${outcomes.length}`,
      );
    }
    for (const [index, paragraph] of paragraphs.entries()) {
      const paragraphProperties = /<a:pPr\b[\s\S]*?<\/a:pPr>/u.exec(paragraph)?.[0] ?? "";
      const expected =
        outcomes.length === styles.length
          ? styles[index]
          : outcomes.length === 1
            ? {
                ...styles[0],
                spaceAfter: styles.at(-1)?.spaceAfter ?? styles[0].spaceAfter,
              }
            : index === 0
              ? styles[0]
              : index === outcomes.length - 1
                ? styles.at(-1)
                : styles[Math.min(index, Math.max(1, styles.length - 2))];
      const expectedLineSpacing = Math.round(
        Number(operation.textFrameStyle?.lineSpacing) * 100_000,
      );
      const checks = [
        ["marginLeft", paragraphPropertyValue(paragraphProperties, "marL")],
        ["indent", paragraphPropertyValue(paragraphProperties, "indent")],
        ["spaceBefore", /<a:spcBef><a:spcPts\s+val="([^"]+)"/u.exec(paragraphProperties)?.[1]],
        ["spaceAfter", /<a:spcAft><a:spcPts\s+val="([^"]+)"/u.exec(paragraphProperties)?.[1]],
        ["lineSpacing", /<a:lnSpc><a:spcPct\s+val="([^"]+)"/u.exec(paragraphProperties)?.[1]],
      ] as const;
      const expectedValues = {
        marginLeft: expected.marginLeft,
        indent: expected.indent,
        spaceBefore: expected.spaceBefore,
        spaceAfter: expected.spaceAfter,
        lineSpacing: expectedLineSpacing,
      };
      for (const [property, actual] of checks) {
        if (actual !== String(expectedValues[property])) {
          throw new Error(
            `Roadmap outcome target ${targetName} paragraph ${index + 1} changes ${property}`,
          );
        }
      }
      const bullet = /<a:buChar\s+char="([^"]+)"\s*\/>/u.exec(paragraphProperties)?.[1];
      if (decodeXmlText(bullet ?? "") !== expected.bulletCharacter) {
        throw new Error(
          `Roadmap outcome target ${targetName} paragraph ${index + 1} changes its native bullet`,
        );
      }
    }
  }
}

/** Verifies native weekly update and risk bullets, including the synthesized None paragraph. */
export function validateWeeklyMilestoneParagraphsFromSlideXml(
  slideXml: string,
  operations: DynamicValue[] = [],
  slideModel: DynamicValue,
): void {
  const shapeBlocks = [...slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map((match) => match[0]);
  for (const operation of operations.filter(
    (candidate: DynamicValue) => candidate.kind === "updates" || candidate.kind === "risks",
  )) {
    const row = slideModel.milestoneRows?.[operation.rowIndex];
    if (!row) continue;
    const targetName = operation.target?.name;
    const expectedBullet = operation.paragraphStyle?.bulletCharacter;
    if (
      typeof targetName !== "string" ||
      operation.nativeBullets !== true ||
      expectedBullet !== WEEKLY_NATIVE_BULLET_CHARACTER
    ) {
      throw new Error(
        "Weekly milestone paragraph contract requires one named native-bullet target",
      );
    }
    const matches = shapeBlocks.filter((block) => shapeBlockName(block) === targetName);
    if (matches.length !== 1) {
      throw new Error(`Weekly milestone target ${targetName} resolved to ${matches.length} shapes`);
    }
    const items =
      operation.kind === "updates"
        ? row.updates
        : row.risks.length > 0
          ? row.risks
          : [{ label: "", text: "None" }];
    const paragraphs = matches[0].match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? [];
    if (paragraphs.length !== items.length) {
      throw new Error(
        `Weekly milestone target ${targetName} has ${paragraphs.length} paragraphs; expected ${items.length}`,
      );
    }
    for (const [index, paragraph] of paragraphs.entries()) {
      const paragraphProperties = /<a:pPr\b[\s\S]*?<\/a:pPr>/u.exec(paragraph)?.[0] ?? "";
      const bullet = /<a:buChar\s+char="([^"]+)"\s*\/>/u.exec(paragraphProperties)?.[1];
      const actualBullet = decodeXmlText(bullet ?? "");
      const actualText = (paragraph.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu) ?? [])
        .map((textXml) =>
          decodeXmlText(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/u.exec(textXml)?.[1] ?? ""),
        )
        .join("");
      const item = items[index];
      const expectedText = item.label ? `${item.label}: ${item.text}` : item.text;
      if (actualBullet !== expectedBullet) {
        throw new Error(
          `Weekly milestone target ${targetName} paragraph ${index + 1} is not a native bullet`,
        );
      }
      if (/^[•●▪◦]\s*/u.test(actualText) || actualText !== expectedText) {
        throw new Error(
          `Weekly milestone target ${targetName} paragraph ${index + 1} uses typed bullet text or differs from the shared model`,
        );
      }
    }
  }
}

function nativeTextRun(runXml: string): {
  text: string;
  bold: boolean;
  color: string | undefined;
  hyperlinkId: string | undefined;
} {
  const runProperties = /<a:rPr\b([^>]*)>/u.exec(runXml)?.[1] ?? "";
  const text = (runXml.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu) ?? [])
    .map((textXml) => decodeXmlText(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/u.exec(textXml)?.[1] ?? ""))
    .join("");
  const color = /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/u.exec(runXml)?.[1];
  return {
    text,
    bold: /\bb=(?:"1"|"true")/u.test(runProperties),
    color: color ? `#${color.toUpperCase()}` : undefined,
    hyperlinkId: /<a:hlinkClick\b[^>]*\br:id="([^"]+)"/u.exec(runXml)?.[1],
  };
}

/** Verifies native completed-Epic labels and muted executive context styling. */
export function validateRoadmapEpicCompletionFromSlideXml(
  slideXml: string,
  operations: DynamicValue[] = [],
  slideModel: DynamicValue,
): void {
  const shapeBlocks = [...slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map((match) => match[0]);
  for (const operation of operations) {
    const targetName = operation.target?.name;
    const outcomes = getPath(slideModel, operation.outcomesPath);
    if (typeof targetName !== "string" || typeof operation.outcomesPath !== "string") {
      throw new Error("Roadmap completion contract requires a target and outcome-list path");
    }
    const matches = shapeBlocks.filter((block) => shapeBlockName(block) === targetName);
    if (outcomes === undefined) continue;
    if (!Array.isArray(outcomes) || matches.length !== 1) {
      throw new Error(`Roadmap completion target ${targetName} does not match its outcome list`);
    }
    const activeColor = String(operation.textStyle?.color ?? "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/u.test(activeColor)) {
      throw new Error(`Roadmap completion target ${targetName} requires an explicit active color`);
    }
    if (
      outcomes.some((outcome) => outcome.state === "CLOSED") &&
      activeColor === COMPLETED_EPIC_CONTEXT_COLOR
    ) {
      throw new Error(`Roadmap completion target ${targetName} lacks a muted context contrast`);
    }
    const paragraphs = matches[0].match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? [];
    if (paragraphs.length !== outcomes.length) {
      throw new Error(`Roadmap completion target ${targetName} has the wrong paragraph count`);
    }
    for (const [index, paragraph] of paragraphs.entries()) {
      const outcome = outcomes[index];
      if (outcome?.state !== "OPEN" && outcome?.state !== "CLOSED") {
        throw new Error(
          `Roadmap outcome ${String(outcome?.contentId)} state must be OPEN or CLOSED`,
        );
      }
      const runs = (paragraph.match(/<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/gu) ?? [])
        .map(nativeTextRun)
        .filter((run) => run.text.length > 0);
      if (runs.length !== 2) {
        throw new Error(
          `Roadmap completion target ${targetName} paragraph ${index + 1} must have two text runs`,
        );
      }
      const expectedPrefix = outcome.state === "CLOSED" ? "✓ " : "";
      const expectedContextColor =
        outcome.state === "CLOSED" ? COMPLETED_EPIC_CONTEXT_COLOR : activeColor;
      if (
        runs[0].text !== `${expectedPrefix}${outcome.featureTitle}:` ||
        !runs[0].bold ||
        runs[0].color !== activeColor
      ) {
        throw new Error(
          `Roadmap completion target ${targetName} paragraph ${index + 1} changes its label state`,
        );
      }
      if (
        runs[1].text !== ` ${outcome.text}` ||
        runs[1].bold ||
        runs[1].color !== expectedContextColor
      ) {
        throw new Error(
          `Roadmap completion target ${targetName} paragraph ${index + 1} changes its context state`,
        );
      }
    }
  }
}

/** Verifies native capability-table Epic labels and number-only links. */
export function validateCapabilityEpicCompletionFromSlideXml(
  slideXml: string,
  relationshipsXml: string,
  tableContract: DynamicValue,
  slideModel: DynamicValue,
): void {
  const tables = slideXml.match(/<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>/gu) ?? [];
  if (tables.length !== 1) {
    throw new Error(`Capability completion contract found ${tables.length} native tables`);
  }
  const rows = tables[0].match(/<a:tr(?:\s[^>]*)?>[\s\S]*?<\/a:tr>/gu) ?? [];
  const relationships = relationshipTargets(relationshipsXml);
  const firstMilestoneColumn = tableContract?.firstMilestoneColumn;
  if (!Number.isInteger(firstMilestoneColumn) || !tableContract?.areaRows) {
    throw new Error("Capability completion contract lacks its native table map");
  }
  if (!Array.isArray(slideModel?.rows) || !Array.isArray(slideModel?.columns)) {
    throw new Error("Capability completion model lacks rows or milestone columns");
  }

  for (const area of slideModel.rows) {
    const rowIndex = tableContract.areaRows[area];
    const row = Number.isInteger(rowIndex) ? rows[rowIndex] : undefined;
    if (!row) throw new Error(`Capability completion contract lacks native row ${String(area)}`);
    const cells = row.match(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/gu) ?? [];
    for (const [columnIndex, column] of slideModel.columns.entries()) {
      const cellModel = slideModel.cells?.find(
        (candidate: DynamicValue) =>
          candidate.roadmapArea === area && candidate.milestoneNodeId === column.milestoneNodeId,
      );
      const cell = cells[firstMilestoneColumn + columnIndex];
      if (!cellModel || !cell) {
        throw new Error(
          `Capability completion contract lacks cell ${String(area)} / ${String(column.title)}`,
        );
      }
      const paragraphs = (cell.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu) ?? [])
        .map((paragraph) => ({
          paragraph,
          runs: (paragraph.match(/<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/gu) ?? [])
            .map(nativeTextRun)
            .filter((run) => run.text.length > 0),
        }))
        .filter(({ runs }) => runs.some((run) => run.text.length > 0));
      if (paragraphs.length !== cellModel.items.length) {
        throw new Error(
          `Capability completion cell ${String(area)} / ${String(column.title)} has the wrong item count`,
        );
      }
      for (const [itemIndex, item] of cellModel.items.entries()) {
        if (item?.state !== "OPEN" && item?.state !== "CLOSED") {
          throw new Error(
            `Capability item ${String(item?.contentId)} state must be OPEN or CLOSED`,
          );
        }
        const runs = paragraphs[itemIndex].runs;
        const expectedPrefix = item.state === "CLOSED" ? "✓ " : "";
        const expectedTexts = [
          `${expectedPrefix}${String(item.title)}`,
          " (",
          `#${String(item.issueNumber)}`,
          ")",
        ];
        const issueHyperlinkId = runs[2]?.hyperlinkId;
        if (
          runs.length !== expectedTexts.length ||
          runs.some((run, index) => run.text !== expectedTexts[index]) ||
          !runs[0].bold ||
          runs[0].hyperlinkId ||
          runs.slice(1).some((run) => run.bold) ||
          runs[1].hyperlinkId ||
          !issueHyperlinkId ||
          runs[3].hyperlinkId
        ) {
          throw new Error(
            `Capability item ${String(item.contentId)} changes its completed-label or number-only link state`,
          );
        }
        if (relationships.get(issueHyperlinkId) !== item.url) {
          throw new Error(`Capability item ${String(item.contentId)} links to the wrong issue`);
        }
      }
    }
  }
}

type NativeShapeGeometry = {
  id: string;
  name: string;
  block: string;
  kind: "shape" | "connector";
};

function shapeBlockName(block: string): string | undefined {
  const encoded = /<p:cNvPr\b[^>]*\bname="([^"]+)"/u.exec(block)?.[1];
  return encoded === undefined ? undefined : decodeXmlText(encoded);
}

function nativeNamedShapeGeometries(slideXml: string): Map<string, NativeShapeGeometry> {
  const shapes = new Map<string, NativeShapeGeometry>();
  const blocks = [
    ...[...slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map((match) => ({
      block: match[0],
      kind: "shape" as const,
    })),
    ...[...slideXml.matchAll(/<p:cxnSp\b[\s\S]*?<\/p:cxnSp>/gu)].map((match) => ({
      block: match[0],
      kind: "connector" as const,
    })),
  ];
  for (const { block, kind } of blocks) {
    const name = shapeBlockName(block);
    if (!name?.startsWith("nemoclaw:")) continue;
    if (shapes.has(name)) throw new Error(`Native PowerPoint slide duplicates ${name}`);
    const id = /<p:cNvPr\b[^>]*\bid="([0-9]+)"/u.exec(block)?.[1];
    if (!id) throw new Error(`Native PowerPoint shape lacks an object id: ${name}`);
    shapes.set(name, { id, name, block, kind });
  }
  return shapes;
}

function lineEndType(lineXml: string, end: "headEnd" | "tailEnd"): string {
  const tag = new RegExp(`<a:${end}\\b[^>]*\\/?\\s*>`, "u").exec(lineXml)?.[0];
  return tag ? (/\btype="([^"]+)"/u.exec(tag)?.[1] ?? "none") : "none";
}

function nativeLineStyle(lineXml: string): "solid" | "dashed" {
  const dashTag = /<a:prstDash\b[^>]*\/?\s*>/u.exec(lineXml)?.[0];
  const value = dashTag && /\bval="([^"]+)"/u.exec(dashTag)?.[1];
  return !value || value === "solid" ? "solid" : "dashed";
}

/** Reads connector direction and line style only from native PowerPoint geometry. */
export function connectorInventoryFromSlideXml(slideXml: string): ConnectorInventoryEntry[] {
  const shapes = nativeNamedShapeGeometries(slideXml);
  const shapesById = new Map([...shapes.values()].map((shape) => [shape.id, shape]));
  const inventory: ConnectorInventoryEntry[] = [];
  const attachmentSignaturesByNodePair = new Map<string, Set<string>>();
  for (const [name, shape] of shapes) {
    if (!name.startsWith("nemoclaw:connector.") || shape.kind !== "connector") continue;
    const lineXml = /<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/u.exec(shape.block)?.[0];
    if (!lineXml) throw new Error(`Native PowerPoint connector lacks line properties: ${name}`);
    const headArrow = lineEndType(lineXml, "headEnd") !== "none";
    const tailArrow = lineEndType(lineXml, "tailEnd") !== "none";
    if (headArrow || !tailArrow) {
      throw new Error(`Native PowerPoint connector must have one target tail arrow: ${name}`);
    }
    const startId = /<a:stCxn\b[^>]*\bid="([0-9]+)"/u.exec(shape.block)?.[1];
    const endId = /<a:endCxn\b[^>]*\bid="([0-9]+)"/u.exec(shape.block)?.[1];
    const startIndex = /<a:stCxn\b[^>]*\bidx="([0-9]+)"/u.exec(shape.block)?.[1];
    const endIndex = /<a:endCxn\b[^>]*\bidx="([0-9]+)"/u.exec(shape.block)?.[1];
    const startAnchor = startId ? shapesById.get(startId) : undefined;
    const endAnchor = endId ? shapesById.get(endId) : undefined;
    if (!startAnchor || !endAnchor || startIndex === undefined || endIndex === undefined) {
      throw new Error(`Native PowerPoint connector is not attached at both endpoints: ${name}`);
    }
    const contentId = name.slice("nemoclaw:".length);
    const nodeName = /^nemoclaw:(node\.[a-z0-9-]+)$/u;
    const from = nodeName.exec(startAnchor.name)?.[1];
    const to = nodeName.exec(endAnchor.name)?.[1];
    if (!from || !to || from === to) {
      throw new Error(`Native PowerPoint connector endpoint nodes are invalid: ${name}`);
    }
    const nodePair = [from, to].sort(compareUtf16).join("\u0000");
    const attachmentSignature = [`${from}:${startIndex}`, `${to}:${endIndex}`]
      .sort(compareUtf16)
      .join("\u0000");
    const pairSignatures = attachmentSignaturesByNodePair.get(nodePair) ?? new Set<string>();
    if (pairSignatures.has(attachmentSignature)) {
      throw new Error(`Reciprocal PowerPoint connectors overlap at identical sites: ${name}`);
    }
    pairSignatures.add(attachmentSignature);
    attachmentSignaturesByNodePair.set(nodePair, pairSignatures);
    inventory.push({
      contentId,
      from,
      to,
      direction: "from-to",
      lineStyle: nativeLineStyle(lineXml),
    });
  }
  return inventory.sort((left, right) => compareUtf16(left.contentId, right.contentId));
}

export function validateNativeConnectorInventory(
  expected: ConnectorInventoryEntry[],
  actual: ConnectorInventoryEntry[],
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("PowerPoint artifact connector semantics differ from the shared model");
  }
}

function themeRelationshipTarget(xml: string, label: string): string {
  const tags = [...xml.matchAll(/<Relationship\b(?=[^>]*\bType="[^"]*\/theme")[^>]*\/?\s*>/gu)].map(
    (match) => match[0],
  );
  if (tags.length !== 1) throw new Error(`${label} must contain exactly one theme relationship`);
  const target = /\bTarget="([^"]+)"/u.exec(tags[0])?.[1];
  if (!target) throw new Error(`${label} theme relationship lacks Target`);
  return decodeXmlText(target);
}

function rewriteThemeRelationshipTarget(xml: string, target: string, label: string): string {
  const current = themeRelationshipTarget(xml, label);
  const encodedTarget = xmlText(target).replace(/"/gu, "&quot;");
  const rewritten = xml.replace(
    /<Relationship\b(?=[^>]*\bType="[^"]*\/theme")[^>]*\/?\s*>/u,
    (tag) => tag.replace(`Target="${xmlText(current)}"`, `Target="${encodedTarget}"`),
  );
  if (themeRelationshipTarget(rewritten, label) !== target) {
    throw new Error(`${label} theme relationship could not be restored`);
  }
  return rewritten;
}

function themeContentTypeTags(xml: string): string[] {
  return [...xml.matchAll(/<Override\b[^>]*\/?\s*>/gu)]
    .map((match) => match[0])
    .filter((tag) =>
      /\bContentType="application\/vnd\.openxmlformats-officedocument\.theme\+xml"/u.test(tag),
    );
}

function themeContentTypeParts(xml: string): string[] {
  return themeContentTypeTags(xml)
    .map((tag) => /\bPartName="([^"]+)"/u.exec(tag)?.[1])
    .filter((value): value is string => value !== undefined)
    .sort(compareUtf16);
}

function restoreThemeContentTypes(outputXml: string, templateXml: string): string {
  const withoutThemes = outputXml.replace(/<Override\b[^>]*\/?\s*>/gu, (tag) =>
    /\bContentType="application\/vnd\.openxmlformats-officedocument\.theme\+xml"/u.test(tag)
      ? ""
      : tag,
  );
  if (!withoutThemes.includes("</Types>")) {
    throw new Error("PowerPoint content types lack the Types terminator");
  }
  return withoutThemes.replace("</Types>", `${themeContentTypeTags(templateXml).join("")}</Types>`);
}

async function themePackageContractFromZip(zip: DynamicValue): Promise<ThemePackageContract> {
  const themePaths = Object.keys(zip.files)
    .filter((entry) => /^ppt\/(?:[^/]+\/)*theme\/theme[0-9]+\.xml$/u.test(entry))
    .sort(compareUtf16);
  const themeSha256ByPath = Object.fromEntries(
    await Promise.all(
      themePaths.map(async (entry) => [
        entry,
        sha256Bytes(await zip.file(entry).async("nodebuffer")),
      ]),
    ),
  );
  const relationshipPaths = Object.keys(zip.files)
    .filter((entry) => /^ppt\/.*\.rels$/u.test(entry))
    .sort(compareUtf16);
  const themeRelationshipTargetByPath: Record<string, string> = {};
  for (const entry of relationshipPaths) {
    const xml = await zip.file(entry).async("string");
    if (!/\bType="[^"]*\/theme"/u.test(xml)) continue;
    themeRelationshipTargetByPath[entry] = themeRelationshipTarget(xml, entry);
  }
  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  if (!contentTypes) throw new Error("PowerPoint package lacks [Content_Types].xml");
  return {
    themeSha256ByPath,
    themeRelationshipTargetByPath,
    themeContentTypeParts: themeContentTypeParts(contentTypes),
  };
}

async function mediaSha256InventoryFromZip(zip: DynamicValue): Promise<string[]> {
  return (
    await Promise.all(
      Object.keys(zip.files)
        .filter((entry) => /^ppt\/media\/[^/]+$/u.test(entry) && !zip.files[entry].dir)
        .map(async (entry) => sha256Bytes(await zip.file(entry).async("nodebuffer"))),
    )
  ).sort(compareUtf16);
}

async function validateTemplateMediaPackageContract(
  templateZip: DynamicValue,
  artifactZip: DynamicValue,
): Promise<void> {
  const [templateMedia, artifactMedia] = await Promise.all([
    mediaSha256InventoryFromZip(templateZip),
    mediaSha256InventoryFromZip(artifactZip),
  ]);
  if (JSON.stringify(artifactMedia) !== JSON.stringify(templateMedia)) {
    throw new Error("PowerPoint artifact does not preserve the exact template media bytes");
  }
}

export function validateTemplateThemePackageContract(
  template: ThemePackageContract,
  artifact: ThemePackageContract,
): void {
  if (JSON.stringify(artifact.themeSha256ByPath) !== JSON.stringify(template.themeSha256ByPath)) {
    throw new Error("PowerPoint artifact does not preserve the exact template theme parts");
  }
  if (
    JSON.stringify(artifact.themeRelationshipTargetByPath) !==
    JSON.stringify(template.themeRelationshipTargetByPath)
  ) {
    throw new Error("PowerPoint artifact does not preserve template theme relationships");
  }
  if (
    JSON.stringify(artifact.themeContentTypeParts) !==
    JSON.stringify(template.themeContentTypeParts)
  ) {
    throw new Error("PowerPoint artifact does not preserve template theme content types");
  }
}

async function restoreTemplateThemesInZip(
  outputZip: DynamicValue,
  templateZip: DynamicValue,
): Promise<void> {
  const templateContract = await themePackageContractFromZip(templateZip);
  for (const entry of Object.keys(outputZip.files)) {
    if (/^ppt\/(?:[^/]+\/)*theme\/theme[0-9]+\.xml$/u.test(entry)) outputZip.remove(entry);
  }
  for (const entry of Object.keys(templateContract.themeSha256ByPath)) {
    const source = templateZip.file(entry);
    if (!source) throw new Error(`Template theme part is missing: ${entry}`);
    outputZip.file(entry, await source.async("nodebuffer"), {
      date: source.date,
    });
  }
  for (const [entry, target] of Object.entries(templateContract.themeRelationshipTargetByPath)) {
    const outputRelationship = outputZip.file(entry);
    if (!outputRelationship) throw new Error(`PowerPoint artifact lacks theme owner ${entry}`);
    outputZip.file(
      entry,
      rewriteThemeRelationshipTarget(await outputRelationship.async("string"), target, entry),
      { date: outputRelationship.date },
    );
  }
  const outputContentTypes = outputZip.file("[Content_Types].xml");
  const templateContentTypes = templateZip.file("[Content_Types].xml");
  if (!outputContentTypes || !templateContentTypes) {
    throw new Error("PowerPoint package lacks content types for theme restoration");
  }
  outputZip.file(
    "[Content_Types].xml",
    restoreThemeContentTypes(
      await outputContentTypes.async("string"),
      await templateContentTypes.async("string"),
    ),
    { date: outputContentTypes.date },
  );
}

async function prepareNativePptxArtifact({
  JSZip,
  pptxPath,
  templateBytes,
  starterBytes,
  model,
}: {
  JSZip: DynamicValue;
  pptxPath: string;
  templateBytes: Buffer;
  starterBytes: Buffer;
  model: DynamicValue;
}): Promise<void> {
  const [outputZip, templateZip, starterZip] = await Promise.all([
    JSZip.loadAsync(await fs.readFile(pptxPath)),
    JSZip.loadAsync(templateBytes),
    JSZip.loadAsync(starterBytes),
  ]);
  await restoreTemplateThemesInZip(outputZip, templateZip);
  const markitecture = model.slides.find((slide: DynamicValue) => slide.role === "markitecture");
  const slideCandidates = [];
  for (const entry of Object.keys(outputZip.files).filter((name) =>
    /^ppt\/slides\/slide[0-9]+\.xml$/u.test(name),
  )) {
    const xml = await outputZip.file(entry).async("string");
    if (xml.includes('name="nemoclaw:connector.')) slideCandidates.push({ entry, xml });
  }
  if (!markitecture || slideCandidates.length !== 1) {
    throw new Error("PowerPoint artifact must contain one native markitecture slide");
  }
  const [{ entry: markitecturePath }] = slideCandidates;
  await fs.writeFile(
    pptxPath,
    await outputZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
  const verifiedZip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  validateTemplateThemePackageContract(
    await themePackageContractFromZip(templateZip),
    await themePackageContractFromZip(verifiedZip),
  );
  await validateTemplateMediaPackageContract(starterZip, verifiedZip);
  const verifiedSlide = await verifiedZip.file(markitecturePath)?.async("string");
  if (!verifiedSlide) throw new Error("PowerPoint artifact lost its markitecture slide");
  const actualConnectors = connectorInventoryFromSlideXml(verifiedSlide);
  const expectedConnectors = markitecture.connectors
    .map((connector: DynamicValue) => ({
      contentId: connector.contentId,
      from: connector.from,
      to: connector.to,
      direction: "from-to",
      lineStyle: connector.lineStyle,
    }))
    .sort((left: ConnectorInventoryEntry, right: ConnectorInventoryEntry) =>
      compareUtf16(left.contentId, right.contentId),
    );
  validateNativeConnectorInventory(expectedConnectors, actualConnectors);
}

async function hyperlinkInventoryByRoleFromPptx(
  JSZip: DynamicValue,
  pptxPath: string,
  managedSlides: Array<{
    role: ManagedRole;
    instanceId?: string;
    slide: DynamicValue;
  }>,
  roleMap: DynamicValue,
  model: DynamicValue,
): Promise<Map<string, HyperlinkInventoryEntry[]>> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const inventories = new Map<string, HyperlinkInventoryEntry[]>();
  for (const [modelIndex, { role, instanceId, slide }] of managedSlides.entries()) {
    const identity = instanceId ?? role;
    const slideNumber = Number(slide.index) + 1;
    if (!Number.isInteger(slideNumber) || slideNumber <= 0) {
      throw new Error(`${role} has no stable PowerPoint slide index for hyperlink readback`);
    }
    const slidePath = `ppt/slides/slide${slideNumber}.xml`;
    const relationshipsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const slideFile = zip.file(slidePath);
    if (!slideFile) throw new Error(`${role} lacks its native PowerPoint slide XML`);
    const [slideXml, relationshipsXml] = await Promise.all([
      slideFile.async("string"),
      zip.file(relationshipsPath)?.async("string") ?? Promise.resolve(""),
    ]);
    if (role === "roadmap-executive") {
      validateRoadmapOutcomeParagraphsFromSlideXml(
        slideXml,
        roleMap.roles?.[role]?.outcomeListOperations,
        model.slides[modelIndex],
      );
      validateRoadmapEpicCompletionFromSlideXml(
        slideXml,
        roleMap.roles?.[role]?.outcomeListOperations,
        model.slides[modelIndex],
      );
    }
    if (role === "roadmap-capability") {
      validateCapabilityEpicCompletionFromSlideXml(
        slideXml,
        relationshipsXml,
        roleMap.roles?.[role]?.table,
        model.slides[modelIndex],
      );
    }
    if (role === "weekly-release") {
      validateWeeklyMilestoneParagraphsFromSlideXml(
        slideXml,
        roleMap.roles?.[role]?.milestoneRowOperations,
        model.slides[modelIndex],
      );
    }
    const hyperlinkInventory = hyperlinkInventoryFromSlideXml(
      slideXml,
      relationshipsXml,
      roleMap.roles?.[role]?.protectedTextSha256 ?? [],
    );
    if (role === "roadmap-executive" && hyperlinkInventory.length > 0) {
      throw new Error("The roadmap-executive slide must not contain visible text hyperlinks");
    }
    inventories.set(identity, hyperlinkInventory);
  }
  return inventories;
}

async function connectorInventoryByRoleFromPptx(
  JSZip: DynamicValue,
  pptxPath: string,
  managedSlides: Array<{
    role: ManagedRole;
    instanceId?: string;
    slide: DynamicValue;
  }>,
): Promise<Map<string, ConnectorInventoryEntry[]>> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const inventories = new Map<string, ConnectorInventoryEntry[]>();
  for (const { role, instanceId, slide } of managedSlides) {
    const identity = instanceId ?? role;
    const slideNumber = Number(slide.index) + 1;
    const slideFile = zip.file(`ppt/slides/slide${slideNumber}.xml`);
    if (!Number.isInteger(slideNumber) || slideNumber <= 0 || !slideFile) {
      throw new Error(`${role} lacks native PowerPoint connector readback`);
    }
    const slideXml = await slideFile.async("string");
    inventories.set(
      identity,
      role === "markitecture" ? connectorInventoryFromSlideXml(slideXml) : [],
    );
  }
  return inventories;
}

async function capabilityStructureInventoryByRoleFromPptx(
  JSZip: DynamicValue,
  pptxPath: string,
  managedSlides: Array<{
    role: ManagedRole;
    instanceId?: string;
    slide: DynamicValue;
  }>,
  roleMap: DynamicValue,
  model: DynamicValue,
  layoutByRole: Map<string, DynamicValue>,
): Promise<Map<string, CapabilityStructureInventory>> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const inventories = new Map<string, CapabilityStructureInventory>();
  for (const [index, { role, instanceId, slide }] of managedSlides.entries()) {
    if (role !== "roadmap-capability") continue;
    const identity = instanceId ?? role;
    const slideNumber = Number(slide.index) + 1;
    const slideFile = zip.file(`ppt/slides/slide${slideNumber}.xml`);
    const layout = layoutByRole.get(identity);
    if (!Number.isInteger(slideNumber) || slideNumber <= 0 || !slideFile || !layout) {
      throw new Error(`${identity} lacks native PowerPoint capability structure readback`);
    }
    inventories.set(
      identity,
      capabilityStructureInventoryFromLayout(
        layout,
        roleMap.roles[role],
        model.slides[index],
        capabilityDividerInventoryFromSlideXml(await slideFile.async("string")),
      ),
    );
  }
  return inventories;
}

async function weeklyMilestoneStructureInventoryByRoleFromPptx(
  JSZip: DynamicValue,
  pptxPath: string,
  managedSlides: Array<{
    role: ManagedRole;
    instanceId?: string;
    slide: DynamicValue;
  }>,
  roleMap: DynamicValue,
  model: DynamicValue,
  layoutByRole: Map<string, DynamicValue>,
): Promise<Map<string, WeeklyMilestoneStructureInventory>> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const inventories = new Map<string, WeeklyMilestoneStructureInventory>();
  for (const [index, { role, instanceId, slide }] of managedSlides.entries()) {
    if (role !== "weekly-release") continue;
    const identity = instanceId ?? role;
    const slideNumber = Number(slide.index) + 1;
    const slideFile = zip.file(`ppt/slides/slide${slideNumber}.xml`);
    const layout = layoutByRole.get(identity);
    if (!Number.isInteger(slideNumber) || slideNumber <= 0 || !slideFile || !layout) {
      throw new Error(`${identity} lacks native PowerPoint weekly milestone structure readback`);
    }
    inventories.set(
      identity,
      weeklyMilestoneStructureInventoryFromLayoutAndSlideXml(
        layout,
        await slideFile.async("string"),
        roleMap.roles[role],
        model.slides[index],
      ),
    );
  }
  return inventories;
}

async function assertTableLinks(
  JSZip: DynamicValue,
  pptxPath: string,
  slideModel: DynamicValue,
): Promise<void> {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const slidePaths = Object.keys(zip.files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/u.test(name),
  );
  const items = [
    ...slideModel.cells.flatMap((cell: DynamicValue) => cell.items),
    ...slideModel.unclassified,
  ];
  for (const item of items) {
    const matches = [];
    const encodedText = `<a:t>${xmlText(capabilityEpicReferenceText(item))}</a:t>`;
    for (const slidePath of slidePaths) {
      const xml = await zip.file(slidePath)?.async("string");
      if (!xml?.includes(encodedText)) continue;
      let offset = xml.indexOf(encodedText);
      while (offset >= 0) {
        const runStart = xml.lastIndexOf("<a:r", offset);
        const runEnd = xml.indexOf("</a:r>", offset);
        if (runStart >= 0 && runEnd >= offset) {
          const run = xml.slice(runStart, runEnd + 6);
          const relationshipId = /<a:hlinkClick\b[^>]*\br:id="([^"]+)"/u.exec(run)?.[1];
          if (relationshipId) {
            const fileName = path.posix.basename(slidePath);
            const relationshipsPath = `ppt/slides/_rels/${fileName}.rels`;
            const relationships = await zip.file(relationshipsPath)?.async("string");
            const relationship = (relationships?.match(/<Relationship\b[^>]*\/?\s*>/gu) ?? []).find(
              (candidate: string) => new RegExp(`\\bId="${relationshipId}"`, "u").test(candidate),
            );
            const target = /\bTarget="([^"]+)"/u.exec(relationship ?? "")?.[1];
            if (target) matches.push(xmlAttribute(target));
          }
        }
        offset = xml.indexOf(encodedText, offset + encodedText.length);
      }
    }
    if (matches.length !== 1 || matches[0] !== item.url) {
      throw new Error(`Capability Epic hyperlink differs for ${item.title}`);
    }
  }
}

function assertPublicationEvidence(evidence: DynamicValue, current: DynamicValue): void {
  if (!evidence || evidence.schemaVersion !== 1) {
    throw new Error("Publication requires schemaVersion 1 validation evidence");
  }
  for (const key of [
    "snapshotSha256",
    "modelSha256",
    "templateFingerprint",
    "templateSha256",
    "roleMapSha256",
  ]) {
    if (evidence[key] !== current[key]) {
      throw new Error(`Publication validation evidence differs for ${key}`);
    }
  }
  for (const key of [
    "previewPptxPath",
    "previewPptxSha256",
    "outputPath",
    "parityReceiptPath",
    "parityReceiptSha256",
  ]) {
    if (evidence[key] !== current[key]) {
      throw new Error(`Publication validation evidence differs for ${key}`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(current.previewPptxSha256 ?? "")) {
    throw new Error("Publication did not hash an actual reviewed preview artifact");
  }
  requiredSha256(current.roleMapSha256, "Publication roleMapSha256");
  requiredSha256(current.parityReceiptSha256, "Publication parityReceiptSha256");
  requiredAbsolutePath(current.parityReceiptPath, "Publication parityReceiptPath");
  if (
    JSON.stringify(evidence.inspectedRoles) !==
    JSON.stringify(current.managedSlideIds ?? MANAGED_ROLES)
  ) {
    throw new Error("Publication validation evidence does not cover every managed slide instance");
  }
  for (const key of [
    "fullSizeVisualReview",
    "nativeEditability",
    "notesAndLinksMatch",
    "crossFormatParity",
  ]) {
    if (evidence[key] !== true) throw new Error(`Publication validation evidence lacks ${key}`);
  }
  for (const key of ["overflow", "clipping", "fontSubstitution", "staleText"]) {
    if (evidence[key] !== false) throw new Error(`Publication validation evidence reports ${key}`);
  }
}

export function validatePptxPublicationInputs({
  approval,
  evidence,
  current,
}: {
  approval: DynamicValue;
  evidence: DynamicValue;
  current: DynamicValue;
}): void {
  if (!approval) throw new Error("Publication approval is missing");
  for (const key of [
    "targetId",
    "targetRevision",
    "snapshotSha256",
    "modelSha256",
    "templateFingerprint",
    "roleMapSha256",
    "parityReceiptSha256",
  ]) {
    if (approval[key] !== current[key]) {
      throw new Error(`Publication approval differs for ${key}`);
    }
  }
  assertPublicationEvidence(evidence, current);
}

function requiredSha256(value: DynamicValue, context: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value ?? "")) {
    throw new Error(`${context} must be a canonical SHA-256`);
  }
  return value;
}

function requiredNonemptyString(value: DynamicValue, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} is missing`);
  }
  return value;
}

function requiredAbsolutePath(value: DynamicValue, context: string): string {
  const candidate = requiredNonemptyString(value, context);
  if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
    throw new Error(`${context} must be an absolute normalized path`);
  }
  return candidate;
}

type LabeledFilesystemPath = {
  label: string;
  value: string;
  kind?: "file" | "directory";
};

type FilesystemPathIdentity = Omit<LabeledFilesystemPath, "kind"> & {
  kind: "file" | "directory";
  resolved: string;
  canonical: string;
  caseFoldedCanonical: string;
  device?: bigint;
  inode?: bigint;
};

function missingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function canonicalizeThroughExistingParent(resolvedPath: string): Promise<string> {
  let cursor = resolvedPath;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalParent = await fs.realpath(cursor);
      return path.join(canonicalParent, ...missingSegments);
    } catch (error) {
      if (!missingPathError(error)) {
        throw new Error(
          `Cannot resolve filesystem path identity for ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function filesystemPathIdentity(
  descriptor: LabeledFilesystemPath,
): Promise<FilesystemPathIdentity> {
  const resolved = path.resolve(descriptor.value);
  const canonical = await canonicalizeThroughExistingParent(resolved);
  // Absent leaves cannot expose an inode. Conservatively case-fold the full
  // canonical path so publication never treats case aliases as distinct on a
  // case-insensitive filesystem.
  const caseFoldedCanonical = canonical.normalize("NFC").toLowerCase();
  const kind = descriptor.kind ?? "file";
  try {
    const stat = await fs.stat(resolved, { bigint: true });
    return {
      ...descriptor,
      kind,
      resolved,
      canonical,
      caseFoldedCanonical,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    if (!missingPathError(error)) throw error;
    return {
      ...descriptor,
      kind,
      resolved,
      canonical,
      caseFoldedCanonical,
    };
  }
}

function sameFilesystemObject(
  left: FilesystemPathIdentity,
  right: FilesystemPathIdentity,
): boolean {
  return (
    left.canonical === right.canonical ||
    left.caseFoldedCanonical === right.caseFoldedCanonical ||
    (left.device !== undefined &&
      right.device !== undefined &&
      left.device === right.device &&
      left.inode === right.inode)
  );
}

function isStrictFilesystemAncestor(
  ancestor: FilesystemPathIdentity,
  descendant: FilesystemPathIdentity,
): boolean {
  const relative = path.relative(ancestor.caseFoldedCanonical, descendant.caseFoldedCanonical);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasFilesystemTopologyConflict(
  left: FilesystemPathIdentity,
  right: FilesystemPathIdentity,
): boolean {
  if (sameFilesystemObject(left, right)) {
    return left.kind === "file" || right.kind === "file";
  }
  return (
    (left.kind === "file" && isStrictFilesystemAncestor(left, right)) ||
    (right.kind === "file" && isStrictFilesystemAncestor(right, left))
  );
}

function assertFilesystemPathsIsolated(
  left: FilesystemPathIdentity,
  right: FilesystemPathIdentity,
): void {
  if (sameFilesystemObject(left, right)) {
    if (left.kind === "directory" && right.kind === "directory") return;
    throw new Error(`The PowerPoint ${left.label} and ${right.label} must be different files`);
  }
  if (hasFilesystemTopologyConflict(left, right)) {
    throw new Error(
      `The PowerPoint ${left.label} and ${right.label} must not have an ancestor/descendant file-path conflict`,
    );
  }
}

export async function validatePptxFilesystemIsolation({
  outputs,
  inputs,
  protectedDirectories = [],
}: {
  outputs: LabeledFilesystemPath[];
  inputs: LabeledFilesystemPath[];
  protectedDirectories?: Array<Omit<LabeledFilesystemPath, "kind">>;
}): Promise<void> {
  const outputIdentities = await Promise.all(outputs.map(filesystemPathIdentity));
  const inputIdentities = await Promise.all(inputs.map(filesystemPathIdentity));
  const protectedDirectoryIdentities = await Promise.all(
    protectedDirectories.map((descriptor) =>
      filesystemPathIdentity({ ...descriptor, kind: "directory" }),
    ),
  );
  for (let index = 0; index < outputIdentities.length; index += 1) {
    const output = outputIdentities[index];
    for (const protectedDirectory of protectedDirectoryIdentities) {
      if (
        sameFilesystemObject(protectedDirectory, output) ||
        isStrictFilesystemAncestor(protectedDirectory, output)
      ) {
        throw new Error(
          `The PowerPoint ${output.label} must be outside ${protectedDirectory.label}`,
        );
      }
    }
    for (const otherOutput of outputIdentities.slice(index + 1)) {
      assertFilesystemPathsIsolated(output, otherOutput);
    }
    for (const input of inputIdentities) {
      assertFilesystemPathsIsolated(input, output);
    }
  }
}

export type PrivateArtifactStage = {
  directory: string;
  path: string;
};

export async function stagePrivateRegularArtifact({
  parentDirectory,
  filename,
  data,
}: {
  parentDirectory: string;
  filename: string;
  data: string | Buffer | Uint8Array;
}): Promise<PrivateArtifactStage> {
  if (path.basename(filename) !== filename || filename === "." || filename === "..") {
    throw new Error("Private artifact filename must be one path segment");
  }
  await fs.mkdir(parentDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parentDirectory, ".nemoclaw-pptx-"));
  await fs.chmod(directory, 0o700);
  const temporaryPath = path.join(directory, filename);
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    const temporaryStat = await fs.lstat(temporaryPath);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
      throw new Error("Private artifact staging did not create a regular file");
    }
    return { directory, path: temporaryPath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function stagePowerPointBlob(
  blob: DynamicValue,
  outputPath: string,
): Promise<PrivateArtifactStage> {
  if (!(blob?.data instanceof Uint8Array)) {
    throw new Error("PowerPoint export did not return binary artifact bytes");
  }
  // FileBlob.save writes inspect sidecars next to the requested path. Stage only
  // the PowerPoint bytes so an implicit inspect file can never escape the run.
  return stagePrivateRegularArtifact({
    parentDirectory: path.dirname(outputPath),
    filename: "artifact.pptx",
    data: blob.data,
  });
}

async function managedMontageBytes(sharp: DynamicValue, images: Buffer[]): Promise<Buffer> {
  if (images.length < 4 || images.length % 2 !== 0) {
    throw new Error(
      "Managed PowerPoint montage requires complete roadmap pairs and summary slides",
    );
  }
  const slideWidth = 960;
  const slideHeight = 540;
  const padding = 32;
  const gap = 24;
  const resized = await Promise.all(
    images.map((image) =>
      sharp(image).resize(slideWidth, slideHeight, { fit: "fill" }).png().toBuffer(),
    ),
  );
  return sharp({
    create: {
      width: padding * 2 + slideWidth * 2 + gap,
      height:
        padding * 2 +
        slideHeight * Math.ceil(images.length / 2) +
        gap * (Math.ceil(images.length / 2) - 1),
      channels: 4,
      background: "#f2f2f2",
    },
  })
    .composite(
      resized.map((input, index) => ({
        input,
        left: padding + (index % 2) * (slideWidth + gap),
        top: padding + Math.floor(index / 2) * (slideHeight + gap),
      })),
    )
    .webp({ quality: 90 })
    .toBuffer();
}

export type FrozenPptxArtifactInput = PrivateArtifactStage & {
  sha256: string;
  sourcePath: string;
};

export async function freezePptxArtifactInput(filePath: string): Promise<FrozenPptxArtifactInput> {
  const sourcePath = path.resolve(filePath);
  const artifactBytes = await fs.readFile(sourcePath);
  const staged = await stagePrivateRegularArtifact({
    parentDirectory: os.tmpdir(),
    filename: "reviewed-preview.pptx",
    data: artifactBytes,
  });
  return {
    ...staged,
    sha256: sha256Bytes(artifactBytes),
    sourcePath,
  };
}

type StagedSupportingArtifact = PrivateArtifactStage & {
  targetPath: string;
};

type FinalizationArtifact = {
  temporaryPath: string;
  targetPath: string;
};

type PrivateCleanupOperation = {
  path: string;
  remove: () => Promise<void>;
};

type PrivateCleanupFailure = {
  path: string;
  reason: unknown;
};

async function collectPrivateCleanupFailures(
  operations: PrivateCleanupOperation[],
): Promise<PrivateCleanupFailure[]> {
  const results = await Promise.allSettled(operations.map((operation) => operation.remove()));
  return results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ path: operations[index].path, reason: result.reason as unknown }]
      : [],
  );
}

function privateCleanupError(
  context: string,
  failures: PrivateCleanupFailure[],
  cause?: unknown,
): Error {
  const unresolvedPaths = failures.map((failure) => JSON.stringify(failure.path)).join(", ");
  const causes = [cause, ...failures.map((failure) => failure.reason)].filter(
    (value) => value !== undefined,
  );
  return new Error(`${context}. Unresolved private temporary paths: ${unresolvedPaths}`, {
    cause: new AggregateError(causes, context),
  });
}

async function requirePrivateCleanup({
  context,
  operations,
  cause,
}: {
  context: string;
  operations: PrivateCleanupOperation[];
  cause?: unknown;
}): Promise<void> {
  const failures = await collectPrivateCleanupFailures(operations);
  if (failures.length > 0) throw privateCleanupError(context, failures, cause);
}

type FinalizationCleanupDependencies = {
  lstat: (filePath: string) => Promise<{ dev: bigint; ino: bigint }>;
  unlink: (filePath: string) => Promise<void>;
  removeTemporary: (filePath: string) => Promise<void>;
};

const finalizationCleanupDependencies: FinalizationCleanupDependencies = {
  lstat: (filePath) => fs.lstat(filePath, { bigint: true }),
  unlink: (filePath) => fs.unlink(filePath),
  removeTemporary: (filePath) => fs.rm(filePath, { force: true }),
};

function rollbackFinalizationOperation(
  artifact: FinalizationArtifact,
  dependencies: FinalizationCleanupDependencies,
): PrivateCleanupOperation {
  return {
    path: artifact.targetPath,
    remove: async () => {
      let targetStat: { dev: bigint; ino: bigint };
      try {
        targetStat = await dependencies.lstat(artifact.targetPath);
      } catch (error) {
        if (missingPathError(error)) return;
        throw error;
      }
      let temporaryStat: { dev: bigint; ino: bigint };
      try {
        temporaryStat = await dependencies.lstat(artifact.temporaryPath);
      } catch (error) {
        if (missingPathError(error)) {
          throw new Error(
            `Temporary hard-link witness is missing for rollback target ${JSON.stringify(artifact.targetPath)}`,
            { cause: error },
          );
        }
        throw error;
      }
      if (temporaryStat.dev !== targetStat.dev || temporaryStat.ino !== targetStat.ino) {
        throw new Error(
          `Rollback target ${JSON.stringify(artifact.targetPath)} no longer matches its invocation-created hard link`,
        );
      }
      try {
        await dependencies.unlink(artifact.targetPath);
      } catch (error) {
        if (!missingPathError(error)) throw error;
      }
    },
  };
}

async function failedFinalizationCleanupFailures({
  createdArtifacts,
  allArtifacts,
  dependencies = finalizationCleanupDependencies,
}: {
  createdArtifacts: FinalizationArtifact[];
  allArtifacts: FinalizationArtifact[];
  dependencies?: FinalizationCleanupDependencies;
}): Promise<PrivateCleanupFailure[]> {
  const rollbackFailures = await collectPrivateCleanupFailures(
    [...createdArtifacts]
      .reverse()
      .map((artifact) => rollbackFinalizationOperation(artifact, dependencies)),
  );
  const temporaryFailures = await collectPrivateCleanupFailures(
    allArtifacts.map((artifact) => ({
      path: artifact.temporaryPath,
      remove: () => dependencies.removeTemporary(artifact.temporaryPath),
    })),
  );
  return [...rollbackFailures, ...temporaryFailures];
}

export const pptxCleanupTestOnly = {
  failedFinalizationCleanupFailures,
  requirePrivateCleanup,
};

async function requirePowerPointOutputAbsent(outputPath: string): Promise<void> {
  try {
    await fs.lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`PowerPoint output already exists and will not be overwritten: ${outputPath}`);
}

export async function finalizePptxArtifacts({
  temporaryOutputPath,
  outputPath,
  temporaryReadbackPath,
  readbackPath,
  temporaryInspectPath,
  inspectOutputPath,
  supportingArtifacts = [],
  mode,
  isolation,
}: {
  temporaryOutputPath: string;
  outputPath: string;
  temporaryReadbackPath: string;
  readbackPath: string;
  temporaryInspectPath?: string;
  inspectOutputPath?: string;
  supportingArtifacts?: Array<{
    temporaryPath: string;
    targetPath: string;
  }>;
  mode: ValidationMode;
  isolation?: {
    outputs: LabeledFilesystemPath[];
    inputs: LabeledFilesystemPath[];
    protectedDirectories?: Array<Omit<LabeledFilesystemPath, "kind">>;
  };
}): Promise<void> {
  const outputArtifact = {
    temporaryPath: temporaryOutputPath,
    targetPath: outputPath,
  };
  const preOutputArtifacts: FinalizationArtifact[] = [
    {
      temporaryPath: temporaryReadbackPath,
      targetPath: readbackPath,
    },
    ...(temporaryInspectPath && inspectOutputPath
      ? [
          {
            temporaryPath: temporaryInspectPath,
            targetPath: inspectOutputPath,
          },
        ]
      : []),
    ...supportingArtifacts,
  ];
  const allArtifacts = [outputArtifact, ...preOutputArtifacts];
  const temporaryCleanupOperations = (): PrivateCleanupOperation[] =>
    allArtifacts.map((artifact) => ({
      path: artifact.temporaryPath,
      remove: () => fs.rm(artifact.temporaryPath, { force: true }),
    }));

  const createdArtifacts: FinalizationArtifact[] = [];
  try {
    if (isolation) await validatePptxFilesystemIsolation(isolation);
    // The PPTX is the commit marker in both modes. Every supporting artifact
    // reaches a fresh no-clobber destination before the primary output appears.
    for (const artifact of [...preOutputArtifacts, outputArtifact]) {
      await fs.link(artifact.temporaryPath, artifact.targetPath);
      createdArtifacts.push(artifact);
    }
  } catch (error) {
    const cleanupFailures = await failedFinalizationCleanupFailures({
      createdArtifacts,
      allArtifacts,
    });
    if (cleanupFailures.length > 0) {
      throw privateCleanupError(
        `PowerPoint ${mode} finalization failed before the primary output was created and cleanup also failed`,
        cleanupFailures,
        error,
      );
    }
    throw error;
  }
  await requirePrivateCleanup({
    context: `PowerPoint ${mode} finalization completed but private staging cleanup failed`,
    operations: temporaryCleanupOperations(),
  });
}

export function validatePptxParityReceipt({
  receipt,
  comparison,
  model,
  current,
  googleReadback,
  pptxReadback,
  googleReadbackPath,
  pptxReadbackPath,
  googleReadbackSha256,
  pptxReadbackSha256,
}: {
  receipt: DynamicValue;
  comparison: DynamicValue;
  model: DynamicValue;
  current: DynamicValue;
  googleReadback: DynamicValue;
  pptxReadback: DynamicValue;
  googleReadbackPath: string;
  pptxReadbackPath: string;
  googleReadbackSha256: string;
  pptxReadbackSha256: string;
}): void {
  if (!receipt || receipt.schemaVersion !== 1) {
    throw new Error("Publication requires schemaVersion 1 parity evidence");
  }
  if (receipt.equal !== true || comparison.equal !== true) {
    throw new Error("Publication parity evidence reports a cross-format mismatch");
  }
  if (
    !Array.isArray(receipt.errors) ||
    receipt.errors.length !== 0 ||
    comparison.errors.length !== 0
  ) {
    throw new Error("Publication parity evidence contains unresolved errors");
  }
  if (receipt.modelSha256 !== model.modelSha256) {
    throw new Error("Publication parity evidence differs for modelSha256");
  }

  const googleArtifact = receipt.googleArtifact;
  const pptxArtifact = receipt.pptxArtifact;
  const googleId = requiredNonemptyString(googleArtifact?.id, "Parity Google artifact id");
  const googleRevisionId = requiredNonemptyString(
    googleArtifact?.revisionId,
    "Parity Google artifact revisionId",
  );
  const receiptGoogleReadbackPath = requiredAbsolutePath(
    googleArtifact?.readbackPath,
    "Parity Google readbackPath",
  );
  const receiptPptxArtifactPath = requiredAbsolutePath(
    pptxArtifact?.id,
    "Parity PowerPoint artifact id",
  );
  const receiptPptxReadbackPath = requiredAbsolutePath(
    pptxArtifact?.readbackPath,
    "Parity PowerPoint readbackPath",
  );
  if (
    receiptGoogleReadbackPath !== googleReadbackPath ||
    receiptPptxReadbackPath !== pptxReadbackPath
  ) {
    throw new Error("Publication parity evidence names different readback files");
  }
  if (
    requiredSha256(googleArtifact?.readbackSha256, "Parity Google readbackSha256") !==
      googleReadbackSha256 ||
    requiredSha256(pptxArtifact?.readbackSha256, "Parity PowerPoint readbackSha256") !==
      pptxReadbackSha256
  ) {
    throw new Error("Publication parity evidence differs from actual readback bytes");
  }
  if (
    receiptPptxArtifactPath !== current.previewPptxPath ||
    requiredSha256(pptxArtifact?.sha256, "Parity PowerPoint artifact sha256") !==
      current.previewPptxSha256 ||
    pptxArtifact?.revisionId !== current.previewPptxSha256
  ) {
    throw new Error("Publication parity evidence differs from the reviewed PowerPoint artifact");
  }

  if (
    googleReadback?.artifact?.kind !== "google-slides" ||
    googleReadback.artifact.id !== googleId ||
    googleReadback.artifact.revisionId !== googleRevisionId
  ) {
    throw new Error("Publication parity evidence differs from the Google Slides readback identity");
  }
  if (
    pptxReadback?.artifact?.kind !== "pptx" ||
    pptxReadback.artifact.id !== current.previewPptxPath ||
    pptxReadback.artifact.revisionId !== current.previewPptxSha256 ||
    pptxReadback.artifact.sha256 !== current.previewPptxSha256 ||
    pptxReadback.roleMapSha256 !== current.roleMapSha256 ||
    pptxReadback.templateSha256 !== current.templateSha256
  ) {
    throw new Error(
      "Publication parity evidence differs from the reviewed PowerPoint readback identity",
    );
  }

  for (const key of [
    "expectedProjectionSha256",
    "googleProjectionSha256",
    "pptxProjectionSha256",
    "googleVisibleTextSha256",
    "pptxVisibleTextSha256",
    "expectedHyperlinkSha256",
    "googleHyperlinkSha256",
    "pptxHyperlinkSha256",
    "expectedConnectorSha256",
    "googleConnectorSha256",
    "pptxConnectorSha256",
  ]) {
    const expected = requiredSha256(comparison[key], `Computed parity ${key}`);
    if (requiredSha256(receipt[key], `Parity receipt ${key}`) !== expected) {
      throw new Error(`Publication parity evidence differs for ${key}`);
    }
  }
  if (
    comparison.expectedProjectionSha256 !== comparison.googleProjectionSha256 ||
    comparison.expectedProjectionSha256 !== comparison.pptxProjectionSha256 ||
    comparison.googleVisibleTextSha256 !== comparison.pptxVisibleTextSha256 ||
    comparison.expectedHyperlinkSha256 !== comparison.googleHyperlinkSha256 ||
    comparison.expectedHyperlinkSha256 !== comparison.pptxHyperlinkSha256 ||
    comparison.expectedConnectorSha256 !== comparison.googleConnectorSha256 ||
    comparison.expectedConnectorSha256 !== comparison.pptxConnectorSha256
  ) {
    throw new Error("Publication parity hashes are not equal");
  }
}

export async function validatePptxPublicationFiles({
  approvalPath,
  evidencePath,
  parityEvidencePath,
  reviewedPreviewPptxPath,
  outputPath,
  current,
  model,
  roleMap,
  protectedTextSha256ByRole,
  verifiedPreviewReadback,
}: {
  approvalPath: string;
  evidencePath: string;
  parityEvidencePath: string;
  reviewedPreviewPptxPath: string;
  outputPath: string;
  current: DynamicValue;
  model: DynamicValue;
  roleMap?: DynamicValue;
  protectedTextSha256ByRole: ProtectedTextSha256ByRole;
  verifiedPreviewReadback?: DynamicValue;
}): Promise<DynamicValue> {
  if (
    !verifiedPreviewReadback ||
    typeof verifiedPreviewReadback !== "object" ||
    !artifactVerifiedReadbacks.has(verifiedPreviewReadback)
  ) {
    throw new Error(
      "Publication requires an artifact-derived verification of the reviewed PowerPoint preview",
    );
  }
  const resolvedOutputPath = path.resolve(outputPath);
  const previewPptxPath = path.resolve(reviewedPreviewPptxPath);
  const parityReceiptPath = path.resolve(parityEvidencePath);
  if (previewPptxPath === resolvedOutputPath) {
    throw new Error("The reviewed preview PPTX and publication output must be different files");
  }
  const verifiedPreviewPptxSha256 = requiredSha256(
    verifiedPreviewReadback.artifact?.sha256,
    "Artifact-derived reviewed preview sha256",
  );
  if (
    verifiedPreviewReadback.artifact?.kind !== "pptx" ||
    verifiedPreviewReadback.artifact.id !== previewPptxPath ||
    verifiedPreviewReadback.artifact.revisionId !== verifiedPreviewPptxSha256
  ) {
    throw new Error(
      "Artifact-derived reviewed preview identity differs from the requested preview",
    );
  }
  const [approval, evidence, parityReceiptBytes] = await Promise.all([
    fs.readFile(path.resolve(approvalPath), "utf8").then(JSON.parse),
    fs.readFile(path.resolve(evidencePath), "utf8").then(JSON.parse),
    fs.readFile(parityReceiptPath),
  ]);
  const parityReceipt = JSON.parse(parityReceiptBytes.toString("utf8"));
  const googleReadbackPath = requiredAbsolutePath(
    parityReceipt.googleArtifact?.readbackPath,
    "Parity Google readbackPath",
  );
  const pptxReadbackPath = requiredAbsolutePath(
    parityReceipt.pptxArtifact?.readbackPath,
    "Parity PowerPoint readbackPath",
  );
  const [googleReadbackBytes, pptxReadbackBytes] = await Promise.all([
    fs.readFile(googleReadbackPath),
    fs.readFile(pptxReadbackPath),
  ]);
  const googleReadback = JSON.parse(googleReadbackBytes.toString("utf8"));
  const pptxReadback = JSON.parse(pptxReadbackBytes.toString("utf8"));
  if (canonicalJson(pptxReadback) !== canonicalJson(verifiedPreviewReadback)) {
    throw new Error(
      "Publication PowerPoint readback differs from the artifact-derived reviewed preview",
    );
  }
  const comparison = compareParity(
    model,
    googleReadback,
    pptxReadback,
    protectedTextSha256ByRole,
    roleMap ? managedOperationTextByIdentity(model, roleMap) : {},
  );
  const boundCurrent = {
    ...current,
    targetId: resolvedOutputPath,
    outputPath: resolvedOutputPath,
    previewPptxPath,
    previewPptxSha256: verifiedPreviewPptxSha256,
    parityReceiptPath,
    parityReceiptSha256: sha256Bytes(parityReceiptBytes),
    managedSlideIds: model.slides.map(modelSlideIdentity),
  };
  validatePptxParityReceipt({
    receipt: parityReceipt,
    comparison,
    model,
    current: boundCurrent,
    googleReadback,
    pptxReadback,
    googleReadbackPath,
    pptxReadbackPath,
    googleReadbackSha256: sha256Bytes(googleReadbackBytes),
    pptxReadbackSha256: sha256Bytes(pptxReadbackBytes),
  });
  validatePptxPublicationInputs({ approval, evidence, current: boundCurrent });
  return {
    ...boundCurrent,
    publicationInputPaths: [
      path.resolve(approvalPath),
      path.resolve(evidencePath),
      parityReceiptPath,
      previewPptxPath,
      googleReadbackPath,
      pptxReadbackPath,
    ],
  };
}

export async function validatePptxPublicationSourceModel({
  model,
  repoRoot,
  snapshotPath,
  docsPath,
  presentationMapPath,
  claimsPath,
  narrativeInputPath,
}: {
  model: DynamicValue;
  repoRoot: string;
  snapshotPath: string;
  docsPath: string;
  presentationMapPath: string;
  claimsPath: string;
  narrativeInputPath: string;
}): Promise<DynamicValue> {
  const [snapshot, docs, presentation, claims, narrative] = await Promise.all(
    [snapshotPath, docsPath, presentationMapPath, claimsPath, narrativeInputPath].map(
      async (sourcePath) => JSON.parse(await fs.readFile(path.resolve(sourcePath), "utf8")),
    ),
  );
  verifyDocumentationEvidence({ repoRoot, evidence: docs, claims });
  const rebuilt = buildSlideModel({
    snapshot,
    docs,
    presentation,
    claims,
    narrative,
    templateFingerprint: model.templateFingerprint,
  });
  if (!Buffer.from(canonicalJson(rebuilt)).equals(Buffer.from(canonicalJson(model)))) {
    throw new Error(
      "Publication slide model differs from the canonical model rebuilt from the exact source inputs",
    );
  }
  return rebuilt;
}

function managedNotesFromArtifact(slide: DynamicValue): string {
  return String(slide.speakerNotes.text ?? "").replace(/\r\n?/gu, "\n");
}

function sourcesFromManagedNotes(notes: string): DynamicValue[] {
  const lines = notes.replace(/\r\n?/gu, "\n").split("\n");
  const start = lines.indexOf("[Sources]");
  if (start < 0) throw new Error("Managed speaker notes lack [Sources]");
  const sources: DynamicValue[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("[")) break;
    if (line.trim().length === 0) continue;
    const parts = line.split(" | ");
    if (parts.length !== 5 || parts.some((part, index) => index !== 3 && !part)) {
      throw new Error("Managed speaker notes contain an invalid source record");
    }
    const [sourceId, kind, location, commitSha, digest] = parts;
    let locationFields: DynamicValue;
    if (kind === "github") locationFields = { url: location };
    else if (kind === "mapping") locationFields = { path: location };
    else if (kind === "claim") {
      const headingSeparator = location.lastIndexOf("#");
      if (headingSeparator <= 0 || headingSeparator === location.length - 1) {
        throw new Error("Managed claim source lacks its path and heading");
      }
      locationFields = {
        path: location.slice(0, headingSeparator),
        heading: location.slice(headingSeparator + 1),
      };
    } else {
      throw new Error(`Managed speaker notes contain unknown source kind: ${kind}`);
    }
    sources.push({
      sourceId,
      kind,
      ...locationFields,
      ...(commitSha ? { commitSha } : {}),
      digest,
    });
  }
  if (sources.length === 0) {
    throw new Error("Managed speaker notes contain no source records");
  }
  return sources;
}

function verifiedSemanticReadback(
  model: DynamicValue,
  managedSlides: Array<{ slide: DynamicValue }>,
  visibleTextByRole: Map<string, ClassifiedArtifactText>,
  hyperlinkInventoryByRole: Map<string, HyperlinkInventoryEntry[]>,
  connectorInventoryByRole: Map<string, ConnectorInventoryEntry[]>,
  capabilityStructureByRole: Map<string, CapabilityStructureInventory>,
  weeklyMilestoneStructureByRole: Map<string, WeeklyMilestoneStructureInventory>,
  artifact: DynamicValue,
  roleMapSha256: string,
  templateSha256: string,
) {
  return {
    schemaVersion: 1,
    modelSha256: model.modelSha256,
    snapshotSha256: model.snapshotSha256,
    templateFingerprint: model.templateFingerprint,
    templateSha256,
    roleMapSha256,
    artifact,
    slides: model.slides.map((slide: DynamicValue, index: number) => {
      const identity = modelSlideIdentity(slide);
      const { managedNotes: _managedNotes, sources: _sources, ...content } = slide;
      const managedNotes = managedNotesFromArtifact(managedSlides[index].slide);
      const sources = sourcesFromManagedNotes(managedNotes);
      if (canonicalJson(sources) !== canonicalJson(slide.sources)) {
        throw new Error(`${slide.role} artifact source records differ from the shared model`);
      }
      const visibleText = visibleTextByRole.get(identity);
      if (!visibleText) {
        throw new Error(`${slide.role} lacks classified artifact text`);
      }
      const hyperlinkInventory = hyperlinkInventoryByRole.get(identity);
      if (!hyperlinkInventory) {
        throw new Error(`${slide.role} lacks native PowerPoint hyperlink readback`);
      }
      const connectorInventory = connectorInventoryByRole.get(identity);
      if (!connectorInventory) {
        throw new Error(`${slide.role} lacks native PowerPoint connector readback`);
      }
      const capabilityStructureInventory = capabilityStructureByRole.get(identity);
      if (slide.role === "roadmap-capability" && !capabilityStructureInventory) {
        throw new Error(`${identity} lacks native PowerPoint capability structure readback`);
      }
      const weeklyMilestoneStructureInventory = weeklyMilestoneStructureByRole.get(identity);
      if (slide.role === "weekly-release" && !weeklyMilestoneStructureInventory) {
        throw new Error(`${identity} lacks native PowerPoint weekly milestone structure readback`);
      }
      return {
        role: slide.role,
        ...(slide.instanceId ? { instanceId: slide.instanceId } : {}),
        nativeObjectKinds: actualNativeKinds(managedSlides[index].slide),
        visibleTextInventory: visibleText.visibleTextInventory,
        managedVisibleTextInventory: visibleText.managedVisibleTextInventory,
        protectedVisibleTextInventory: visibleText.protectedVisibleTextInventory,
        inheritedVisibleTextInventory: visibleText.inheritedVisibleTextInventory,
        hyperlinkInventory,
        connectorInventory,
        ...(capabilityStructureInventory ? { capabilityStructureInventory } : {}),
        ...(weeklyMilestoneStructureInventory ? { weeklyMilestoneStructureInventory } : {}),
        content,
        managedNotes,
        sources,
      };
    }),
  };
}

function currentSearchedTargetText(
  presentation: DynamicValue,
  slide: DynamicValue,
  slideModel: DynamicValue,
  contract: DynamicValue,
): Map<string, string> {
  return new Map(
    (contract.operations ?? [])
      .filter(
        (operation: DynamicValue) =>
          operation.search !== undefined &&
          !operationTargetsMissingRoadmapSlot(slideModel, operation),
      )
      .map((operation: DynamicValue) => [
        targetKey(operation.target),
        normalizedTargetText(resolveTarget(presentation, slide, operation.target)),
      ]),
  );
}

export async function readVerifiedPptxArtifact({
  filePath,
  model,
  roleMap,
  roleMapSha256,
  templateSha256,
  runtime,
  mode,
  sourceKind = "pptx",
}: {
  filePath: string;
  model: DynamicValue;
  roleMap: DynamicValue;
  roleMapSha256: string;
  templateSha256: string;
  runtime: RuntimeModules;
  mode: ValidationMode;
  sourceKind?: "pptx" | "google-slides-export";
}): Promise<DynamicValue> {
  const frozenArtifact = await freezePptxArtifactInput(filePath);
  const artifactSha256 = frozenArtifact.sha256;
  try {
    let presentation: DynamicValue;
    try {
      presentation = await runtime.PresentationFile.importPptx(
        await runtime.FileBlob.load(frozenArtifact.path),
      );
    } catch (error) {
      throw new Error("Reviewed preview is not an importable PowerPoint artifact", {
        cause: error,
      });
    }
    const managedSlides = assertManagedOrder(presentation, model);
    const artifactTextLayers: Array<{
      role: ManagedRole;
      instanceId?: string;
      slideLocalText: string[];
      inheritedText: string[];
    }> = [];
    const layoutByRole = new Map<string, DynamicValue>();
    for (const [index, entry] of managedSlides.entries()) {
      const { role, slide } = entry;
      const modelSlide = model.slides[index];
      const contract = roleMap.roles[role];
      const searchedTargetText = currentSearchedTargetText(
        presentation,
        slide,
        modelSlide,
        contract,
      );
      assertAudienceText(slide, modelSlide);
      assertForbiddenText(slide, contract, modelSlide, mode);
      if (role === "roadmap-capability") {
        assertMatrix(presentation, slide, modelSlide, contract, searchedTargetText);
      } else if (role === "markitecture") {
        assertMarkitecture(presentation, slide, modelSlide, contract);
      } else {
        assertTextOperations(
          presentation,
          slide,
          modelSlide,
          contract.operations,
          searchedTargetText,
        );
        assertRichTextOperations(presentation, slide, modelSlide, contract.richTextOperations);
        assertOutcomeOperations(presentation, slide, modelSlide, contract.outcomeOperations);
        assertOutcomeListOperations(
          presentation,
          slide,
          modelSlide,
          contract.outcomeListOperations,
        );
        assertMetricOperations(presentation, slide, modelSlide, contract.metricOperations);
        assertMilestoneRowOperations(
          presentation,
          slide,
          modelSlide,
          contract.milestoneRowOperations,
        );
      }
      if (sourceKind === "pptx") {
        assertGeometryOperations(presentation, slide, contract.geometryOperations);
      }
      const nativeKinds = normalizeNativeKinds(role, actualNativeKinds(slide));
      if (JSON.stringify(nativeKinds) !== JSON.stringify(NATIVE_KINDS[role])) {
        throw new Error(`${role} reviewed preview native object kinds differ`);
      }
      const layout = JSON.parse(await (await slide.export({ format: "layout" })).text());
      assertLayoutBounds(layout, role);
      layoutByRole.set(entry.instanceId ?? role, layout);
      artifactTextLayers.push({
        role,
        ...(entry.instanceId ? { instanceId: entry.instanceId } : {}),
        ...visibleTextLayersFromLayout(layout),
      });
    }
    for (const capability of model.slides.filter(
      (slide: DynamicValue) => slide.role === "roadmap-capability",
    )) {
      await assertTableLinks(runtime.JSZip, frozenArtifact.path, capability);
    }
    const protectedTextSha256ByRole = protectedTextPolicyFromRoleMap(model, roleMap);
    const classifiedText = classifyArtifactTextInventories(
      model,
      artifactTextLayers,
      protectedTextSha256ByRole,
      managedOperationTextByIdentity(model, roleMap),
    );
    for (const slideText of classifiedText) {
      if (slideText.unexpectedVisibleTextInventory.length > 0) {
        throw new Error(
          `${slideText.role} reviewed preview contains stale or unmodeled slide-local text`,
        );
      }
    }
    const hyperlinkInventoryByRole = await hyperlinkInventoryByRoleFromPptx(
      runtime.JSZip,
      frozenArtifact.path,
      managedSlides,
      roleMap,
      model,
    );
    const connectorInventoryByRole = await connectorInventoryByRoleFromPptx(
      runtime.JSZip,
      frozenArtifact.path,
      managedSlides,
    );
    const capabilityStructureByRole = await capabilityStructureInventoryByRoleFromPptx(
      runtime.JSZip,
      frozenArtifact.path,
      managedSlides,
      roleMap,
      model,
      layoutByRole,
    );
    const weeklyMilestoneStructureByRole = await weeklyMilestoneStructureInventoryByRoleFromPptx(
      runtime.JSZip,
      frozenArtifact.path,
      managedSlides,
      roleMap,
      model,
      layoutByRole,
    );
    const readback = verifiedSemanticReadback(
      model,
      managedSlides,
      new Map(
        classifiedText.map((slideText) => [slideText.instanceId ?? slideText.role, slideText]),
      ),
      hyperlinkInventoryByRole,
      connectorInventoryByRole,
      capabilityStructureByRole,
      weeklyMilestoneStructureByRole,
      {
        kind: "pptx",
        id: path.resolve(filePath),
        revisionId: artifactSha256,
        sha256: artifactSha256,
      },
      roleMapSha256,
      templateSha256,
    );
    const selfParity = compareParity(
      model,
      readback,
      readback,
      protectedTextSha256ByRole,
      managedOperationTextByIdentity(model, roleMap),
    );
    if (!selfParity.equal) {
      throw new Error(
        `Reviewed PowerPoint artifact differs from the shared model: ${selfParity.errors.map((error: DynamicValue) => error.code).join(", ")}`,
      );
    }
    artifactVerifiedReadbacks.add(readback);
    return readback;
  } finally {
    await fs.rm(frozenArtifact.directory, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "preview" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (!next && argument !== "--help" && argument !== "-h")
      throw new Error(`Missing value for ${argument}`);
    if (argument === "--model") options.model = next;
    else if (argument === "--template-pptx") options.template = next;
    else if (argument === "--template-workspace") options.templateWorkspace = next;
    else if (argument === "--template-frame-map") options.templateFrameMap = next;
    else if (argument === "--role-map") options.roleMap = next;
    else if (argument === "--output") options.output = next;
    else if (argument === "--preview-dir") options.previewDir = next;
    else if (argument === "--layout-dir") options.layoutDir = next;
    else if (argument === "--readback") options.readback = next;
    else if (argument === "--inspect-output") options.inspectOutput = next;
    else if (argument === "--approval") options.approval = next;
    else if (argument === "--validation-evidence") options.validationEvidence = next;
    else if (argument === "--parity-evidence") options.parityEvidence = next;
    else if (argument === "--reviewed-preview-pptx") options.reviewedPreviewPptx = next;
    else if (argument === "--repo-root") options.repoRoot = next;
    else if (argument === "--snapshot") options.snapshot = next;
    else if (argument === "--docs") options.docs = next;
    else if (argument === "--presentation-map") options.presentationMap = next;
    else if (argument === "--claims") options.claims = next;
    else if (argument === "--narrative-input") options.narrativeInput = next;
    else if (argument === "--mode" && (next === "preview" || next === "publish"))
      options.mode = next;
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: $RUNTIME_NODE build-pptx.mts --model PATH --template-pptx PATH --template-workspace DIR --template-frame-map PATH --role-map PATH --output PATH --preview-dir DIR --layout-dir DIR --readback PATH [--inspect-output PATH] [--mode preview|publish] [--approval PATH --validation-evidence PATH --parity-evidence PATH --reviewed-preview-pptx PATH --repo-root PATH --snapshot PATH --docs PATH --presentation-map PATH --claims PATH --narrative-input PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

export async function buildPptx(options: BuildPptxOptions): Promise<DynamicValue> {
  const templatePath = path.resolve(options.template);
  const templateWorkflow = resolveTemplateWorkflowPaths(options);
  const outputPath = path.resolve(options.output);
  const readbackPath = path.resolve(options.readback);
  const inspectOutputPath = options.inspectOutput ? path.resolve(options.inspectOutput) : undefined;
  let managedOutputs = MANAGED_ROLES.map((role, index) => ({
    identity: role as string,
    stem: `${String(index + 1).padStart(2, "0")}-${role}`,
  }));
  const layoutOutputPaths = new Map(
    managedOutputs.map(({ identity, stem }) => [
      identity,
      path.join(path.resolve(options.layoutDir), `${stem}.json`),
    ]),
  );
  const previewOutputPaths = new Map(
    managedOutputs.map(({ identity, stem }) => [
      identity,
      path.join(path.resolve(options.previewDir), `${stem}.png`),
    ]),
  );
  const montageOutputPath = path.join(path.resolve(options.previewDir), "managed-montage.webp");
  const primaryOutputPaths: LabeledFilesystemPath[] = [
    { label: "output", value: outputPath },
    { label: "readback output", value: readbackPath },
    ...(inspectOutputPath ? [{ label: "inspect output", value: inspectOutputPath }] : []),
  ];
  let supportingOutputPaths: LabeledFilesystemPath[] = [
    ...managedOutputs.flatMap(({ identity }) => [
      {
        label: `${identity} layout output`,
        value: layoutOutputPaths.get(identity) as string,
      },
      {
        label: `${identity} preview output`,
        value: previewOutputPaths.get(identity) as string,
      },
    ]),
    { label: "preview montage output", value: montageOutputPath },
  ];
  const outputDirectoryPaths: LabeledFilesystemPath[] = [
    {
      label: "preview directory path",
      value: path.resolve(options.previewDir),
      kind: "directory",
    },
    {
      label: "layout directory path",
      value: path.resolve(options.layoutDir),
      kind: "directory",
    },
  ];
  let outputPaths = [...primaryOutputPaths, ...supportingOutputPaths];
  let isolationOutputPaths = [
    ...primaryOutputPaths,
    ...outputDirectoryPaths,
    ...supportingOutputPaths,
  ];
  const protectedOutputDirectories = [
    {
      label: "--template-workspace",
      value: templateWorkflow.workspace,
    },
  ];
  const baseInputPaths: LabeledFilesystemPath[] = [
    { label: "slide model", value: options.model },
    { label: "source template", value: templatePath },
    { label: "role map", value: options.roleMap },
    { label: "template frame map", value: templateWorkflow.frameMap },
    { label: "template inspection", value: templateWorkflow.inspect },
    {
      label: "template inspection manifest",
      value: templateWorkflow.inspectManifest,
    },
    { label: "template audit", value: templateWorkflow.audit },
    { label: "template deviation log", value: templateWorkflow.deviationLog },
    { label: "slide-model schema", value: fileURLToPath(SLIDE_MODEL_SCHEMA) },
    ...(options.mode === "publish"
      ? [
          { label: "approval", value: options.approval ?? "" },
          {
            label: "validation evidence",
            value: options.validationEvidence ?? "",
          },
          { label: "parity evidence", value: options.parityEvidence ?? "" },
          {
            label: "reviewed preview",
            value: options.reviewedPreviewPptx ?? "",
          },
          {
            label: "repository root",
            value: options.repoRoot ?? "",
            kind: "directory" as const,
          },
          { label: "snapshot", value: options.snapshot ?? "" },
          { label: "documentation evidence", value: options.docs ?? "" },
          {
            label: "presentation map",
            value: options.presentationMap ?? "",
          },
          { label: "claims ledger", value: options.claims ?? "" },
          {
            label: "narrative input",
            value: options.narrativeInput ?? "",
          },
        ].filter((descriptor) => descriptor.value.length > 0)
      : []),
  ];
  await validatePptxFilesystemIsolation({
    outputs: isolationOutputPaths,
    inputs: baseInputPaths,
    protectedDirectories: protectedOutputDirectories,
  });
  for (const output of outputPaths) {
    await requirePowerPointOutputAbsent(path.resolve(output.value));
  }
  const [modelBytes, roleMapBytes, templateBytes, schema] = await Promise.all([
    fs.readFile(path.resolve(options.model)),
    fs.readFile(path.resolve(options.roleMap)),
    fs.readFile(templatePath),
    fs.readFile(SLIDE_MODEL_SCHEMA, "utf8").then(JSON.parse),
  ]);
  const model = JSON.parse(modelBytes.toString("utf8"));
  const roleMap = JSON.parse(roleMapBytes.toString("utf8"));
  validatePptxModel(model, schema, options.mode);
  managedOutputs = model.slides.map((slide: DynamicValue, index: number) => {
    const identity = modelSlideIdentity(slide);
    const stem =
      slide.pageCount === 1 || !slide.instanceId
        ? slide.role
        : String(slide.instanceId).replaceAll(".", "-");
    return { identity, stem: `${String(index + 1).padStart(2, "0")}-${stem}` };
  });
  layoutOutputPaths.clear();
  previewOutputPaths.clear();
  for (const { identity, stem } of managedOutputs) {
    layoutOutputPaths.set(identity, path.join(path.resolve(options.layoutDir), `${stem}.json`));
    previewOutputPaths.set(identity, path.join(path.resolve(options.previewDir), `${stem}.png`));
  }
  supportingOutputPaths = [
    ...managedOutputs.flatMap(({ identity }) => [
      {
        label: `${identity} layout output`,
        value: layoutOutputPaths.get(identity) as string,
      },
      {
        label: `${identity} preview output`,
        value: previewOutputPaths.get(identity) as string,
      },
    ]),
    { label: "preview montage output", value: montageOutputPath },
  ];
  outputPaths = [...primaryOutputPaths, ...supportingOutputPaths];
  isolationOutputPaths = [...primaryOutputPaths, ...outputDirectoryPaths, ...supportingOutputPaths];
  await validatePptxFilesystemIsolation({
    outputs: isolationOutputPaths,
    inputs: baseInputPaths,
    protectedDirectories: protectedOutputDirectories,
  });
  for (const output of outputPaths) await requirePowerPointOutputAbsent(path.resolve(output.value));
  const templateSha256 = sha256Bytes(templateBytes);
  const roleMapSha256 = sha256Bytes(roleMapBytes);
  if (
    roleMap.schemaVersion !== 1 ||
    roleMap.templateFingerprint !== model.templateFingerprint ||
    roleMap.templateSha256 !== templateSha256 ||
    !roleMap.roles
  ) {
    throw new Error(
      "Runtime role map does not match the validated template fingerprint and file hash",
    );
  }
  for (const role of MANAGED_ROLES) {
    if (!roleMap.roles[role]?.preArchive)
      throw new Error(`Runtime role ${role} is missing or post-archive`);
  }
  validateWeeklyMilestoneRowRoleMap(roleMap);
  const protectedTextSha256ByRole = protectedTextPolicyFromRoleMap(model, roleMap);
  let runtime: RuntimeModules | undefined;
  let presentationRuntime: PresentationRuntimePaths | undefined;

  let publicationInputPaths: string[] = [];
  if (options.mode === "publish") {
    if (
      !options.approval ||
      !options.validationEvidence ||
      !options.parityEvidence ||
      !options.reviewedPreviewPptx ||
      !options.repoRoot ||
      !options.snapshot ||
      !options.docs ||
      !options.presentationMap ||
      !options.claims ||
      !options.narrativeInput
    ) {
      throw new Error(
        "Publication requires --approval, --validation-evidence, --parity-evidence, --reviewed-preview-pptx, --repo-root, --snapshot, --docs, --presentation-map, --claims, and --narrative-input",
      );
    }
    await validatePptxPublicationSourceModel({
      model,
      repoRoot: options.repoRoot,
      snapshotPath: options.snapshot,
      docsPath: options.docs,
      presentationMapPath: options.presentationMap,
      claimsPath: options.claims,
      narrativeInputPath: options.narrativeInput,
    });
    presentationRuntime = await validatePresentationRuntimeEnvironment();
    runtime = await loadRuntime();
    const verifiedPreviewReadback = await readVerifiedPptxArtifact({
      filePath: path.resolve(options.reviewedPreviewPptx),
      model,
      roleMap,
      roleMapSha256,
      templateSha256,
      runtime,
      mode: "publish",
    });
    const publicationBinding = await validatePptxPublicationFiles({
      approvalPath: options.approval,
      evidencePath: options.validationEvidence,
      parityEvidencePath: options.parityEvidence,
      reviewedPreviewPptxPath: options.reviewedPreviewPptx,
      outputPath,
      model,
      roleMap,
      current: {
        targetRevision: "absent",
        snapshotSha256: model.snapshotSha256,
        modelSha256: model.modelSha256,
        templateFingerprint: model.templateFingerprint,
        templateSha256,
        roleMapSha256,
      },
      protectedTextSha256ByRole,
      verifiedPreviewReadback,
    });
    publicationInputPaths = publicationBinding.publicationInputPaths;
    await validatePptxFilesystemIsolation({
      outputs: isolationOutputPaths,
      inputs: [
        ...baseInputPaths,
        ...publicationInputPaths.map((value, index) => ({
          label: `publication input ${index + 1}`,
          value,
        })),
      ],
      protectedDirectories: protectedOutputDirectories,
    });
  }

  const [frameMapBytes, inspectBytes, inspectManifestBytes] = await Promise.all([
    fs.readFile(templateWorkflow.frameMap),
    fs.readFile(templateWorkflow.inspect),
    fs.readFile(templateWorkflow.inspectManifest),
  ]);
  const frameMapInput = JSON.parse(frameMapBytes.toString("utf8"));
  const inspectManifest = JSON.parse(inspectManifestBytes.toString("utf8"));
  presentationRuntime ??= await validatePresentationRuntimeEnvironment();
  runtime ??= await loadRuntime();
  const { FileBlob, PresentationFile, JSZip, sharp } = runtime;
  const actualTemplateSlideCount = await templateSlideCountFromPptxBytes(JSZip, templateBytes);
  const authoringSurface = await createTemporaryPptxAuthoringSurface({
    tmpDir: presentationRuntime.tmpDir,
    runtimeNodeModules: presentationRuntime.runtimeNodeModules,
  });
  let frozenInputs: FrozenPptxAuthoringInputs;
  let frameMap: DynamicValue;
  let authored: { surface: TemporaryAuthoringSurface; authoredOutput: string };
  try {
    frozenInputs = await freezePptxAuthoringInputs({
      surface: authoringSurface,
      templateBytes,
      modelBytes,
      roleMapBytes,
      frameMapBytes,
      inspectBytes,
    });
    frameMap = await validateTemplateWorkflowInputs({
      workflow: templateWorkflow,
      runtime: presentationRuntime,
      templatePath,
      frameMapBytes,
      frameMap: frameMapInput,
      manifest: inspectManifest,
      inspectText: inspectBytes.toString("utf8"),
      actualTemplateSlideCount,
      frozenInputs,
      roleMap,
      model,
    });
    authored = await authorPowerPointWithTemporaryModule({
      runtime: presentationRuntime,
      workflow: templateWorkflow,
      surface: authoringSurface,
      frozenInputs,
    });
  } catch (error) {
    await fs.rm(authoringSurface.directory, { recursive: true, force: true });
    throw error;
  }
  const finalizationInputPaths: LabeledFilesystemPath[] = [
    ...baseInputPaths,
    ...publicationInputPaths.map((value, index) => ({
      label: `publication input ${index + 1}`,
      value,
    })),
    { label: "frozen source template", value: frozenInputs.templatePath },
    { label: "frozen slide model", value: frozenInputs.modelPath },
    { label: "frozen role map", value: frozenInputs.roleMapPath },
    { label: "frozen template frame map", value: frozenInputs.frameMapPath },
    { label: "frozen template inspection", value: frozenInputs.inspectPath },
  ];
  await validatePptxFilesystemIsolation({
    outputs: isolationOutputPaths,
    inputs: finalizationInputPaths,
    protectedDirectories: protectedOutputDirectories,
  });
  await Promise.all([
    fs.mkdir(path.resolve(options.previewDir), { recursive: true }),
    fs.mkdir(path.resolve(options.layoutDir), { recursive: true }),
    fs.mkdir(path.dirname(outputPath), { recursive: true }),
    fs.mkdir(path.dirname(readbackPath), { recursive: true }),
  ]).catch(async (error) => {
    await fs.rm(authored.surface.directory, { recursive: true, force: true });
    throw error;
  });
  const stagedOutput = await stagePowerPointBlob(
    { data: new Uint8Array(await fs.readFile(authored.authoredOutput)) },
    outputPath,
  ).catch(async (error) => {
    await fs.rm(authored.surface.directory, { recursive: true, force: true });
    throw error;
  });
  let stagedReadback: PrivateArtifactStage | undefined;
  let stagedInspect: PrivateArtifactStage | undefined;
  const stagedSupportingArtifacts: StagedSupportingArtifact[] = [];
  let buildFailure: unknown;
  try {
    await prepareNativePptxArtifact({
      JSZip,
      pptxPath: stagedOutput.path,
      templateBytes,
      starterBytes: await fs.readFile(templateWorkflow.starterPptx),
      model,
    });
    const rendered = await PresentationFile.importPptx(await FileBlob.load(stagedOutput.path));
    if (rendered.slides.items.length !== frameMap.outputSlides.length) {
      throw new Error("Authored PowerPoint slide count does not match the validated frame map");
    }
    const managedSlides = assertManagedOrder(rendered, model);
    for (const [modelIndex, entry] of managedSlides.entries()) {
      if (entry.index !== Number(roleMap.insertionIndex) + modelIndex) {
        throw new Error(
          `${entry.instanceId ?? entry.role} is not at its frame-mapped target slide index`,
        );
      }
    }
    await exportFinalTemplateLayouts(rendered, templateWorkflow.finalLayoutDir);
    await runTemplateFidelityWorkflow({
      runtime: presentationRuntime,
      workflow: templateWorkflow,
      frozenInputs,
      frameMap,
      model,
      roleMap,
      finalPptx: stagedOutput.path,
      authoringSurface: authored.surface,
    });
    const searchedTargetTextByRole = new Map(
      managedSlides.map((entry, index) => [
        entry.instanceId ?? entry.role,
        currentSearchedTargetText(
          rendered,
          entry.slide,
          model.slides[index],
          roleMap.roles[entry.role],
        ),
      ]),
    );
    const artifactTextLayers: Array<{
      role: ManagedRole;
      instanceId?: string;
      slideLocalText: string[];
      inheritedText: string[];
    }> = [];
    const layoutByRole = new Map<string, DynamicValue>();
    const managedPreviewImages: Buffer[] = [];
    for (const [index, entry] of managedSlides.entries()) {
      const role = entry.role;
      const identity = entry.instanceId ?? role;
      const slide = entry.slide;
      const modelSlide = model.slides[index];
      const contract = roleMap.roles[role];
      assertAudienceText(slide, modelSlide);
      assertForbiddenText(slide, contract, modelSlide, options.mode);
      if (role === "roadmap-capability") {
        assertMatrix(
          rendered,
          slide,
          modelSlide,
          contract,
          searchedTargetTextByRole.get(identity) ?? new Map(),
        );
      } else if (role === "markitecture") {
        assertMarkitecture(
          rendered,
          slide,
          modelSlide,
          contract,
          frameMap.outputSlides[entry.index],
        );
      } else {
        assertTextOperations(
          rendered,
          slide,
          modelSlide,
          contract.operations,
          searchedTargetTextByRole.get(identity) ?? new Map(),
        );
        assertRichTextOperations(rendered, slide, modelSlide, contract.richTextOperations);
        assertOutcomeOperations(rendered, slide, modelSlide, contract.outcomeOperations);
        assertOutcomeListOperations(rendered, slide, modelSlide, contract.outcomeListOperations);
        assertMetricOperations(rendered, slide, modelSlide, contract.metricOperations);
        assertMilestoneRowOperations(rendered, slide, modelSlide, contract.milestoneRowOperations);
      }
      assertGeometryOperations(rendered, slide, contract.geometryOperations);
      const nativeKinds = normalizeNativeKinds(role, actualNativeKinds(slide));
      if (JSON.stringify(nativeKinds) !== JSON.stringify(NATIVE_KINDS[role])) {
        throw new Error(
          `${role} native object kinds differ: ${nativeKinds.join(", ")} instead of ${NATIVE_KINDS[role].join(", ")}`,
        );
      }
      const layoutBlob = await slide.export({ format: "layout" });
      const layoutText = await layoutBlob.text();
      const layout = JSON.parse(layoutText);
      assertLayoutBounds(layout, role);
      layoutByRole.set(identity, layout);
      artifactTextLayers.push({
        role,
        ...(entry.instanceId ? { instanceId: entry.instanceId } : {}),
        ...visibleTextLayersFromLayout(layout),
      });
      const layoutTargetPath = layoutOutputPaths.get(identity);
      const previewTargetPath = previewOutputPaths.get(identity);
      if (!layoutTargetPath || !previewTargetPath) {
        throw new Error(`${role} lacks a generated-artifact target path`);
      }
      stagedSupportingArtifacts.push({
        ...(await stagePrivateRegularArtifact({
          parentDirectory: path.dirname(layoutTargetPath),
          filename: "layout.json",
          data: layoutText,
        })),
        targetPath: layoutTargetPath,
      });
      const previewBlob = await rendered.export({
        slide,
        format: "png",
        scale: 2,
      });
      const previewBytes = Buffer.from(await previewBlob.arrayBuffer());
      managedPreviewImages.push(previewBytes);
      stagedSupportingArtifacts.push({
        ...(await stagePrivateRegularArtifact({
          parentDirectory: path.dirname(previewTargetPath),
          filename: "preview.png",
          data: previewBytes,
        })),
        targetPath: previewTargetPath,
      });
    }
    const classifiedText = classifyArtifactTextInventories(
      model,
      artifactTextLayers,
      protectedTextSha256ByRole,
      managedOperationTextByIdentity(model, roleMap),
    );
    for (const slideText of classifiedText) {
      if (slideText.unexpectedVisibleTextInventory.length > 0) {
        throw new Error(
          `${slideText.role} contains stale or unmodeled slide-local text: ${slideText.unexpectedVisibleTextInventory.join(" | ")}`,
        );
      }
    }
    const visibleTextByRole = new Map(
      classifiedText.map((slideText) => [slideText.instanceId ?? slideText.role, slideText]),
    );
    for (const capability of model.slides.filter(
      (slide: DynamicValue) => slide.role === "roadmap-capability",
    )) {
      await assertTableLinks(JSZip, stagedOutput.path, capability);
    }
    stagedSupportingArtifacts.push({
      ...(await stagePrivateRegularArtifact({
        parentDirectory: path.dirname(montageOutputPath),
        filename: "montage.webp",
        data: await managedMontageBytes(sharp, managedPreviewImages),
      })),
      targetPath: montageOutputPath,
    });
    if (inspectOutputPath) {
      const inspect = await rendered.inspect({
        kind: "slide,textbox,shape,table,notes,layout",
        maxChars: 1_000_000,
      });
      stagedInspect = await stagePrivateRegularArtifact({
        parentDirectory: path.dirname(inspectOutputPath),
        filename: "inspection.ndjson",
        data: inspect.ndjson,
      });
    }
    const artifactSha256 = sha256Bytes(await fs.readFile(stagedOutput.path));
    const hyperlinkInventoryByRole = await hyperlinkInventoryByRoleFromPptx(
      JSZip,
      stagedOutput.path,
      managedSlides,
      roleMap,
      model,
    );
    const connectorInventoryByRole = await connectorInventoryByRoleFromPptx(
      JSZip,
      stagedOutput.path,
      managedSlides,
    );
    const capabilityStructureByRole = await capabilityStructureInventoryByRoleFromPptx(
      JSZip,
      stagedOutput.path,
      managedSlides,
      roleMap,
      model,
      layoutByRole,
    );
    const weeklyMilestoneStructureByRole = await weeklyMilestoneStructureInventoryByRoleFromPptx(
      JSZip,
      stagedOutput.path,
      managedSlides,
      roleMap,
      model,
      layoutByRole,
    );
    const readback = verifiedSemanticReadback(
      model,
      managedSlides,
      visibleTextByRole,
      hyperlinkInventoryByRole,
      connectorInventoryByRole,
      capabilityStructureByRole,
      weeklyMilestoneStructureByRole,
      {
        kind: "pptx",
        id: outputPath,
        revisionId: artifactSha256,
        sha256: artifactSha256,
      },
      roleMapSha256,
      templateSha256,
    );
    const selfReadback = compareParity(
      model,
      readback,
      readback,
      protectedTextSha256ByRole,
      managedOperationTextByIdentity(model, roleMap),
    );
    if (!selfReadback.equal) {
      throw new Error(
        `PowerPoint artifact readback differs from the shared model: ${selfReadback.errors.map((error: DynamicValue) => error.code).join(", ")}`,
      );
    }
    stagedReadback = await stagePrivateRegularArtifact({
      parentDirectory: path.dirname(readbackPath),
      filename: "readback.json",
      data: canonicalJson(readback),
    });
    await finalizePptxArtifacts({
      temporaryOutputPath: stagedOutput.path,
      outputPath,
      temporaryReadbackPath: stagedReadback.path,
      readbackPath,
      temporaryInspectPath: stagedInspect?.path,
      inspectOutputPath,
      supportingArtifacts: stagedSupportingArtifacts.map((artifact) => ({
        temporaryPath: artifact.path,
        targetPath: artifact.targetPath,
      })),
      mode: options.mode,
      isolation: {
        outputs: isolationOutputPaths,
        inputs: finalizationInputPaths,
        protectedDirectories: protectedOutputDirectories,
      },
    });
    return { model, roleMap, readback };
  } catch (error) {
    buildFailure = error;
    throw error;
  } finally {
    const cleanupDirectories = [
      stagedOutput.directory,
      authored.surface.directory,
      ...(stagedReadback ? [stagedReadback.directory] : []),
      ...(stagedInspect ? [stagedInspect.directory] : []),
      ...stagedSupportingArtifacts.map((artifact) => artifact.directory),
    ];
    await requirePrivateCleanup({
      context:
        buildFailure === undefined
          ? "PowerPoint output was finalized but private staging cleanup failed"
          : "PowerPoint build failed and private staging cleanup also failed",
      operations: cleanupDirectories.map((directory) => ({
        path: directory,
        remove: () => fs.rm(directory, { recursive: true, force: true }),
      })),
      cause: buildFailure,
    });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const requiredOptions: Array<[keyof CliOptions, string]> = [
    ["model", "--model"],
    ["template", "--template-pptx"],
    ["templateWorkspace", "--template-workspace"],
    ["templateFrameMap", "--template-frame-map"],
    ["roleMap", "--role-map"],
    ["output", "--output"],
    ["previewDir", "--preview-dir"],
    ["layoutDir", "--layout-dir"],
    ["readback", "--readback"],
  ];
  for (const [key, flag] of requiredOptions) {
    if (!options[key as keyof CliOptions]) throw new Error(`${flag} is required`);
  }
  await buildPptx(options as BuildPptxOptions);
  console.log(`PowerPoint written: ${path.resolve(options.output as string)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
