// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

import { shouldStripCredentialEnv } from "../security/credential-env";
import { valueLooksLikeSecret } from "../security/credential-filter";

export const DCODE_VALIDATION_PROFILE_SCHEMA_VERSION =
  "nemoclaw.dcode.validation-profile.v1" as const;
export const DCODE_VALIDATION_PROFILE_ENV = "NEMOCLAW_DCODE_VALIDATION_PROFILE_B64";
export const DCODE_VALIDATION_PROFILE_DISABLED = "disabled";

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_COMMANDS = 32;
const MAX_ARGV_ENTRIES = 64;
const MAX_ARG_LENGTH = 4_096;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INVOCATIONS = 1_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHELL_SYNTAX_PATTERN = /[\u0000-\u001f\u007f;&|><`$(){}[\]*?!~\n\r]/;

export interface DcodeValidationCommand {
  id: string;
  argv: string[];
  workingDirectory: string;
  environment: string[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  maxInvocations: number;
}

export interface DcodeValidationProfile {
  schemaVersion: typeof DCODE_VALIDATION_PROFILE_SCHEMA_VERSION;
  contentDigest: string;
  sandboxName: string;
  taskIdentity: string;
  sourceIdentity: string;
  workingDirectoryRoots: string[];
  commands: DcodeValidationCommand[];
}

type ProfileContent = Omit<DcodeValidationProfile, "contentDigest">;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid DCode validation profile: ${message}`);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function requiredString(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maximumLength = 256,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    (pattern && !pattern.test(value))
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function nonSecretString(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maximumLength = 256,
): string {
  const parsed = requiredString(value, label, pattern, maximumLength);
  if (valueLooksLikeSecret(parsed)) fail(`${label} contains secret material.`);
  return parsed;
}

function requiredInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  const path = requiredString(value, label, undefined, 4_096);
  if (!posix.isAbsolute(path) || path !== posix.normalize(path) || path.includes("\\")) {
    fail(`${label} must be a normalized absolute POSIX path.`);
  }
  if (path.split("/").includes("..")) fail(`${label} cannot contain '..'.`);
  if (valueLooksLikeSecret(path)) fail(`${label} contains secret material.`);
  return path;
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalDcodeValidationProfileContent(content: ProfileContent): string {
  return JSON.stringify(canonicalize(content));
}

export function dcodeValidationProfileDigest(content: ProfileContent): string {
  return `sha256:${createHash("sha256")
    .update(canonicalDcodeValidationProfileContent(content))
    .digest("hex")}`;
}

function parseStringArray(
  value: unknown,
  label: string,
  entry: (value: unknown, index: number) => string,
  maximumLength: number,
  minimumLength = 1,
): string[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
    fail(`${label} must contain from ${minimumLength} through ${maximumLength} entries.`);
  }
  return value.map(entry);
}

function parseCommand(
  value: unknown,
  index: number,
  workingDirectoryRoots: readonly string[],
): DcodeValidationCommand {
  if (!isObjectRecord(value)) fail(`commands[${index}] must be an object.`);
  exactKeys(
    value,
    [
      "argv",
      "environment",
      "id",
      "maxInvocations",
      "maxOutputBytes",
      "timeoutSeconds",
      "workingDirectory",
    ],
    `commands[${index}]`,
  );
  const id = nonSecretString(value.id, `commands[${index}].id`, COMMAND_ID_PATTERN, 128);
  const argv = parseStringArray(
    value.argv,
    `commands[${index}].argv`,
    (argument, argumentIndex) => {
      const parsed = requiredString(
        argument,
        `commands[${index}].argv[${argumentIndex}]`,
        undefined,
        MAX_ARG_LENGTH,
      );
      if (SHELL_SYNTAX_PATTERN.test(parsed) || valueLooksLikeSecret(parsed)) {
        fail(
          `commands[${index}].argv[${argumentIndex}] contains forbidden syntax or secret material.`,
        );
      }
      return parsed;
    },
    MAX_ARGV_ENTRIES,
  );
  if (!posix.isAbsolute(argv[0] ?? "")) {
    fail(`commands[${index}].argv[0] must be an absolute executable path.`);
  }
  if (argv[0] !== normalizedAbsolutePath(argv[0], `commands[${index}].argv[0]`)) {
    fail(`commands[${index}].argv[0] must be a normalized absolute executable path.`);
  }
  const workingDirectory = normalizedAbsolutePath(
    value.workingDirectory,
    `commands[${index}].workingDirectory`,
  );
  if (!workingDirectoryRoots.some((root) => isWithinRoot(workingDirectory, root))) {
    fail(`commands[${index}].workingDirectory must be inside a declared working-directory root.`);
  }
  const environment = parseStringArray(
    value.environment,
    `commands[${index}].environment`,
    (name, environmentIndex) => {
      const parsed = requiredString(
        name,
        `commands[${index}].environment[${environmentIndex}]`,
        ENV_NAME_PATTERN,
        128,
      );
      if (shouldStripCredentialEnv(parsed)) {
        fail(`commands[${index}].environment[${environmentIndex}] is credential-shaped.`);
      }
      return parsed;
    },
    64,
    0,
  );
  if (new Set(environment).size !== environment.length) {
    fail(`commands[${index}].environment contains duplicate names.`);
  }
  return {
    id,
    argv,
    workingDirectory,
    environment,
    timeoutSeconds: requiredInteger(
      value.timeoutSeconds,
      `commands[${index}].timeoutSeconds`,
      1,
      MAX_TIMEOUT_SECONDS,
    ),
    maxOutputBytes: requiredInteger(
      value.maxOutputBytes,
      `commands[${index}].maxOutputBytes`,
      1,
      MAX_OUTPUT_BYTES,
    ),
    maxInvocations: requiredInteger(
      value.maxInvocations,
      `commands[${index}].maxInvocations`,
      1,
      MAX_INVOCATIONS,
    ),
  };
}

export function parseDcodeValidationProfile(
  value: unknown,
  expectedSandboxName?: string,
): DcodeValidationProfile {
  if (!isObjectRecord(value)) fail("the document must be an object.");
  exactKeys(
    value,
    [
      "commands",
      "contentDigest",
      "sandboxName",
      "schemaVersion",
      "sourceIdentity",
      "taskIdentity",
      "workingDirectoryRoots",
    ],
    "the document",
  );
  if (value.schemaVersion !== DCODE_VALIDATION_PROFILE_SCHEMA_VERSION) {
    fail(`schemaVersion must be '${DCODE_VALIDATION_PROFILE_SCHEMA_VERSION}'.`);
  }
  const sandboxName = nonSecretString(value.sandboxName, "sandboxName", IDENTITY_PATTERN, 256);
  if (expectedSandboxName !== undefined && sandboxName !== expectedSandboxName) {
    fail(`sandboxName '${sandboxName}' does not match rebuild target '${expectedSandboxName}'.`);
  }
  const taskIdentity = nonSecretString(value.taskIdentity, "taskIdentity", IDENTITY_PATTERN, 256);
  const sourceIdentity = requiredString(value.sourceIdentity, "sourceIdentity", DIGEST_PATTERN, 71);
  const workingDirectoryRoots = parseStringArray(
    value.workingDirectoryRoots,
    "workingDirectoryRoots",
    (path, index) => normalizedAbsolutePath(path, `workingDirectoryRoots[${index}]`),
    16,
  );
  if (new Set(workingDirectoryRoots).size !== workingDirectoryRoots.length) {
    fail("workingDirectoryRoots contains duplicate paths.");
  }
  if (
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.length > MAX_COMMANDS
  ) {
    fail(`commands must contain from 1 through ${MAX_COMMANDS} entries.`);
  }
  const commands = value.commands.map((command, index) =>
    parseCommand(command, index, workingDirectoryRoots),
  );
  if (new Set(commands.map((command) => command.id)).size !== commands.length) {
    fail("commands contains duplicate ids.");
  }
  const content: ProfileContent = {
    schemaVersion: DCODE_VALIDATION_PROFILE_SCHEMA_VERSION,
    sandboxName,
    taskIdentity,
    sourceIdentity,
    workingDirectoryRoots,
    commands,
  };
  const contentDigest = requiredString(value.contentDigest, "contentDigest", DIGEST_PATTERN, 71);
  const expectedDigest = dcodeValidationProfileDigest(content);
  if (contentDigest !== expectedDigest) fail(`contentDigest does not match ${expectedDigest}.`);
  return { ...content, contentDigest };
}

export function loadDcodeValidationProfile(
  filePath: string,
  expectedSandboxName: string,
): DcodeValidationProfile {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    fail("the profile path must be an absolute normalized host path.");
  }
  let descriptor: number;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("the profile path must be a regular file.");
    }
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid DCode")) throw error;
    fail(`cannot open '${filePath}'.`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_PROFILE_BYTES) {
      fail(`the profile must be a regular JSON file no larger than ${MAX_PROFILE_BYTES} bytes.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      fail("the profile must contain valid JSON.");
    }
    return parseDcodeValidationProfile(parsed, expectedSandboxName);
  } finally {
    closeSync(descriptor);
  }
}

export function encodeDcodeValidationProfile(profile: DcodeValidationProfile | null): string {
  if (profile === null) return DCODE_VALIDATION_PROFILE_DISABLED;
  return Buffer.from(JSON.stringify(canonicalize(profile)), "utf8").toString("base64");
}

export function decodeDcodeValidationProfile(
  encoded: string | undefined,
  expectedSandboxName: string,
): DcodeValidationProfile | null {
  if (!encoded || encoded === DCODE_VALIDATION_PROFILE_DISABLED) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail("the internal profile encoding is invalid.");
  try {
    return parseDcodeValidationProfile(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
      expectedSandboxName,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid DCode")) throw error;
    fail("the internal profile encoding is invalid.");
  }
}

export function cloneDcodeValidationProfile(
  profile: DcodeValidationProfile | null | undefined,
  expectedSandboxName: string,
): DcodeValidationProfile | undefined {
  if (profile == null) return undefined;
  return parseDcodeValidationProfile(JSON.parse(JSON.stringify(profile)), expectedSandboxName);
}
