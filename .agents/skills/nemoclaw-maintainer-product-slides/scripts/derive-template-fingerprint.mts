// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MANAGED_ROLES,
  type SemanticTemplateContract,
  semanticTemplateFingerprint,
} from "./validate-slide-model.mts";

const REQUIRED_KEYS = [
  "fontRoles",
  "layouts",
  "masters",
  "protectedRegions",
  "roles",
  "slideSize",
  "theme",
] as const;

const IGNORED_KEYS = ["comments", "revision", "unrelatedSlides"] as const;

const SLIDE_SIZE_KEYS = ["heightEmu", "orientation", "widthEmu"] as const;
const MASTER_KEYS = ["objectKinds", "semanticRole"] as const;
const LAYOUT_KEYS = [
  "groupStructure",
  "masterRole",
  "objectKinds",
  "placeholderStructure",
  "semanticRole",
] as const;
const THEME_KEYS = ["colorRoles"] as const;
const COLOR_ROLE_KEYS = ["hex", "semanticRole"] as const;
const FONT_ROLES_KEYS = ["roles"] as const;
const FONT_ROLE_KEYS = ["family", "semanticRole", "sizePt", "style", "weight"] as const;
const REGION_KEYS = ["heightEmu", "leftEmu", "semanticRole", "topEmu", "widthEmu"] as const;
const ROLE_KEYS = [
  "geometry",
  "groupStructure",
  "layoutRole",
  "masterRole",
  "mixedStyleRunBoundaries",
  "placeholderStructure",
  "preArchiveIndex",
  "requiredNativeObjectTypes",
] as const;
const GEOMETRY_KEYS = [
  "heightEmu",
  "kind",
  "leftEmu",
  "semanticRole",
  "topEmu",
  "widthEmu",
] as const;
const MIXED_STYLE_KEYS = ["characterIndexes", "semanticRole"] as const;
const PLACEHOLDER_KEYS = ["index", "placeholderType", "semanticRole"] as const;
const GROUP_KEYS = ["children", "semanticRole"] as const;

type JsonObject = Record<string, unknown>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value: unknown, location: string): asserts value is JsonObject {
  if (!isObject(value)) throw new Error(`${location} must be a JSON object`);
}

function assertExactKeys(value: JsonObject, keys: readonly string[], location: string): void {
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${location} must contain exactly ${expected.join(", ")}; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}`,
    );
  }
}

function assertString(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a nonempty string`);
  }
}

function assertFiniteNumber(
  value: unknown,
  location: string,
  minimum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${location} must be a finite number greater than or equal to ${minimum}`);
  }
}

function assertInteger(value: unknown, location: string, minimum: number): asserts value is number {
  assertFiniteNumber(value, location, minimum);
  if (!Number.isInteger(value)) throw new Error(`${location} must be an integer`);
}

function assertSortedUniqueStrings(value: unknown, location: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be a JSON array`);
  for (const [index, entry] of value.entries()) {
    assertString(entry, `${location}[${index}]`);
  }
  const expected = [...value].sort(compareStrings);
  if (new Set(value).size !== value.length || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${location} must contain unique strings in semantic-role order`);
  }
}

function assertSortedUniqueIntegers(value: unknown, location: string): asserts value is number[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be a JSON array`);
  for (const [index, entry] of value.entries()) {
    assertInteger(entry, `${location}[${index}]`, 0);
  }
  const expected = [...value].sort((left, right) => left - right);
  if (new Set(value).size !== value.length || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${location} must contain unique integers in ascending order`);
  }
}

function assertSemanticRoleArray(
  value: unknown,
  location: string,
  validateEntry: (entry: JsonObject, entryLocation: string) => void,
): asserts value is JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be a JSON array`);
  for (const [index, entry] of value.entries()) {
    const entryLocation = `${location}[${index}]`;
    assertObject(entry, entryLocation);
    validateEntry(entry, entryLocation);
    assertString(entry.semanticRole, `${entryLocation}.semanticRole`);
  }
  const roles = value.map((entry) => entry.semanticRole as string);
  const expected = [...roles].sort(compareStrings);
  if (new Set(roles).size !== roles.length || JSON.stringify(roles) !== JSON.stringify(expected)) {
    throw new Error(`${location} must have unique entries in semantic-role order`);
  }
}

function validateSlideSize(value: unknown): void {
  assertObject(value, "slideSize");
  assertExactKeys(value, SLIDE_SIZE_KEYS, "slideSize");
  assertInteger(value.widthEmu, "slideSize.widthEmu", 1);
  assertInteger(value.heightEmu, "slideSize.heightEmu", 1);
  if (value.orientation !== "landscape" && value.orientation !== "portrait") {
    throw new Error('slideSize.orientation must be "landscape" or "portrait"');
  }
}

function validateMaster(entry: JsonObject, location: string): void {
  assertExactKeys(entry, MASTER_KEYS, location);
  assertSortedUniqueStrings(entry.objectKinds, `${location}.objectKinds`);
}

function validatePlaceholder(entry: JsonObject, location: string): void {
  assertExactKeys(entry, PLACEHOLDER_KEYS, location);
  assertString(entry.placeholderType, `${location}.placeholderType`);
  assertInteger(entry.index, `${location}.index`, 0);
}

function validateGroup(entry: JsonObject, location: string): void {
  assertExactKeys(entry, GROUP_KEYS, location);
  assertSortedUniqueStrings(entry.children, `${location}.children`);
}

function validateLayout(entry: JsonObject, location: string): void {
  assertExactKeys(entry, LAYOUT_KEYS, location);
  assertString(entry.masterRole, `${location}.masterRole`);
  assertSortedUniqueStrings(entry.objectKinds, `${location}.objectKinds`);
  assertSemanticRoleArray(
    entry.placeholderStructure,
    `${location}.placeholderStructure`,
    validatePlaceholder,
  );
  assertSemanticRoleArray(entry.groupStructure, `${location}.groupStructure`, validateGroup);
}

function validateTheme(value: unknown): void {
  assertObject(value, "theme");
  assertExactKeys(value, THEME_KEYS, "theme");
  assertSemanticRoleArray(value.colorRoles, "theme.colorRoles", (entry, location) => {
    assertExactKeys(entry, COLOR_ROLE_KEYS, location);
    assertString(entry.hex, `${location}.hex`);
    if (!/^#[0-9a-f]{6}$/u.test(entry.hex)) {
      throw new Error(`${location}.hex must be a lowercase six-digit hex color`);
    }
  });
}

function validateFontRoles(value: unknown): void {
  assertObject(value, "fontRoles");
  assertExactKeys(value, FONT_ROLES_KEYS, "fontRoles");
  assertSemanticRoleArray(value.roles, "fontRoles.roles", (entry, location) => {
    assertExactKeys(entry, FONT_ROLE_KEYS, location);
    assertString(entry.family, `${location}.family`);
    assertFiniteNumber(entry.sizePt, `${location}.sizePt`, 0.1);
    assertInteger(entry.weight, `${location}.weight`, 1);
    assertString(entry.style, `${location}.style`);
  });
}

function validateRegion(entry: JsonObject, location: string): void {
  assertExactKeys(entry, REGION_KEYS, location);
  assertInteger(entry.leftEmu, `${location}.leftEmu`, 0);
  assertInteger(entry.topEmu, `${location}.topEmu`, 0);
  assertInteger(entry.widthEmu, `${location}.widthEmu`, 1);
  assertInteger(entry.heightEmu, `${location}.heightEmu`, 1);
}

function validateGeometry(entry: JsonObject, location: string): void {
  assertExactKeys(entry, GEOMETRY_KEYS, location);
  assertString(entry.kind, `${location}.kind`);
  assertInteger(entry.leftEmu, `${location}.leftEmu`, 0);
  assertInteger(entry.topEmu, `${location}.topEmu`, 0);
  assertInteger(entry.widthEmu, `${location}.widthEmu`, 1);
  assertInteger(entry.heightEmu, `${location}.heightEmu`, 1);
}

function validateMixedStyle(entry: JsonObject, location: string): void {
  assertExactKeys(entry, MIXED_STYLE_KEYS, location);
  assertSortedUniqueIntegers(entry.characterIndexes, `${location}.characterIndexes`);
}

function validateManagedRole(entry: JsonObject, location: string): void {
  assertExactKeys(entry, ROLE_KEYS, location);
  assertInteger(entry.preArchiveIndex, `${location}.preArchiveIndex`, 0);
  assertString(entry.masterRole, `${location}.masterRole`);
  assertString(entry.layoutRole, `${location}.layoutRole`);
  assertSortedUniqueStrings(
    entry.requiredNativeObjectTypes,
    `${location}.requiredNativeObjectTypes`,
  );
  assertSemanticRoleArray(entry.geometry, `${location}.geometry`, validateGeometry);
  assertSemanticRoleArray(
    entry.mixedStyleRunBoundaries,
    `${location}.mixedStyleRunBoundaries`,
    validateMixedStyle,
  );
  assertSemanticRoleArray(
    entry.placeholderStructure,
    `${location}.placeholderStructure`,
    validatePlaceholder,
  );
  assertSemanticRoleArray(entry.groupStructure, `${location}.groupStructure`, validateGroup);
}

function validateReferences(value: JsonObject): void {
  const masters = value.masters as JsonObject[];
  const layouts = value.layouts as JsonObject[];
  const roles = value.roles as JsonObject;
  const masterRoles = new Set(masters.map((master) => master.semanticRole as string));
  const layoutsByRole = new Map(layouts.map((layout) => [layout.semanticRole as string, layout]));
  for (const [index, layout] of layouts.entries()) {
    if (!masterRoles.has(layout.masterRole as string)) {
      throw new Error(`layouts[${index}].masterRole must reference masters.semanticRole`);
    }
  }
  for (const role of MANAGED_ROLES) {
    const contract = roles[role] as JsonObject;
    const layout = layoutsByRole.get(contract.layoutRole as string);
    if (!masterRoles.has(contract.masterRole as string)) {
      throw new Error(`roles.${role}.masterRole must reference masters.semanticRole`);
    }
    if (!layout) {
      throw new Error(`roles.${role}.layoutRole must reference layouts.semanticRole`);
    }
    if (layout.masterRole !== contract.masterRole) {
      throw new Error(`roles.${role} must use the selected layout's masterRole`);
    }
  }
}

export function parseSemanticTemplateContract(value: unknown): SemanticTemplateContract {
  assertObject(value, "Template fingerprint input");
  const allowed = new Set<string>([...REQUIRED_KEYS, ...IGNORED_KEYS]);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Template fingerprint input has unknown top-level fields: ${unknownKeys.join(", ")}`,
    );
  }
  const missingKeys = REQUIRED_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missingKeys.length > 0) {
    throw new Error(
      `Template fingerprint input is missing required fields: ${missingKeys.join(", ")}`,
    );
  }

  validateSlideSize(value.slideSize);
  assertSemanticRoleArray(value.masters, "masters", validateMaster);
  assertSemanticRoleArray(value.layouts, "layouts", validateLayout);
  validateTheme(value.theme);
  validateFontRoles(value.fontRoles);
  assertSemanticRoleArray(value.protectedRegions, "protectedRegions", validateRegion);
  assertObject(value.roles, "roles");
  assertExactKeys(value.roles, MANAGED_ROLES, "roles");
  for (const role of MANAGED_ROLES) {
    assertObject(value.roles[role], `roles.${role}`);
    validateManagedRole(value.roles[role], `roles.${role}`);
  }
  validateReferences(value);
  return value as SemanticTemplateContract;
}

export function deriveTemplateFingerprint(value: unknown): string {
  return semanticTemplateFingerprint(parseSemanticTemplateContract(value));
}

const USAGE = "Usage: node --import tsx derive-template-fingerprint.mts --input PATH";

function parseInputPath(argv: string[]): string {
  if (argv.length === 2 && argv[0] === "--input" && argv[1]) {
    return path.resolve(argv[1]);
  }
  throw new Error(USAGE);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  const inputPath = parseInputPath(args);
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  console.log(deriveTemplateFingerprint(input));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
