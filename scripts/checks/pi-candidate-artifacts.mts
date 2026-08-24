// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the Pi candidate runtime artifacts.
 *
 * Pi ships as a candidate managed image: CI builds and validates it, but it
 * stays out of the shipped managed-image agent cohort and the atomic all-agent
 * release cohort. This check binds the manifest, the locked package identity,
 * both image sources, the dependency review, and the managed-image contract to
 * one exact package version and integrity value, and verifies that the
 * candidate contract artifact name stays outside the all-agent cohort download
 * pattern.
 *
 * It also binds the Pi candidate trust boundary committed in this repository:
 *
 * - The baseline network policy permits only the managed inference route,
 *   enforced over REST across an exact set of /v1 routes that refuse an encoded
 *   slash, and only root-owned image binaries carry network capability.
 * - The workspace inclusion setting and exact read-only and read-write path
 *   sets stay fixed, and Landlock stays strict so filesystem policy fails
 *   closed.
 * - Pi runs as the sandbox user and group.
 * - The exact headless command ignores project-local resources, MCP stays
 *   disabled, and device pairing stays off.
 * - The bin, prompts, sessions, themes, and tools state directories keep their
 *   exact Shields and backup settings.
 * - Neither the project-trust store nor the project-trust setting is declared
 *   in the manifest state that backup and restore carry, and settings.json
 *   keeps the exact key-allowlist restore contract that makes those rules
 *   apply.
 * - The entrypoint keeps state owner-only, disables startup version checks,
 *   package update checks, and install telemetry, and drops to the sandbox user
 *   before it starts Pi.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANAGED_IMAGE_CONTRACT_PATH = "src/lib/onboard/managed-image/contract.ts";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const COHORT_CONTRACT_ARTIFACT_PREFIX = "managed-pr-contract-";
const CANDIDATE_CONTRACT_ARTIFACT_PREFIX = "managed-candidate-contract-";
const PI_MANIFEST_PATH = "agents/pi/manifest.yaml";
const PI_POLICY_PATH = "agents/pi/policy-additions.yaml";
const PI_START_SCRIPT_PATH = "agents/pi/start.sh";
const PI_CANDIDATE_AUTHORITY_PATH = "src/lib/agent/candidate-authority.ts";
const PI_QUALIFICATION_RECEIPT_PATHS = {
  "linux/amd64": "ci/pi-agent-qualification-v1-linux-amd64.json",
  "linux/arm64": "ci/pi-agent-qualification-v1-linux-arm64.json",
} as const;

const MANAGED_INFERENCE_POLICY = "managed_inference";
const MANAGED_INFERENCE_HOST = "inference.local";
const MANAGED_INFERENCE_PORT = 443;
const MANAGED_INFERENCE_PROTOCOL = "rest";
const REQUIRED_ALLOW_ENCODED_SLASH = false;
const APPROVED_ENDPOINT_FIELDS = [
  "allow_encoded_slash",
  "enforcement",
  "host",
  "port",
  "protocol",
  "rules",
];
const APPROVED_INFERENCE_RULE_FIELDS = ["allow"];
const APPROVED_INFERENCE_ALLOW_FIELDS = ["method", "path"];
const APPROVED_INFERENCE_ROUTES = [
  "GET /v1/models",
  "GET /v1/models/**",
  "POST /v1/chat/completions",
  "POST /v1/completions",
];
const APPROVED_NETWORK_BINARIES = [
  "/usr/local/bin/node",
  "/usr/local/bin/pi",
  "/usr/local/lib/nemoclaw/pi-runtime/**",
];
const REQUIRED_INCLUDE_WORKDIR = true;
const APPROVED_READ_ONLY_PATHS = [
  "/dev/urandom",
  "/etc",
  "/lib",
  "/proc",
  "/usr",
  "/var/lib/dpkg",
  "/var/log",
];
const APPROVED_READ_WRITE_PATHS = ["/dev/null", "/sandbox", "/sandbox/.pi", "/tmp"];
const REQUIRED_LANDLOCK_COMPATIBILITY = "strict";
const REQUIRED_SANDBOX_IDENTITY = "sandbox";
const APPROVED_HEADLESS_COMMAND = "pi --no-approve --print";
const PROJECT_TRUST_STORE = "trust.json";
const PROJECT_TRUST_SETTING = "defaultProjectTrust";
const SETTINGS_FILE = "settings.json";
const APPROVED_SETTINGS_RESTORE = {
  merge: "key-allowlist",
  user_keys: [
    { key: "theme", type: "string", max_length: 128 },
    { key: "hideThinkingBlock", type: "boolean" },
    { key: "showCacheMissNotices", type: "boolean" },
    { key: "quietStartup", type: "boolean" },
    { key: "steeringMode", type: "enum", values: ["all", "one-at-a-time"] },
    { key: "followUpMode", type: "enum", values: ["all", "one-at-a-time"] },
    {
      key: "defaultThinkingLevel",
      type: "enum",
      values: ["off", "minimal", "low", "medium", "high", "xhigh"],
    },
  ],
} as const;
const APPROVED_STATE_FILES = [{ path: SETTINGS_FILE, restore: APPROVED_SETTINGS_RESTORE }] as const;

const APPROVED_STATE_DIRS: Readonly<
  Record<string, { readonly shields: string; readonly backup: boolean }>
> = {
  bin: { shields: "read-only", backup: false },
  prompts: { shields: "read-only", backup: true },
  sessions: { shields: "confidential", backup: true },
  themes: { shields: "read-only", backup: true },
  tools: { shields: "read-only", backup: false },
};

const APPROVED_START_SCRIPT_SHA256 =
  "8d246d9988fd2fe4f61edce8498933cd6b37285c98746f3710058a2daae9dbb8";

const REQUIRED_ARTIFACTS = [
  "agents/pi/Dockerfile",
  "agents/pi/Dockerfile.base",
  "agents/pi/dependency-review.md",
  "agents/pi/generate-config.ts",
  "agents/pi/manifest.yaml",
  "agents/pi/pi-runtime/package-lock.json",
  "agents/pi/pi-runtime/package.json",
  "agents/pi/policy-additions.yaml",
  "agents/pi/start.sh",
  PI_CANDIDATE_AUTHORITY_PATH,
  ...Object.values(PI_QUALIFICATION_RECEIPT_PATHS),
] as const;

export type PiArtifactSources = Readonly<{
  candidateAuthority: string;
  dependencyReview: string;
  dockerfile: string;
  dockerfileBase: string;
  lock: string;
  managedImageContract: string;
  managedImagesWorkflow: string;
  manifest: string;
  packageJson: string;
  policyAdditions: string;
  qualificationReceipts: Readonly<Record<keyof typeof PI_QUALIFICATION_RECEIPT_PATHS, string>>;
  releasePackageJson: string;
  startScript: string;
}>;

function readDockerfileArg(source: string, name: string): string | null {
  const pattern = new RegExp(`^ARG ${name}=(.+)$`, "mu");
  return source.match(pattern)?.[1]?.trim() ?? null;
}

function readManifestField(source: string, name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*"?([^"\\n]+)"?\\s*$`, "mu");
  return source.match(pattern)?.[1]?.trim() ?? null;
}

function lockedPiRelease(lock: string): { version: string | null; integrity: string | null } {
  const parsed = JSON.parse(lock) as {
    packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>;
  };
  const entry = parsed.packages?.[`node_modules/${PI_PACKAGE}`];
  return { version: entry?.version ?? null, integrity: entry?.integrity ?? null };
}

function resolvedArchivesWithoutIntegrity(lock: string): string[] {
  const parsed = JSON.parse(lock) as {
    packages?: Record<string, { integrity?: string; resolved?: string }>;
  };
  return Object.entries(parsed.packages ?? {})
    .filter(
      ([, entry]) =>
        typeof entry.resolved === "string" &&
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? ""),
    )
    .map(([location]) => location);
}

function declaredPiDependency(packageJson: string): string | null {
  const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
  return parsed.dependencies?.[PI_PACKAGE] ?? null;
}

function verifyPinnedIdentity(sources: PiArtifactSources): string[] {
  const failures: string[] = [];
  const locked = lockedPiRelease(sources.lock);
  const declared = declaredPiDependency(sources.packageJson);
  const manifestVersion = readManifestField(sources.manifest, "expected_version");
  if (!locked.version || !locked.integrity) {
    return [`agents/pi/pi-runtime/package-lock.json: ${PI_PACKAGE} is not locked`];
  }
  const archivesWithoutIntegrity = resolvedArchivesWithoutIntegrity(sources.lock);
  if (archivesWithoutIntegrity.length > 0) {
    failures.push(
      `agents/pi/pi-runtime/package-lock.json: resolved archives must use committed SHA-512 integrity: ${archivesWithoutIntegrity.join(", ")}`,
    );
  }
  if (declared !== locked.version) {
    failures.push(
      `agents/pi/pi-runtime/package.json: ${PI_PACKAGE} must request the locked ${locked.version}`,
    );
  }
  if (manifestVersion !== locked.version) {
    failures.push(`agents/pi/manifest.yaml: expected_version must be ${locked.version}`);
  }
  for (const [label, source] of [
    ["agents/pi/Dockerfile.base", sources.dockerfileBase],
    ["agents/pi/Dockerfile", sources.dockerfile],
  ] as const) {
    if (readDockerfileArg(source, "PI_VERSION") !== locked.version) {
      failures.push(`${label}: PI_VERSION must be ${locked.version}`);
    }
  }
  if (readDockerfileArg(sources.dockerfileBase, "PI_PACKAGE") !== PI_PACKAGE) {
    failures.push(`agents/pi/Dockerfile.base: PI_PACKAGE must be ${PI_PACKAGE}`);
  }
  if (readDockerfileArg(sources.dockerfileBase, "PI_NPM_INTEGRITY") !== locked.integrity) {
    failures.push("agents/pi/Dockerfile.base: PI_NPM_INTEGRITY must match the locked integrity");
  }
  if (!sources.dockerfileBase.includes("ci --omit=dev --ignore-scripts")) {
    failures.push("agents/pi/Dockerfile.base: the Pi install must disable lifecycle scripts");
  }
  if (!sources.dependencyReview.includes(locked.integrity)) {
    failures.push("agents/pi/dependency-review.md: must record the locked npm integrity value");
  }
  const lockDigest = createHash("sha256").update(sources.lock).digest("hex");
  if (!sources.dependencyReview.includes(lockDigest)) {
    failures.push(`agents/pi/dependency-review.md: lockfile SHA-256 must be ${lockDigest}`);
  }
  return failures;
}

function readAgentList(source: string, name: string): string[] | null {
  const pattern = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`, "u");
  const body = source.match(pattern)?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/"([^"]+)"/gu)].map(([, agent]) => agent);
}

function readNumberConst(source: string, name: string): number | null {
  const pattern = new RegExp(`export const ${name} = (\\d+) as const;`, "u");
  const match = source.match(pattern)?.[1];
  return match === undefined ? null : Number(match);
}

function verifyCandidateRegistration(contractSource: string): string[] {
  const failures: string[] = [];
  const candidates = readAgentList(contractSource, "CANDIDATE_MANAGED_IMAGE_AGENTS");
  const shipped = readAgentList(contractSource, "SHIPPED_MANAGED_IMAGE_AGENTS");
  if (!candidates || !shipped) {
    return [`${MANAGED_IMAGE_CONTRACT_PATH}: managed-image agent cohorts are not readable`];
  }
  if (!candidates.includes("pi")) {
    failures.push(`${MANAGED_IMAGE_CONTRACT_PATH}: pi must be a candidate managed-image agent`);
  }
  if (shipped.includes("pi")) {
    failures.push(`${MANAGED_IMAGE_CONTRACT_PATH}: pi must stay out of the shipped agent cohort`);
  }
  if (!contractSource.includes('pi: "ghcr.io/nvidia/nemoclaw/pi-sandbox"')) {
    failures.push(
      `${MANAGED_IMAGE_CONTRACT_PATH}: pi must publish to ghcr.io/nvidia/nemoclaw/pi-sandbox`,
    );
  }
  return failures;
}

function verifyManagedImageDeclaration(sources: PiArtifactSources): string[] {
  const platforms = readAgentList(sources.managedImageContract, "MANAGED_IMAGE_PLATFORMS");
  const startupProfileContractVersion = readNumberConst(
    sources.managedImageContract,
    "MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION",
  );
  if (!platforms || startupProfileContractVersion === null) {
    return [
      `${MANAGED_IMAGE_CONTRACT_PATH}: MANAGED_IMAGE_PLATFORMS or MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION is not readable`,
    ];
  }
  const manifest = parseYaml(sources.manifest) as {
    managed_image?: { architectures?: unknown; startup_profile_contract_version?: unknown };
  };
  const failures: string[] = [];
  const architectures = manifest.managed_image?.architectures;
  const architecturesMatch =
    Array.isArray(architectures) &&
    architectures.length === platforms.length &&
    platforms.every((platform, index) => architectures[index] === platform);
  if (!architecturesMatch) {
    failures.push(
      `agents/pi/manifest.yaml: managed_image.architectures must be ${JSON.stringify(platforms)}`,
    );
  }
  if (manifest.managed_image?.startup_profile_contract_version !== startupProfileContractVersion) {
    failures.push(
      `agents/pi/manifest.yaml: managed_image.startup_profile_contract_version must be ${startupProfileContractVersion}`,
    );
  }
  return failures;
}

function verifyCohortSeparation(workflow: string): string[] {
  const failures: string[] = [];
  const candidateArtifactPattern = new RegExp(
    `name: ${CANDIDATE_CONTRACT_ARTIFACT_PREFIX}[^\\n]*`,
    "u",
  );
  if (!candidateArtifactPattern.test(workflow)) {
    failures.push(
      `.github/workflows/managed-images.yaml: the Pi candidate lane must upload a ${CANDIDATE_CONTRACT_ARTIFACT_PREFIX}* contract`,
    );
  }
  if (CANDIDATE_CONTRACT_ARTIFACT_PREFIX.startsWith(COHORT_CONTRACT_ARTIFACT_PREFIX)) {
    failures.push(
      "the candidate contract artifact prefix must not match the all-agent cohort download pattern",
    );
  }
  const cohortDownloadPattern = new RegExp(
    `pattern: ${COHORT_CONTRACT_ARTIFACT_PREFIX}[^\\n]*`,
    "u",
  );
  if (!cohortDownloadPattern.test(workflow)) {
    failures.push(
      ".github/workflows/managed-images.yaml: the all-agent cohort download pattern is missing",
    );
  }
  return failures;
}

export function verifyPiQualificationReceipts(sources: PiArtifactSources): string[] {
  const failures: string[] = [];
  const receipts = Object.entries(sources.qualificationReceipts).flatMap(([platform, contents]) => {
    try {
      const contract = asRecord(JSON.parse(contents) as unknown);
      const source = asRecord(contract.source);
      const digest = contract.digest;
      const expectedImage = "ghcr.io/nvidia/nemoclaw/pi-sandbox";
      const expectedContractKeys = [
        "agent",
        "capabilityContractVersion",
        "contractVersion",
        "digest",
        "image",
        "platform",
        "reference",
        "source",
        "startupProfileContractVersion",
      ];
      const expectedSourceKeys = ["cohort", "release", "repository", "revision"];
      if (
        !isDeepStrictEqual(Object.keys(contract).sort(), expectedContractKeys) ||
        !isDeepStrictEqual(Object.keys(source).sort(), expectedSourceKeys) ||
        contract.contractVersion !== 1 ||
        contract.agent !== "pi" ||
        contract.platform !== platform ||
        contract.image !== expectedImage ||
        typeof digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
        contract.reference !== `${expectedImage}@${digest}` ||
        source.repository !== "NVIDIA/NemoClaw" ||
        typeof source.revision !== "string" ||
        !/^[a-f0-9]{40}$/u.test(source.revision) ||
        typeof source.release !== "string" ||
        !/^v[0-9]+(?:[.][0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(source.release) ||
        typeof source.cohort !== "string" ||
        !/^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u.test(source.cohort) ||
        contract.startupProfileContractVersion !== 1 ||
        contract.capabilityContractVersion !== 1
      ) {
        throw new Error("qualification receipt failed exact contract validation");
      }
      return [{ platform, contents, contract }];
    } catch (error) {
      failures.push(
        `${PI_QUALIFICATION_RECEIPT_PATHS[platform as keyof typeof PI_QUALIFICATION_RECEIPT_PATHS]}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  });
  const expectedDigests = receipts
    .map(({ contents }) => createHash("sha256").update(contents, "utf8").digest("hex"))
    .sort();
  const authoritySource = ts.createSourceFile(
    PI_CANDIDATE_AUTHORITY_PATH,
    sources.candidateAuthority,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let publishedDigests: string[] = [];
  const visitAuthority = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(authoritySource) === "pi" &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(authoritySource) === "Object.freeze"
    ) {
      const array = node.initializer.arguments[0];
      if (array && ts.isArrayLiteralExpression(array)) {
        publishedDigests = array.elements.flatMap((element) =>
          ts.isStringLiteral(element) && /^[a-f0-9]{64}$/u.test(element.text) ? [element.text] : [],
        );
      }
    }
    ts.forEachChild(node, visitAuthority);
  };
  visitAuthority(authoritySource);
  publishedDigests.sort();
  if (!isDeepStrictEqual(publishedDigests, expectedDigests)) {
    failures.push(
      `${PI_CANDIDATE_AUTHORITY_PATH}: accepted digests must match the exact Pi qualification receipts`,
    );
  }
  if (receipts.length === Object.keys(PI_QUALIFICATION_RECEIPT_PATHS).length) {
    const first = receipts[0]!;
    const rest = receipts.slice(1);
    const currentRelease = `v${JSON.parse(sources.releasePackageJson).version as string}`;
    if (
      rest.some(
        ({ contract }) =>
          asRecord(contract.source).revision !== asRecord(first.contract.source).revision ||
          asRecord(contract.source).release !== asRecord(first.contract.source).release ||
          asRecord(contract.source).cohort !== asRecord(first.contract.source).cohort,
      )
    ) {
      failures.push(
        "Pi qualification receipts must identify one source revision, release, and cohort",
      );
    }
    if (receipts.some(({ contract }) => asRecord(contract.source).release !== currentRelease)) {
      failures.push(`Pi qualification receipts must identify current release ${currentRelease}`);
    }
    if (new Set(receipts.map(({ contract }) => contract.reference)).size !== receipts.length) {
      failures.push("Pi qualification receipts must identify unique platform image digests");
    }
  }
  return failures;
}

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseRecord)
    : {};
}

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").sort();
}

function sameSet(actual: readonly string[], approved: readonly string[]): boolean {
  return (
    actual.length === approved.length && actual.every((entry, index) => entry === approved[index])
  );
}

function normalizeInferenceRule(rule: unknown): string | null {
  const ruleRecord = asRecord(rule);
  if (!sameSet(Object.keys(ruleRecord).sort(), APPROVED_INFERENCE_RULE_FIELDS)) return null;
  const allow = asRecord(ruleRecord.allow);
  if (!sameSet(Object.keys(allow).sort(), APPROVED_INFERENCE_ALLOW_FIELDS)) return null;
  return typeof allow.method === "string" && typeof allow.path === "string"
    ? `${allow.method} ${allow.path}`
    : null;
}

function verifyNetworkBoundary(policy: LooseRecord): string[] {
  const failures: string[] = [];
  const networkPolicies = asRecord(policy.network_policies);
  const declared = Object.keys(networkPolicies).sort();
  if (!sameSet(declared, [MANAGED_INFERENCE_POLICY])) {
    failures.push(
      `${PI_POLICY_PATH}: the baseline must declare only ${MANAGED_INFERENCE_POLICY}, found ${declared.join(", ") || "none"}`,
    );
    return failures;
  }
  const managed = asRecord(networkPolicies[MANAGED_INFERENCE_POLICY]);
  const endpoints = Array.isArray(managed.endpoints) ? managed.endpoints : [];
  if (endpoints.length !== 1) {
    failures.push(
      `${PI_POLICY_PATH}: ${MANAGED_INFERENCE_POLICY} must declare exactly one endpoint`,
    );
  }
  for (const entry of endpoints) {
    const endpoint = asRecord(entry);
    const endpointFields = Object.keys(endpoint).sort();
    if (!sameSet(endpointFields, APPROVED_ENDPOINT_FIELDS)) {
      failures.push(
        `${PI_POLICY_PATH}: managed inference endpoint fields must stay ${APPROVED_ENDPOINT_FIELDS.join(", ")}, found ${endpointFields.join(", ") || "none"}`,
      );
    }
    if (endpoint.host !== MANAGED_INFERENCE_HOST || endpoint.port !== MANAGED_INFERENCE_PORT) {
      failures.push(
        `${PI_POLICY_PATH}: the baseline permits only ${MANAGED_INFERENCE_HOST}:${String(MANAGED_INFERENCE_PORT)}`,
      );
    }
    if (endpoint.protocol !== MANAGED_INFERENCE_PROTOCOL) {
      failures.push(
        `${PI_POLICY_PATH}: ${MANAGED_INFERENCE_HOST} must enforce protocol ${MANAGED_INFERENCE_PROTOCOL}, not ${typeof endpoint.protocol === "string" ? endpoint.protocol : "an unset protocol"}`,
      );
    }
    if (endpoint.allow_encoded_slash !== REQUIRED_ALLOW_ENCODED_SLASH) {
      failures.push(
        `${PI_POLICY_PATH}: ${MANAGED_INFERENCE_HOST} must set allow_encoded_slash to false`,
      );
    }
    if (endpoint.enforcement !== "enforce") {
      failures.push(
        `${PI_POLICY_PATH}: ${MANAGED_INFERENCE_HOST} must stay enforced, not observed`,
      );
    }
    const rules = Array.isArray(endpoint.rules) ? endpoint.rules : [];
    const routes = rules.map(normalizeInferenceRule);
    const normalizedRoutes = routes.filter((route): route is string => route !== null).sort();
    if (
      normalizedRoutes.length !== rules.length ||
      !sameSet(normalizedRoutes, APPROVED_INFERENCE_ROUTES)
    ) {
      const found = routes.map((route) => route ?? "a malformed rule").sort();
      failures.push(
        `${PI_POLICY_PATH}: the managed inference routes must stay ${APPROVED_INFERENCE_ROUTES.join(", ")}, found ${found.join(", ") || "none"}`,
      );
    }
  }
  const binaries = sortedStrings(
    Array.isArray(managed.binaries) ? managed.binaries.map((entry) => asRecord(entry).path) : [],
  );
  if (!sameSet(binaries, APPROVED_NETWORK_BINARIES)) {
    failures.push(
      `${PI_POLICY_PATH}: network capability must stay on the root-owned image binaries ${APPROVED_NETWORK_BINARIES.join(", ")}`,
    );
  }
  return failures;
}

function verifyFilesystemBoundary(policy: LooseRecord): string[] {
  const failures: string[] = [];
  const filesystem = asRecord(policy.filesystem_policy);
  if (filesystem.include_workdir !== REQUIRED_INCLUDE_WORKDIR) {
    failures.push(`${PI_POLICY_PATH}: filesystem_policy.include_workdir must stay true`);
  }
  const readOnly = sortedStrings(filesystem.read_only);
  if (!sameSet(readOnly, APPROVED_READ_ONLY_PATHS)) {
    failures.push(
      `${PI_POLICY_PATH}: read-only paths must stay ${APPROVED_READ_ONLY_PATHS.join(", ")}, found ${readOnly.join(", ") || "none"}`,
    );
  }
  const readWrite = sortedStrings(filesystem.read_write);
  if (!sameSet(readWrite, APPROVED_READ_WRITE_PATHS)) {
    failures.push(
      `${PI_POLICY_PATH}: read-write paths must stay ${APPROVED_READ_WRITE_PATHS.join(", ")}, found ${readWrite.join(", ") || "none"}`,
    );
  }
  if (asRecord(policy.landlock).compatibility !== REQUIRED_LANDLOCK_COMPATIBILITY) {
    failures.push(
      `${PI_POLICY_PATH}: landlock.compatibility must be ${REQUIRED_LANDLOCK_COMPATIBILITY} so filesystem policy fails closed`,
    );
  }
  const process = asRecord(policy.process);
  if (
    process.run_as_user !== REQUIRED_SANDBOX_IDENTITY ||
    process.run_as_group !== REQUIRED_SANDBOX_IDENTITY
  ) {
    failures.push(
      `${PI_POLICY_PATH}: Pi must run as the ${REQUIRED_SANDBOX_IDENTITY} user and group`,
    );
  }
  return failures;
}

function verifyApprovalBoundary(manifest: LooseRecord): string[] {
  const failures: string[] = [];
  const runtime = asRecord(manifest.runtime);
  if (runtime.headless_command !== APPROVED_HEADLESS_COMMAND) {
    failures.push(
      `${PI_MANIFEST_PATH}: runtime.headless_command must stay ${APPROVED_HEADLESS_COMMAND}`,
    );
  }
  if (asRecord(manifest.mcp).support !== "disabled") {
    failures.push(`${PI_MANIFEST_PATH}: mcp.support must stay disabled`);
  }
  if (manifest.device_pairing !== false) {
    failures.push(`${PI_MANIFEST_PATH}: device_pairing must stay false`);
  }
  return failures;
}

function verifyExtensionBoundary(manifest: LooseRecord): string[] {
  const failures: string[] = [];
  const stateDirs = Array.isArray(manifest.state_dirs) ? manifest.state_dirs : [];
  const declared = sortedStrings(stateDirs.map((entry) => asRecord(entry).path));
  const approved = Object.keys(APPROVED_STATE_DIRS).sort();
  if (!sameSet(declared, approved)) {
    return [
      `${PI_MANIFEST_PATH}: state_dirs must stay ${approved.join(", ")}, found ${declared.join(", ") || "none"}`,
    ];
  }
  for (const entry of stateDirs) {
    const stateDir = asRecord(entry);
    const name = typeof stateDir.path === "string" ? stateDir.path : "";
    const expected = APPROVED_STATE_DIRS[name];
    if (!expected) continue;
    if (stateDir.shields !== expected.shields) {
      failures.push(
        `${PI_MANIFEST_PATH}: state_dirs.${name} must stay shields ${expected.shields} so its trust classification cannot widen`,
      );
    }
    if ((stateDir.backup !== false) !== expected.backup) {
      failures.push(
        expected.backup
          ? `${PI_MANIFEST_PATH}: state_dirs.${name} must stay in backup so declared user state survives a rebuild`
          : `${PI_MANIFEST_PATH}: state_dirs.${name} must stay outside backup so executable resource state is reconstructed instead of restored`,
      );
    }
  }
  return failures;
}

function verifyRuntimeHardeningBoundary(startScript: string): string[] {
  const digest = createHash("sha256").update(startScript).digest("hex");
  return digest === APPROVED_START_SCRIPT_SHA256
    ? []
    : [
        `${PI_START_SCRIPT_PATH}: entrypoint SHA-256 must stay ${APPROVED_START_SCRIPT_SHA256} so its complete startup-hardening contract cannot drift`,
      ];
}

function verifyProjectTrustBoundary(manifest: LooseRecord): string[] {
  const failures: string[] = [];
  const stateDirs = Array.isArray(manifest.state_dirs) ? manifest.state_dirs : [];
  const stateFiles = Array.isArray(manifest.state_files) ? manifest.state_files : [];
  const declared = [...stateDirs, ...stateFiles].map((entry) => asRecord(entry).path);
  if (declared.includes(PROJECT_TRUST_STORE)) {
    failures.push(
      `${PI_MANIFEST_PATH}: ${PROJECT_TRUST_STORE} must stay undeclared so a restore cannot carry a project-trust decision`,
    );
  }
  if (!isDeepStrictEqual(stateFiles, APPROVED_STATE_FILES)) {
    failures.push(
      `${PI_MANIFEST_PATH}: state_files must contain only ${SETTINGS_FILE} with its exact key-allowlist restore contract`,
    );
  }
  for (const entry of stateFiles) {
    const stateFile = asRecord(entry);
    const restore = asRecord(stateFile.restore);
    const userKeys = Array.isArray(restore.user_keys) ? (restore.user_keys as unknown[]) : [];
    if (userKeys.map((key) => asRecord(key).key).includes(PROJECT_TRUST_SETTING)) {
      failures.push(
        `${PI_MANIFEST_PATH}: ${PROJECT_TRUST_SETTING} must stay outside the restore allowlist so a backup cannot widen project trust`,
      );
    }
  }
  return failures;
}

export function verifyPiTrustBoundary(sources: PiArtifactSources): string[] {
  const policy = asRecord(parseYaml(sources.policyAdditions));
  const manifest = asRecord(parseYaml(sources.manifest));
  return [
    ...verifyNetworkBoundary(policy),
    ...verifyFilesystemBoundary(policy),
    ...verifyApprovalBoundary(manifest),
    ...verifyExtensionBoundary(manifest),
    ...verifyProjectTrustBoundary(manifest),
    ...verifyRuntimeHardeningBoundary(sources.startScript),
  ];
}

export function verifyPiCandidateArtifacts(sources: PiArtifactSources): string[] {
  return [
    ...verifyPinnedIdentity(sources),
    ...verifyCandidateRegistration(sources.managedImageContract),
    ...verifyCohortSeparation(sources.managedImagesWorkflow),
    ...verifyManagedImageDeclaration(sources),
    ...verifyPiQualificationReceipts(sources),
    ...verifyPiTrustBoundary(sources),
  ];
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function main(): void {
  const missing = REQUIRED_ARTIFACTS.filter(
    (relativePath) => !fs.existsSync(path.join(REPO_ROOT, relativePath)),
  );
  if (missing.length > 0) {
    console.error(missing.map((relativePath) => `${relativePath}: missing`).join("\n"));
    process.exit(1);
  }
  const failures = verifyPiCandidateArtifacts({
    candidateAuthority: readRepoFile(PI_CANDIDATE_AUTHORITY_PATH),
    dependencyReview: readRepoFile("agents/pi/dependency-review.md"),
    dockerfile: readRepoFile("agents/pi/Dockerfile"),
    dockerfileBase: readRepoFile("agents/pi/Dockerfile.base"),
    lock: readRepoFile("agents/pi/pi-runtime/package-lock.json"),
    managedImageContract: readRepoFile(MANAGED_IMAGE_CONTRACT_PATH),
    managedImagesWorkflow: readRepoFile(".github/workflows/managed-images.yaml"),
    manifest: readRepoFile(PI_MANIFEST_PATH),
    packageJson: readRepoFile("agents/pi/pi-runtime/package.json"),
    policyAdditions: readRepoFile(PI_POLICY_PATH),
    qualificationReceipts: Object.fromEntries(
      Object.entries(PI_QUALIFICATION_RECEIPT_PATHS).map(([platform, relativePath]) => [
        platform,
        readRepoFile(relativePath),
      ]),
    ) as PiArtifactSources["qualificationReceipts"],
    releasePackageJson: readRepoFile("package.json"),
    startScript: readRepoFile(PI_START_SCRIPT_PATH),
  });
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Pi candidate runtime artifacts are pinned and stay outside the release cohort.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
