// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import { selectVllmModelFromEnv, type VllmModelDef } from "../inference/vllm-models";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import { getNemoclawStateRoot, resolveHome, STATE_DIR_NAME } from "../state/state-root";
import { isSafeModelId } from "../validation";

export const STATION_EXPRESS_ENV = "NEMOCLAW_STATION_EXPRESS";
export const STATION_EXPRESS_RECEIPT_GENERATION_ENV = "NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION";
export const INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV =
  "NEMOCLAW_INSTALLER_AUTO_FRESH_RECEIPT_GENERATION";
export const STATION_EXPRESS_INTENT_VERSION = 1;

export interface StationExpressResumeIntent {
  version: typeof STATION_EXPRESS_INTENT_VERSION;
  model: string;
  sandboxName: string;
  receiptGeneration?: string;
  servedModel?: string;
  checkpointModel?: string;
}

export interface StationExpressSessionLike {
  resumable?: boolean;
  status?: string;
  mode?: string;
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  stationExpressIntent?: StationExpressResumeIntent | null;
  stationExpressReceiptRetirement?: string | null;
  steps?: { provider_selection?: { status?: string | null } | null } | null;
}

interface ResumeOptionsLike {
  resume?: boolean;
  fresh?: boolean;
}

interface StationExpressResumeDeps {
  loadSession(): StationExpressSessionLike | null;
  clearInstallerResume(): void;
  cleanupReceiptRetirementClaims(): void;
  reconcileReceiptRetirement(generation: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
}

type StationExpressFailureDeps = Pick<StationExpressResumeDeps, "error" | "exitProcess">;

type IntentResult =
  | { ok: true; intent: StationExpressResumeIntent | null }
  | { ok: false; message: string };

const RESUME_ENV = [
  STATION_EXPRESS_ENV,
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_YES",
  "NEMOCLAW_POLICY_MODE",
  "NEMOCLAW_SANDBOX_NAME",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_VLLM_MODEL",
  "NEMOCLAW_MODEL",
  STATION_EXPRESS_RECEIPT_GENERATION_ENV,
] as const;
const MAX_SERVED_MODEL_LENGTH = 512;
const UNBOUND_INTENT_KEYS = "model,sandboxName,version";
const UNBOUND_RECEIPT_INTENT_KEYS = "model,receiptGeneration,sandboxName,version";
const BOUND_INTENT_KEYS = "checkpointModel,model,sandboxName,servedModel,version";
const BOUND_RECEIPT_INTENT_KEYS =
  "checkpointModel,model,receiptGeneration,sandboxName,servedModel,version";
const STATION_EXPRESS_INSTALLER_RESUME_FILE = "station-express-resume";
const STATION_EXPRESS_RETIREMENT_CLAIM_PREFIX = `${STATION_EXPRESS_INSTALLER_RESUME_FILE}.retiring-`;
const STATION_EXPRESS_RETIREMENT_CLAIM_RECEIPT = "receipt";
const STATION_EXPRESS_RETIREMENT_CLAIM_PROOF = "retired";
const STATION_EXPRESS_RETIREMENT_CLAIM_ATTEMPTS = 3;
const STATION_EXPRESS_RECEIPT_GENERATION_PATTERN = /^[0-9a-f]{32}$/;
const STATION_EXPRESS_RECEIPT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const STATION_EXPRESS_RETIREMENT_CLAIM_SUFFIX_PATTERN = /^[A-Za-z0-9]+$/;
const STATION_EXPRESS_RECEIPT_PORT_PATTERN = /^\d+$/;
const STATION_EXPRESS_RECEIPT_AGENTS = new Set(["openclaw", "hermes", "langchain-deepagents-code"]);
const STATION_EXPRESS_RECEIPT_POLICY_TIERS = new Set(["restricted", "balanced", "open"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stationModel(value: unknown): VllmModelDef | null {
  if (typeof value !== "string") return null;
  try {
    const model = selectVllmModelFromEnv({ NEMOCLAW_VLLM_MODEL: value });
    return model?.platforms.includes("station") ? model : null;
  } catch {
    return null;
  }
}

function canonicalStationModelValue(value: string): string | null {
  if (value.trim() !== value) return null;
  return stationModel(value)?.envValue ?? null;
}

function servedModel(model: VllmModelDef): string {
  return model.servedModelId ?? model.id;
}

function identifiesCheckpoint(model: VllmModelDef, value: string): boolean {
  const normalized = value.toLowerCase();
  return [model.envValue, model.id, model.servedModelId].some(
    (candidate) => candidate?.toLowerCase() === normalized,
  );
}

function validSandboxName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(value)
  );
}

function validReceiptPort(value: string): boolean {
  if (!STATION_EXPRESS_RECEIPT_PORT_PATTERN.test(value)) return false;
  const port = Number(value);
  return port >= 1024 && port <= 65535;
}

function validReceiptPorts(gatewayPort: string, dashboardPort: string, vllmPort: string): boolean {
  const numericPorts = [gatewayPort, dashboardPort, vllmPort].map(Number);
  return (
    validReceiptPort(gatewayPort) &&
    validReceiptPort(dashboardPort) &&
    validReceiptPort(vllmPort) &&
    new Set(numericPorts).size === 3
  );
}

export function isValidStationExpressReceiptGeneration(value: unknown): value is string {
  return typeof value === "string" && STATION_EXPRESS_RECEIPT_GENERATION_PATTERN.test(value);
}

interface StationExpressReceiptPaths {
  stateBase: string;
  stateDir: string;
  stateFile: string;
}

interface StationExpressRetirementClaim {
  directory: string;
  generation: string;
  proofFile: string;
  receiptFile: string;
}

interface StationExpressRetirementClaimState {
  claim: StationExpressRetirementClaim;
  hasProof: boolean;
  receiptGeneration: string | null;
}

function stationExpressReceiptPaths(env: NodeJS.ProcessEnv): StationExpressReceiptPaths {
  const stateBase = path.join(resolveHome(env), STATE_DIR_NAME);
  const stateFile = path.join(
    getNemoclawStateRoot(resolveHome(env)),
    STATION_EXPRESS_INSTALLER_RESUME_FILE,
  );
  return { stateBase, stateDir: path.dirname(stateFile), stateFile };
}

function lstatOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertOwnerOnlyDirectory(candidate: string, stat: fs.Stats): void {
  const uid = process.getuid?.();
  if (!stat.isDirectory() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing non-owner-only DGX Station Express resume directory: ${candidate}`);
  }
}

function stationExpressStateDirectories(paths: StationExpressReceiptPaths): string[] {
  const relative = path.relative(paths.stateBase, paths.stateDir);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing DGX Station Express resume path outside ${paths.stateBase}.`);
  }

  const directories = [paths.stateBase];
  let current = paths.stateBase;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    directories.push(current);
  }
  return directories;
}

function assertStationExpressClearStatePathSafe(paths: StationExpressReceiptPaths): void {
  for (const candidate of stationExpressStateDirectories(paths)) {
    const stat = lstatOrNull(candidate);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in DGX Station Express resume path: ${candidate}`);
    }
    const isLegacyStateBase = candidate === paths.stateBase && (stat.mode & 0o7777) === 0o755;
    if (!isLegacyStateBase) {
      assertOwnerOnlyDirectory(candidate, stat);
      continue;
    }
    const uid = process.getuid?.();
    if (!stat.isDirectory() || uid === undefined || stat.uid !== uid) {
      throw new Error(`Refusing non-owner-only DGX Station Express resume directory: ${candidate}`);
    }
  }
}

function assertStationExpressStateDirectorySafe(
  env: NodeJS.ProcessEnv,
): StationExpressReceiptPaths | null {
  const paths = stationExpressReceiptPaths(env);
  for (const candidate of stationExpressStateDirectories(paths)) {
    const stat = lstatOrNull(candidate);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in DGX Station Express resume path: ${candidate}`);
    }
    assertOwnerOnlyDirectory(candidate, stat);
  }
  return paths;
}

function assertOwnerOnlyReceiptFile(candidate: string, errorMessage: string): fs.Stats | null {
  const stat = lstatOrNull(candidate);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link in DGX Station Express resume path: ${candidate}`);
  }
  const uid = process.getuid?.();
  if (!stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new Error(errorMessage);
  }
  return stat;
}

export function assertStationExpressInstallerResumeSafe(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const paths = assertStationExpressStateDirectorySafe(env);
  if (!paths) return null;
  const stat = assertOwnerOnlyReceiptFile(
    paths.stateFile,
    `Refusing to remove invalid DGX Station Express resume state: ${paths.stateFile}`,
  );
  return stat ? paths.stateFile : null;
}

function readStationExpressInstallerResumeGeneration(stateFile: string): string {
  const lines = fs.readFileSync(stateFile, "utf8").split("\n");
  const legacyFormat = lines.length === 4 && lines[3] === "";
  const currentFormat =
    lines.length === 7 &&
    lines[6] === "" &&
    lines[3]?.startsWith("agent=") &&
    STATION_EXPRESS_RECEIPT_AGENTS.has(lines[3].slice("agent=".length)) &&
    lines[4]?.startsWith("sandbox=") &&
    validSandboxName(lines[4].slice("sandbox=".length)) &&
    lines[5]?.startsWith("policy_tier=") &&
    STATION_EXPRESS_RECEIPT_POLICY_TIERS.has(lines[5].slice("policy_tier=".length));
  const portFormat =
    lines.length === 10 &&
    lines[9] === "" &&
    lines[3]?.startsWith("agent=") &&
    STATION_EXPRESS_RECEIPT_AGENTS.has(lines[3].slice("agent=".length)) &&
    lines[4]?.startsWith("sandbox=") &&
    validSandboxName(lines[4].slice("sandbox=".length)) &&
    lines[5]?.startsWith("policy_tier=") &&
    STATION_EXPRESS_RECEIPT_POLICY_TIERS.has(lines[5].slice("policy_tier=".length)) &&
    lines[6]?.startsWith("gateway_port=") &&
    lines[7]?.startsWith("dashboard_port=") &&
    lines[8]?.startsWith("vllm_port=") &&
    validReceiptPorts(
      lines[6].slice("gateway_port=".length),
      lines[7].slice("dashboard_port=".length),
      lines[8].slice("vllm_port=".length),
    );
  if (!legacyFormat && !currentFormat && !portFormat) {
    throw new Error("DGX Station Express installer resume state is malformed.");
  }
  const revision = lines[0]?.startsWith("revision=") ? lines[0].slice("revision=".length) : "";
  const modelValue = lines[1]?.startsWith("model=") ? lines[1].slice("model=".length) : "";
  const generation = lines[2]?.startsWith("generation=")
    ? lines[2].slice("generation=".length)
    : "";
  const canonicalModel = canonicalStationModelValue(modelValue);
  if (
    !STATION_EXPRESS_RECEIPT_REVISION_PATTERN.test(revision) ||
    !canonicalModel ||
    !isValidStationExpressReceiptGeneration(generation)
  ) {
    throw new Error("DGX Station Express installer resume state is malformed.");
  }
  return generation;
}

export function assertStationExpressInstallerResumeMatches(
  expectedGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isValidStationExpressReceiptGeneration(expectedGeneration)) {
    throw new Error("DGX Station Express receipt generation is invalid.");
  }
  const stateFile = assertStationExpressInstallerResumeSafe(env);
  if (!stateFile) {
    throw new Error("Required DGX Station Express installer resume state is missing.");
  }
  if (readStationExpressInstallerResumeGeneration(stateFile) !== expectedGeneration) {
    throw new Error("DGX Station Express installer resume state belongs to another attempt.");
  }
}

function retirementClaimGeneration(name: string): string | null {
  if (!name.startsWith(STATION_EXPRESS_RETIREMENT_CLAIM_PREFIX)) return null;
  const encoded = name.slice(STATION_EXPRESS_RETIREMENT_CLAIM_PREFIX.length);
  const generation = encoded.slice(0, 32);
  const suffix = encoded.slice(33);
  if (
    encoded[32] !== "-" ||
    !isValidStationExpressReceiptGeneration(generation) ||
    !STATION_EXPRESS_RETIREMENT_CLAIM_SUFFIX_PATTERN.test(suffix)
  ) {
    throw new Error(`DGX Station Express receipt retirement claim is malformed: ${name}`);
  }
  return generation;
}

function retirementClaim(directory: string, generation: string): StationExpressRetirementClaim {
  return {
    directory,
    generation,
    proofFile: path.join(directory, STATION_EXPRESS_RETIREMENT_CLAIM_PROOF),
    receiptFile: path.join(directory, STATION_EXPRESS_RETIREMENT_CLAIM_RECEIPT),
  };
}

function listRetirementClaims(
  paths: StationExpressReceiptPaths,
  generation?: string,
): StationExpressRetirementClaim[] {
  const claims: StationExpressRetirementClaim[] = [];
  for (const name of fs.readdirSync(paths.stateDir)) {
    const claimGeneration = retirementClaimGeneration(name);
    if (!claimGeneration || (generation && claimGeneration !== generation)) continue;
    claims.push(retirementClaim(path.join(paths.stateDir, name), claimGeneration));
  }
  return claims;
}

function hasRetirementClaimCandidate(paths: StationExpressReceiptPaths): boolean {
  try {
    return fs
      .readdirSync(paths.stateDir)
      .some((name) => name.startsWith(STATION_EXPRESS_RETIREMENT_CLAIM_PREFIX));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function hasStationExpressInstallerResumeArtifactCandidate(
  paths: StationExpressReceiptPaths,
): boolean {
  return lstatOrNull(paths.stateFile) !== null || hasRetirementClaimCandidate(paths);
}

function assertRetirementClaimDirectorySafe(claim: StationExpressRetirementClaim): string[] {
  const stat = lstatOrNull(claim.directory);
  if (!stat) return [];
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing symbolic link in DGX Station Express receipt retirement claim: ${claim.directory}`,
    );
  }
  assertOwnerOnlyDirectory(claim.directory, stat);
  const entries = fs.readdirSync(claim.directory).sort();
  for (const entry of entries) {
    if (
      entry !== STATION_EXPRESS_RETIREMENT_CLAIM_PROOF &&
      entry !== STATION_EXPRESS_RETIREMENT_CLAIM_RECEIPT
    ) {
      throw new Error(
        `DGX Station Express receipt retirement claim contains an unexpected entry: ${entry}`,
      );
    }
  }
  return entries;
}

function inspectRetirementClaim(
  claim: StationExpressRetirementClaim,
): StationExpressRetirementClaimState {
  const entries = assertRetirementClaimDirectorySafe(claim);
  const hasReceipt = entries.includes(STATION_EXPRESS_RETIREMENT_CLAIM_RECEIPT);
  const hasProof = entries.includes(STATION_EXPRESS_RETIREMENT_CLAIM_PROOF);
  let receiptGeneration: string | null = null;
  if (hasReceipt) {
    const receiptStat = assertOwnerOnlyReceiptFile(
      claim.receiptFile,
      `Refusing invalid DGX Station Express receipt retirement claim: ${claim.receiptFile}`,
    );
    if (!receiptStat) {
      throw new Error("DGX Station Express receipt retirement claim changed during inspection.");
    }
    receiptGeneration = readStationExpressInstallerResumeGeneration(claim.receiptFile);
  }
  if (hasProof) {
    const proofStat = assertOwnerOnlyReceiptFile(
      claim.proofFile,
      `Refusing invalid DGX Station Express receipt retirement proof: ${claim.proofFile}`,
    );
    if (!proofStat || proofStat.size !== 0) {
      throw new Error("DGX Station Express receipt retirement proof is malformed.");
    }
  }
  return { claim, hasProof, receiptGeneration };
}

function publishRetirementProof(claim: StationExpressRetirementClaim): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      claim.proofFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  const state = inspectRetirementClaim(claim);
  if (!state.hasProof) {
    throw new Error("DGX Station Express receipt retirement proof was not published.");
  }
}

function preserveMismatchedClaim(claim: StationExpressRetirementClaim, stateFile: string): void {
  try {
    fs.linkSync(claim.receiptFile, stateFile);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
}

function unlinkRetirementClaimEntry(candidate: string): void {
  try {
    fs.unlinkSync(candidate);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

function retireClaimedReceipt(
  state: StationExpressRetirementClaimState,
  expectedGeneration: string,
  stateFile: string,
): StationExpressRetirementClaim {
  if (state.receiptGeneration !== null && state.receiptGeneration !== expectedGeneration) {
    preserveMismatchedClaim(state.claim, stateFile);
    throw new Error("DGX Station Express installer resume state belongs to another attempt.");
  }
  if (!state.hasProof) {
    if (!state.receiptGeneration) {
      throw new Error("DGX Station Express receipt retirement claim is incomplete.");
    }
    publishRetirementProof(state.claim);
  }
  const current = inspectRetirementClaim(state.claim);
  if (current.receiptGeneration !== null) {
    if (current.receiptGeneration !== expectedGeneration) {
      preserveMismatchedClaim(current.claim, stateFile);
      throw new Error("DGX Station Express installer resume state belongs to another attempt.");
    }
    unlinkRetirementClaimEntry(current.claim.receiptFile);
  }
  return state.claim;
}

function removeRetirementClaimProof(claim: StationExpressRetirementClaim): void {
  const state = inspectRetirementClaim(claim);
  if (state.receiptGeneration !== null) {
    throw new Error("DGX Station Express receipt retirement claim is still active.");
  }
  if (state.hasProof) unlinkRetirementClaimEntry(claim.proofFile);
  removeEmptyRetirementClaimDirectory(claim.directory);
}

function removeEmptyRetirementClaimDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

function finishExistingRetirementClaims(
  paths: StationExpressReceiptPaths,
  expectedGeneration: string,
): StationExpressRetirementClaim[] {
  const completed: StationExpressRetirementClaim[] = [];
  for (const claim of listRetirementClaims(paths, expectedGeneration)) {
    const state = inspectRetirementClaim(claim);
    if (!state.hasProof && state.receiptGeneration === null) {
      removeEmptyRetirementClaimDirectory(claim.directory);
      continue;
    }
    completed.push(retireClaimedReceipt(state, expectedGeneration, paths.stateFile));
  }
  return completed;
}

// Move the canonical receipt into a unique owner-only directory before deleting it.
// The empty proof file is published first, so a crash can retry the same generation
// without ever acting on a newer receipt that appeared at the canonical path.
function claimAndRetireStationExpressInstallerResume(
  expectedGeneration: string,
  options: { allowMissing?: boolean; env?: NodeJS.ProcessEnv } = {},
): StationExpressRetirementClaim[] {
  if (!isValidStationExpressReceiptGeneration(expectedGeneration)) {
    throw new Error("DGX Station Express receipt generation is invalid.");
  }
  const env = options.env ?? process.env;
  const paths = assertStationExpressStateDirectorySafe(env);
  if (!paths) {
    if (options.allowMissing === true) return [];
    throw new Error("Required DGX Station Express installer resume state is missing.");
  }
  for (let attempt = 0; attempt < STATION_EXPRESS_RETIREMENT_CLAIM_ATTEMPTS; attempt += 1) {
    const completed = finishExistingRetirementClaims(paths, expectedGeneration);
    if (completed.length > 0) return completed;

    const stateFile = assertStationExpressInstallerResumeSafe(env);
    if (!stateFile) {
      if (options.allowMissing === true) return [];
      throw new Error("Required DGX Station Express installer resume state is missing.");
    }
    if (readStationExpressInstallerResumeGeneration(stateFile) !== expectedGeneration) {
      throw new Error("DGX Station Express installer resume state belongs to another attempt.");
    }
    const claimDirectory = fs.mkdtempSync(
      path.join(paths.stateDir, `${STATION_EXPRESS_RETIREMENT_CLAIM_PREFIX}${expectedGeneration}-`),
    );
    fs.chmodSync(claimDirectory, 0o700);
    const claim = retirementClaim(claimDirectory, expectedGeneration);
    try {
      fs.renameSync(paths.stateFile, claim.receiptFile);
    } catch (error) {
      removeEmptyRetirementClaimDirectory(claim.directory);
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      continue;
    }
    return [
      retireClaimedReceipt(inspectRetirementClaim(claim), expectedGeneration, paths.stateFile),
    ];
  }
  throw new Error("DGX Station Express installer resume state changed repeatedly during claim.");
}

export function retireStationExpressInstallerResume(
  expectedGeneration: string,
  options: { allowMissing?: boolean; env?: NodeJS.ProcessEnv } = {},
): void {
  const claims = claimAndRetireStationExpressInstallerResume(expectedGeneration, options);
  for (const claim of claims) removeRetirementClaimProof(claim);
}

export function reconcileStationExpressInstallerResumeRetirement<T>(
  expectedGeneration: string,
  commitRetirement: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const claims = claimAndRetireStationExpressInstallerResume(expectedGeneration, {
    allowMissing: true,
    env,
  });
  const committed = commitRetirement();
  for (const claim of claims) removeRetirementClaimProof(claim);
  return committed;
}

export function clearStationExpressInstallerResume(env: NodeJS.ProcessEnv = process.env): void {
  const uncheckedPaths = stationExpressReceiptPaths(env);
  assertStationExpressClearStatePathSafe(uncheckedPaths);
  if (!hasStationExpressInstallerResumeArtifactCandidate(uncheckedPaths)) return;
  const paths = assertStationExpressStateDirectorySafe(env);
  if (!paths) return;
  const stateFile = assertStationExpressInstallerResumeSafe(env);
  if (stateFile) fs.unlinkSync(stateFile);
  for (const claim of listRetirementClaims(paths)) {
    const state = inspectRetirementClaim(claim);
    if (state.receiptGeneration !== null) fs.unlinkSync(claim.receiptFile);
    if (state.hasProof) fs.unlinkSync(claim.proofFile);
    fs.rmdirSync(claim.directory);
  }
}

export function cleanupStationExpressReceiptRetirementClaims(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const uncheckedPaths = stationExpressReceiptPaths(env);
  // Ordinary and legacy onboarding runs can use a state directory created
  // before Station Express required owner-only permissions. Inspect names
  // without mutating anything, and enforce the strict path boundary only
  // when there is an Express retirement artifact to reconcile.
  if (!hasRetirementClaimCandidate(uncheckedPaths)) return;
  const paths = assertStationExpressStateDirectorySafe(env);
  if (!paths) return;
  for (const claim of listRetirementClaims(paths)) {
    const state = inspectRetirementClaim(claim);
    if (!state.hasProof && state.receiptGeneration !== null) {
      throw new Error("DGX Station Express receipt retirement claim is incomplete.");
    }
    if (state.hasProof) {
      retireClaimedReceipt(state, claim.generation, paths.stateFile);
    }
    removeRetirementClaimProof(claim);
  }
}

export function parseStationExpressResumeIntent(value: unknown): StationExpressResumeIntent | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== UNBOUND_INTENT_KEYS &&
    keys !== UNBOUND_RECEIPT_INTENT_KEYS &&
    keys !== BOUND_INTENT_KEYS &&
    keys !== BOUND_RECEIPT_INTENT_KEYS
  ) {
    return null;
  }
  if (value.version !== STATION_EXPRESS_INTENT_VERSION) return null;
  const model = stationModel(value.model);
  if (!model || value.model !== model.envValue || !validSandboxName(value.sandboxName)) return null;
  const servedModelValue = value.servedModel;
  const checkpointModelValue = value.checkpointModel;
  const hasReceipt = keys === UNBOUND_RECEIPT_INTENT_KEYS || keys === BOUND_RECEIPT_INTENT_KEYS;
  const isBound = keys === BOUND_INTENT_KEYS || keys === BOUND_RECEIPT_INTENT_KEYS;
  if (
    (hasReceipt && !isValidStationExpressReceiptGeneration(value.receiptGeneration)) ||
    (isBound &&
      (typeof servedModelValue !== "string" ||
        servedModelValue.length === 0 ||
        servedModelValue.length > MAX_SERVED_MODEL_LENGTH ||
        servedModelValue.trim() !== servedModelValue ||
        !isSafeModelId(servedModelValue) ||
        typeof checkpointModelValue !== "string" ||
        !identifiesCheckpoint(model, checkpointModelValue)))
  ) {
    return null;
  }
  return {
    version: STATION_EXPRESS_INTENT_VERSION,
    model: model.envValue,
    sandboxName: value.sandboxName,
    ...(hasReceipt ? { receiptGeneration: value.receiptGeneration as string } : {}),
    ...(isBound
      ? {
          servedModel: servedModelValue as string,
          checkpointModel: checkpointModelValue as string,
        }
      : {}),
  };
}

export function bindStationExpressProviderSelection(
  intentValue: unknown,
  provider: unknown,
  model: unknown,
  checkpointModel: unknown,
): StationExpressResumeIntent {
  const intent = parseStationExpressResumeIntent(intentValue);
  const selectedModel = intent ? stationModel(intent.model) : null;
  if (!intent || !selectedModel) {
    throw new Error("Cannot record an invalid DGX Station Express provider selection.");
  }
  if (intent.servedModel !== undefined) {
    if (provider === "vllm-local" && model === intent.servedModel) return intent;
    throw new Error("Cannot record an invalid DGX Station Express provider selection.");
  }
  if (
    provider !== "vllm-local" ||
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > MAX_SERVED_MODEL_LENGTH ||
    model.trim() !== model ||
    !isSafeModelId(model) ||
    typeof checkpointModel !== "string" ||
    !identifiesCheckpoint(selectedModel, checkpointModel)
  ) {
    throw new Error("Cannot record an invalid DGX Station Express provider selection.");
  }
  return { ...intent, servedModel: model, checkpointModel: selectedModel.id };
}

function expectedEnvironment(
  intent: StationExpressResumeIntent,
  includeProviderSelection = true,
): Partial<Record<(typeof RESUME_ENV)[number], string>> | null {
  const model = stationModel(intent.model);
  if (!model) return null;
  const expected: Partial<Record<(typeof RESUME_ENV)[number], string>> = {
    [STATION_EXPRESS_ENV]: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_YES: "1",
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_SANDBOX_NAME: intent.sandboxName,
  };
  if (intent.receiptGeneration) {
    expected[STATION_EXPRESS_RECEIPT_GENERATION_ENV] = intent.receiptGeneration;
  }
  if (includeProviderSelection) {
    expected.NEMOCLAW_PROVIDER = "install-vllm";
    expected.NEMOCLAW_VLLM_MODEL = model.envValue;
    expected.NEMOCLAW_MODEL = servedModel(model);
  }
  return expected;
}

function equivalentEnvironmentValue(
  name: (typeof RESUME_ENV)[number],
  actual: string,
  expected: string,
): boolean {
  if (name === "NEMOCLAW_VLLM_MODEL") {
    return stationModel(actual)?.envValue === expected;
  }
  if (name === "NEMOCLAW_SANDBOX_NAME") {
    return actual.trim().toLowerCase() === expected;
  }
  return actual.trim().toLowerCase() === expected.toLowerCase();
}

function validateExpectedEnvironment(
  env: NodeJS.ProcessEnv,
  expected: Partial<Record<(typeof RESUME_ENV)[number], string>>,
): string | null {
  for (const name of RESUME_ENV) {
    const expectedValue = expected[name];
    if (expectedValue === undefined) continue;
    const actual = env[name];
    if (typeof actual !== "string" || actual.trim().length === 0) continue;
    if (!equivalentEnvironmentValue(name, actual, expectedValue)) return name;
  }
  return null;
}

export function getStationExpressResumeIntent(
  env: NodeJS.ProcessEnv,
  sandboxName: string | null,
): IntentResult {
  const marker = String(env[STATION_EXPRESS_ENV] ?? "").trim();
  if (!marker) return { ok: true, intent: null };
  if (marker !== "1") {
    return { ok: false, message: `${STATION_EXPRESS_ENV} must be 1 when set.` };
  }

  const model = stationModel(env.NEMOCLAW_VLLM_MODEL);
  if (!model || !sandboxName || !validSandboxName(sandboxName)) {
    return {
      ok: false,
      message: "DGX Station Express requires a registered Station vLLM model and sandbox name.",
    };
  }
  const intent: StationExpressResumeIntent = {
    version: STATION_EXPRESS_INTENT_VERSION,
    model: model.envValue,
    sandboxName,
    ...(isValidStationExpressReceiptGeneration(env[STATION_EXPRESS_RECEIPT_GENERATION_ENV])
      ? { receiptGeneration: env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] }
      : {}),
  };
  if (
    env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] !== undefined &&
    !isValidStationExpressReceiptGeneration(env[STATION_EXPRESS_RECEIPT_GENERATION_ENV])
  ) {
    return {
      ok: false,
      message: `DGX Station Express has an invalid ${STATION_EXPRESS_RECEIPT_GENERATION_ENV} value.`,
    };
  }
  const expected = expectedEnvironment(intent);
  if (!expected) {
    return { ok: false, message: "DGX Station Express model state is invalid." };
  }
  for (const name of [
    STATION_EXPRESS_ENV,
    "NEMOCLAW_NON_INTERACTIVE",
    "NEMOCLAW_YES",
    "NEMOCLAW_POLICY_MODE",
    "NEMOCLAW_PROVIDER",
  ] as const) {
    const actual = String(env[name] ?? "");
    const expectedValue = expected[name];
    if (!expectedValue || !equivalentEnvironmentValue(name, actual, expectedValue)) {
      return { ok: false, message: `DGX Station Express requires ${name}=${expectedValue}.` };
    }
  }
  const conflict = validateExpectedEnvironment(env, expected);
  if (conflict) {
    return { ok: false, message: `DGX Station Express has a conflicting ${conflict} value.` };
  }
  return { ok: true, intent };
}

/** Validate initial Station Express intent before onboarding acquires its session lock. */
export function requireStationExpressResumeIntent(
  env: NodeJS.ProcessEnv,
  sandboxName: string | null,
  resume: boolean,
  deps: StationExpressFailureDeps = {
    error: (message) => console.error(message),
    exitProcess: (code) => process.exit(code),
  },
): StationExpressResumeIntent | null {
  if (resume) return null;
  const result = getStationExpressResumeIntent(env, sandboxName);
  if (!result.ok) {
    deps.error(`  ${result.message}`);
    deps.exitProcess(1);
  }
  return result.intent;
}

function shouldRestoreStationExpress(
  options: ResumeOptionsLike | undefined,
  session: StationExpressSessionLike | null,
): session is StationExpressSessionLike & { stationExpressIntent: StationExpressResumeIntent } {
  if (options?.fresh === true || !session?.stationExpressIntent || session.resumable === false)
    return false;
  return options?.resume === true || session.status === "in_progress";
}

function requiresExplicitFailedSessionChoice(
  options: ResumeOptionsLike | undefined,
  session: StationExpressSessionLike | null,
): boolean {
  return (
    options?.resume !== true &&
    options?.fresh !== true &&
    Boolean(session?.stationExpressIntent) &&
    session?.resumable !== false &&
    session?.status === "failed"
  );
}

function matchesRecordedStationExpressSelection(
  session: StationExpressSessionLike,
  intent: StationExpressResumeIntent,
): boolean {
  if (session.sandboxName != null && session.sandboxName !== intent.sandboxName) return false;

  const providerComplete = session.steps?.provider_selection?.status === "complete";
  const providerBound = Boolean(intent.servedModel && intent.checkpointModel);
  if (providerComplete !== providerBound) return false;
  if (!providerComplete) return session.provider == null && session.model == null;

  return Boolean(
    intent.servedModel && session.provider === "vllm-local" && session.model === intent.servedModel,
  );
}

export function withStationExpressResumeEnvironment<Options extends ResumeOptionsLike>(
  run: (options?: Options) => Promise<void>,
  deps: StationExpressResumeDeps,
  env: NodeJS.ProcessEnv = process.env,
): (options?: Options) => Promise<void> {
  return async (options) => {
    const session = deps.loadSession();
    if (options?.fresh === true) {
      const receiptGeneration = env[STATION_EXPRESS_RECEIPT_GENERATION_ENV];
      const automaticFreshGeneration = env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV];
      // install.sh binds its automatic pre-sandbox reset to the exact loaded
      // receipt. User-requested --fresh has no binding and keeps the explicit
      // discard behavior below.
      const preserveInstallerResume =
        env[STATION_EXPRESS_ENV] === "1" &&
        isValidStationExpressReceiptGeneration(receiptGeneration) &&
        automaticFreshGeneration === receiptGeneration;
      if (preserveInstallerResume) {
        try {
          assertStationExpressInstallerResumeMatches(receiptGeneration, env);
        } catch (error) {
          deps.error(
            `  Could not verify DGX Station Express installer resume state for automatic fresh recovery: ${error instanceof Error ? error.message : String(error)}`,
          );
          deps.exitProcess(1);
        }
      } else {
        try {
          deps.clearInstallerResume();
        } catch (error) {
          deps.error(
            `  Could not discard DGX Station Express installer resume state: ${error instanceof Error ? error.message : String(error)}`,
          );
          deps.exitProcess(1);
        }
      }
      const previousReceiptGeneration = env[STATION_EXPRESS_RECEIPT_GENERATION_ENV];
      const previousAutomaticFreshGeneration = env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV];
      if (!preserveInstallerResume) delete env[STATION_EXPRESS_RECEIPT_GENERATION_ENV];
      delete env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV];
      try {
        await run(options);
      } finally {
        if (previousReceiptGeneration !== undefined) {
          env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] = previousReceiptGeneration;
        }
        if (previousAutomaticFreshGeneration !== undefined) {
          env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV] = previousAutomaticFreshGeneration;
        }
      }
      return;
    }
    const receiptRetirement = session?.stationExpressReceiptRetirement;
    if (receiptRetirement != null) {
      if (
        !isValidStationExpressReceiptGeneration(receiptRetirement) ||
        session?.status !== "complete" ||
        session.resumable !== false ||
        session.stationExpressIntent
      ) {
        deps.error(
          "  DGX Station Express completion state is invalid. Run nemoclaw onboard --fresh to start again.",
        );
        deps.exitProcess(1);
      }
      try {
        deps.reconcileReceiptRetirement(receiptRetirement);
      } catch (error) {
        deps.error(
          `  Could not retire completed DGX Station Express installer resume state: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.exitProcess(1);
      }
      return;
    }
    try {
      deps.cleanupReceiptRetirementClaims();
    } catch (error) {
      deps.error(
        `  Could not reconcile DGX Station Express receipt retirement state: ${error instanceof Error ? error.message : String(error)}`,
      );
      deps.exitProcess(1);
    }
    if (requiresExplicitFailedSessionChoice(options, session)) {
      deps.error(
        "  A failed DGX Station Express session is waiting. Run nemoclaw onboard --resume to continue it, or nemoclaw onboard --fresh to discard it.",
      );
      deps.exitProcess(1);
    }
    if (!shouldRestoreStationExpress(options, session)) return run(options);
    const intent = parseStationExpressResumeIntent(session.stationExpressIntent);
    if (
      session.mode !== "non-interactive" ||
      !intent ||
      !matchesRecordedStationExpressSelection(session, intent)
    ) {
      deps.error(
        "  DGX Station Express resume state is invalid. Run nemoclaw onboard --fresh to start again.",
      );
      deps.exitProcess(1);
    }

    const expected = expectedEnvironment(
      intent,
      session.steps?.provider_selection?.status !== "complete",
    );
    if (!expected) {
      deps.error(
        "  DGX Station Express resume model is no longer supported. Run nemoclaw onboard --fresh to start again.",
      );
      deps.exitProcess(1);
    }
    const conflict = validateExpectedEnvironment(env, expected);
    if (conflict) {
      deps.error(
        `  DGX Station Express resume conflicts with ${conflict}. Unset ${conflict} and rerun nemoclaw onboard --resume, or run nemoclaw onboard --fresh to start again.`,
      );
      deps.exitProcess(1);
    }

    const previous = new Map<(typeof RESUME_ENV)[number], string | undefined>();
    for (const name of RESUME_ENV) {
      const expectedValue = expected[name];
      if (expectedValue === undefined) continue;
      previous.set(name, env[name]);
      env[name] = expectedValue;
    }
    try {
      await run(options);
    } finally {
      for (const name of RESUME_ENV) {
        if (!previous.has(name)) continue;
        const value = previous.get(name);
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    }
  };
}

export function wrapOnboard<Options extends ResumeOptionsLike>(
  run: (options?: Options) => Promise<void>,
  loadSession: StationExpressResumeDeps["loadSession"],
  reconcileReceiptRetirement: StationExpressResumeDeps["reconcileReceiptRetirement"],
): (options?: Options) => Promise<void> {
  return withStationExpressResumeEnvironment(run, {
    loadSession,
    clearInstallerResume: clearStationExpressInstallerResume,
    cleanupReceiptRetirementClaims: cleanupStationExpressReceiptRetirementClaims,
    reconcileReceiptRetirement,
    error: (message) => console.error(message),
    exitProcess: (code) => process.exit(code),
  });
}
