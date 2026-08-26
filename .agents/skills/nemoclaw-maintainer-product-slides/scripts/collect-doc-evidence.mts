// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  canonicalSha256,
  sha256Text,
  type ValidationFinding,
  withoutTopLevelKey,
} from "./validate-slide-model.mts";
import {
  assertProtectedOutputAbsent,
  protectedOutputDiagnostic,
  quoteProtectedOutputPath,
  writeProtectedOutput,
} from "./protected-output.mts";

const ALLOWED_DOC_PATHS = new Set([
  "docs/about/overview.mdx",
  "docs/about/how-it-works.mdx",
  "docs/reference/architecture.mdx",
  "docs/reference/platform-support.mdx",
  "docs/reference/enterprise-readiness.mdx",
]);

const OPTIONAL_IMAGE_PATH = "docs/about/images/nemoclaw-highlevel-component-diagram.png";
const PLATFORM_MATRIX_PATH = "ci/platform-matrix.json";
const PLATFORM_GENERATOR_PATH = "scripts/generate-platform-docs.py";
const PLATFORM_GENERATED_PATHS = [
  "docs/get-started/prerequisites.mdx",
  "docs/inference/choose-inference-provider.mdx",
  "docs/reference/platform-support.mdx",
];
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type ClaimDefinition = {
  claimId: string;
  text: string;
  path: string;
  heading: string;
  evidenceAnchors: string[];
  platformGate?: {
    matrixSection: string;
    entryName: string;
    allowedStatuses: string[];
  };
};

export type ClaimLedger = { schemaVersion: 1; claims: ClaimDefinition[] };

export type DocumentationSource = {
  sourceId: string;
  path: string;
  heading: string;
  commitSha: string;
  blobSha: string;
  sectionSha256: string;
};

export type CollectedClaim = ClaimDefinition & {
  commitSha: string;
  blobSha: string;
  sectionSha256: string;
  platformStatus?: string;
};

export type DocumentationEvidence = {
  schemaVersion: 1;
  repository: "NVIDIA/NemoClaw";
  commitSha: string;
  collectedAt: string;
  sources: DocumentationSource[];
  claims: CollectedClaim[];
  optionalImage: null | { path: string; blobSha: string; sha256: string };
  platformMatrix: {
    path: typeof PLATFORM_MATRIX_PATH;
    blobSha: string;
    sha256: string;
    generatedPageInSync: boolean;
  };
  findings: ValidationFinding[];
  complete: boolean;
  evidenceSha256: string;
};

const verifiedEvidenceDigests = new WeakMap<object, string>();

function normalizeText(value: string): string {
  return `${value.replace(/\r\n?/gu, "\n").trimEnd()}\n`;
}

function headingMatch(line: string): { level: number; heading: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  return match ? { level: match[1].length, heading: match[2].trim() } : null;
}

export function extractHeadingSection(markdown: string, requestedHeading: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const startIndex = lines.findIndex((line) => headingMatch(line)?.heading === requestedHeading);
  if (startIndex < 0) {
    throw new Error(`Heading not found: ${requestedHeading}`);
  }
  const start = headingMatch(lines[startIndex]);
  if (!start) throw new Error(`Heading not found: ${requestedHeading}`);
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const candidate = headingMatch(lines[index]);
    if (candidate && candidate.level <= start.level) {
      endIndex = index;
      break;
    }
  }
  return normalizeText(lines.slice(startIndex, endIndex).join("\n"));
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isOfficialNemoClawRemote(value: string): boolean {
  const remote = value.trim();
  if (remote.startsWith("git@github.com:")) {
    return remote.slice("git@github.com:".length).replace(/\.git$/u, "") === "NVIDIA/NemoClaw";
  }
  try {
    const parsed = new URL(remote);
    return (
      ["https:", "ssh:", "git:"].includes(parsed.protocol) &&
      parsed.hostname === "github.com" &&
      parsed.pathname.replace(/^\//u, "").replace(/\.git$/u, "") === "NVIDIA/NemoClaw"
    );
  } catch {
    return false;
  }
}

function requireOfficialOriginCommit(repoRoot: string, commitSha: string): void {
  const remoteUrl = runGit(repoRoot, ["remote", "get-url", "origin"]);
  if (!isOfficialNemoClawRemote(remoteUrl)) {
    throw new Error("Documentation evidence must come from NVIDIA/NemoClaw");
  }
  let originMain: string;
  try {
    originMain = runGit(repoRoot, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", commitSha, originMain], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      "Documentation commit is not reachable from the official origin/main reference; fetch origin and recollect the evidence",
      { cause: error },
    );
  }
  if (!FULL_SHA_PATTERN.test(originMain)) {
    throw new Error("The official origin/main reference is not a full Git SHA");
  }
}

function trustedRepoPath(repoRoot: string, relativePath: string): string {
  const absoluteRoot = path.resolve(repoRoot);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Documentation path escapes the repository: ${relativePath}`);
  }
  return absolutePath;
}

function blobSha(repoRoot: string, commitSha: string, relativePath: string): string {
  return runGit(repoRoot, ["rev-parse", `${commitSha}:${relativePath}`]);
}

function readGitBlob(repoRoot: string, commitSha: string, relativePath: string): Buffer {
  trustedRepoPath(repoRoot, relativePath);
  return execFileSync("git", ["-C", repoRoot, "show", `${commitSha}:${relativePath}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBlobExists(repoRoot: string, commitSha: string, relativePath: string): boolean {
  return (
    runGit(repoRoot, ["ls-tree", "-r", "--name-only", commitSha, "--", relativePath]) ===
    relativePath
  );
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function platformStatus(
  matrix: Record<string, unknown>,
  gate: NonNullable<ClaimDefinition["platformGate"]>,
): string | undefined {
  const section = matrix[gate.matrixSection];
  if (!Array.isArray(section)) return undefined;
  const entry = section.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).name === gate.entryName,
  ) as Record<string, unknown> | undefined;
  return typeof entry?.status === "string" ? entry.status : undefined;
}

function platformSync(repoRoot: string, commitSha: string, trustedGenerator: Buffer): boolean {
  const paths = [PLATFORM_MATRIX_PATH, ...PLATFORM_GENERATED_PATHS];
  const checkout = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-platform-evidence-"));
  try {
    const archive = execFileSync(
      "git",
      ["-C", repoRoot, "archive", "--format=tar", commitSha, "--", ...paths],
      {
        maxBuffer: 100 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    execFileSync("tar", ["-xf", "-", "-C", checkout], {
      input: archive,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const generatorPath = trustedRepoPath(checkout, PLATFORM_GENERATOR_PATH);
    mkdirSync(path.dirname(generatorPath), { recursive: true });
    writeFileSync(generatorPath, trustedGenerator, { mode: 0o700 });
  } catch (error) {
    rmSync(checkout, { recursive: true, force: true });
    throw new Error("Unable to materialize platform evidence from the Git commit", {
      cause: error,
    });
  }
  try {
    execFileSync("python3", ["scripts/generate-platform-docs.py", "--check"], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch (error) {
    const output =
      error && typeof error === "object"
        ? `${"stdout" in error ? String(error.stdout ?? "") : ""}\n${
            "stderr" in error ? String(error.stderr ?? "") : ""
          }`
        : "";
    if (/\bDIFF\b/u.test(output) && /out of sync/u.test(output)) return false;
    throw new Error("Platform documentation validation could not complete", {
      cause: error,
    });
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

export function collectDocumentationEvidence(options: {
  repoRoot: string;
  commitSha?: string;
  claims: ClaimLedger;
  collectedAt?: string;
  checkPlatformSync?: boolean;
}): DocumentationEvidence {
  const repoRoot = path.resolve(options.repoRoot);
  const headSha = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const commitSha = options.commitSha ?? headSha;
  if (!FULL_SHA_PATTERN.test(commitSha)) {
    throw new Error("Documentation commit must be a full Git SHA");
  }
  const remoteUrl = runGit(repoRoot, ["remote", "get-url", "origin"]);
  if (!isOfficialNemoClawRemote(remoteUrl)) {
    throw new Error("Documentation evidence must come from NVIDIA/NemoClaw");
  }
  if (options.claims.schemaVersion !== 1 || !Array.isArray(options.claims.claims)) {
    throw new Error("Claim ledger schemaVersion must be 1");
  }

  const collectedAt = options.collectedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(collectedAt))) throw new Error("collectedAt must be ISO-8601");

  const findings: ValidationFinding[] = [];
  const sourceByScope = new Map<string, DocumentationSource>();
  const claims: CollectedClaim[] = [];
  const matrixBytes = readGitBlob(repoRoot, commitSha, PLATFORM_MATRIX_PATH);
  const matrix = JSON.parse(matrixBytes.toString("utf8")) as Record<string, unknown>;
  const matrixBlobSha = blobSha(repoRoot, commitSha, PLATFORM_MATRIX_PATH);
  let generatedPageInSync = true;
  if (options.checkPlatformSync !== false) {
    const trustedGenerator = readGitBlob(repoRoot, headSha, PLATFORM_GENERATOR_PATH);
    const selectedGenerator = readGitBlob(repoRoot, commitSha, PLATFORM_GENERATOR_PATH);
    if (sha256Text(selectedGenerator) !== sha256Text(trustedGenerator)) {
      throw new Error(
        "The selected commit uses a different platform documentation generator; run the matching reviewed skill revision instead of executing commit-selected code",
      );
    }
    generatedPageInSync = platformSync(repoRoot, commitSha, trustedGenerator);
  }
  if (!generatedPageInSync) {
    findings.push({
      code: "PLATFORM_DOC_DRIFT",
      message: "The generated platform-support page differs from ci/platform-matrix.json.",
      remediation: "Regenerate platform documentation and commit the synchronized source and page.",
      role: "markitecture",
    });
  }

  for (const claim of options.claims.claims) {
    if (!ALLOWED_DOC_PATHS.has(claim.path)) {
      throw new Error(`Claim ${claim.claimId} uses a disallowed documentation path: ${claim.path}`);
    }
    const raw = readGitBlob(repoRoot, commitSha, claim.path).toString("utf8");
    const section = extractHeadingSection(raw, claim.heading);
    if (
      !Array.isArray(claim.evidenceAnchors) ||
      claim.evidenceAnchors.length === 0 ||
      claim.evidenceAnchors.some((anchor) => !anchor || !section.includes(anchor))
    ) {
      findings.push({
        code: "DOCUMENTATION_CLAIM_UNBOUND",
        message: `Claim ${claim.claimId} lacks its reviewed evidence anchor in ${claim.path}#${claim.heading}.`,
        remediation:
          "Stop; have an authorized maintainer narrow or rebind the claim through repository review, then recollect documentation evidence.",
        role: "markitecture",
      });
    }
    const scopeKey = `${claim.path}\u0000${claim.heading}`;
    const source: DocumentationSource = {
      sourceId: `doc:${claim.path}#${claim.heading}`,
      path: claim.path,
      heading: claim.heading,
      commitSha,
      blobSha: blobSha(repoRoot, commitSha, claim.path),
      sectionSha256: sha256Text(section),
    };
    const prior = sourceByScope.get(scopeKey);
    if (prior && canonicalJson(prior) !== canonicalJson(source)) {
      throw new Error(
        `Documentation scope changed during collection: ${claim.path}#${claim.heading}`,
      );
    }
    sourceByScope.set(scopeKey, source);

    const status = claim.platformGate ? platformStatus(matrix, claim.platformGate) : undefined;
    if (claim.platformGate && (!status || !claim.platformGate.allowedStatuses.includes(status))) {
      findings.push({
        code: "PLATFORM_CLAIM_UNVERIFIED",
        message: `Claim ${claim.claimId} is not allowed by ${claim.platformGate.entryName} status ${status ?? "missing"}.`,
        remediation:
          "Stop; have an authorized maintainer remove the claim or update the canonical platform matrix through repository review, then recollect documentation evidence.",
        role: "markitecture",
      });
    }
    claims.push({
      ...claim,
      commitSha: source.commitSha,
      blobSha: source.blobSha,
      sectionSha256: source.sectionSha256,
      ...(status ? { platformStatus: status } : {}),
    });
  }

  let optionalImage: DocumentationEvidence["optionalImage"] = null;
  if (gitBlobExists(repoRoot, commitSha, OPTIONAL_IMAGE_PATH)) {
    const imageBytes = readGitBlob(repoRoot, commitSha, OPTIONAL_IMAGE_PATH);
    optionalImage = {
      path: OPTIONAL_IMAGE_PATH,
      blobSha: blobSha(repoRoot, commitSha, OPTIONAL_IMAGE_PATH),
      sha256: sha256Text(imageBytes),
    };
  }

  const evidenceWithoutHash = {
    schemaVersion: 1 as const,
    repository: "NVIDIA/NemoClaw" as const,
    commitSha,
    collectedAt,
    sources: [...sourceByScope.values()].sort((left, right) =>
      `${left.path}#${left.heading}`.localeCompare(`${right.path}#${right.heading}`),
    ),
    claims,
    optionalImage,
    platformMatrix: {
      path: PLATFORM_MATRIX_PATH as typeof PLATFORM_MATRIX_PATH,
      blobSha: matrixBlobSha,
      sha256: sha256Text(matrixBytes),
      generatedPageInSync,
    },
    findings,
    complete: findings.length === 0,
  };
  return {
    ...evidenceWithoutHash,
    evidenceSha256: canonicalSha256(evidenceWithoutHash),
  };
}

export function verifyDocumentationEvidence(options: {
  repoRoot: string;
  evidence: DocumentationEvidence;
  claims: ClaimLedger;
}): DocumentationEvidence {
  const repoRoot = path.resolve(options.repoRoot);
  if (!FULL_SHA_PATTERN.test(options.evidence.commitSha)) {
    throw new Error("Documentation evidence commit must be a full Git SHA");
  }
  requireOfficialOriginCommit(repoRoot, options.evidence.commitSha);
  const reconstructed = collectDocumentationEvidence({
    repoRoot,
    commitSha: options.evidence.commitSha,
    claims: options.claims,
    collectedAt: options.evidence.collectedAt,
  });
  if (canonicalJson(reconstructed) !== canonicalJson(options.evidence)) {
    throw new Error(
      "Documentation evidence does not match the immutable Git objects at its recorded commit",
    );
  }
  verifiedEvidenceDigests.set(options.evidence, canonicalSha256(options.evidence));
  return options.evidence;
}

export function isDocumentationEvidenceVerified(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const verifiedDigest = verifiedEvidenceDigests.get(evidence);
  if (!verifiedDigest) return false;
  try {
    return canonicalSha256(evidence) === verifiedDigest;
  } catch {
    return false;
  }
}

type CliOptions = {
  repoRoot?: string;
  commitSha?: string;
  claims?: string;
  collectedAt?: string;
  output?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    const assign = (key: keyof CliOptions): void => {
      if (!next) throw new Error(`Missing value for ${argument}`);
      options[key] = next;
      index += 1;
    };
    if (argument === "--repo-root") assign("repoRoot");
    else if (argument === "--commit") assign("commitSha");
    else if (argument === "--claims") assign("claims");
    else if (argument === "--collected-at") assign("collectedAt");
    else if (argument === "--output") assign("output");
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node --import tsx collect-doc-evidence.mts --repo-root PATH --commit SHA --claims PATH --output PATH [--collected-at ISO]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.repoRoot || !options.commitSha || !options.claims || !options.output) {
    throw new Error("--repo-root, --commit, --claims, and --output are required");
  }
  const outputPath = assertProtectedOutputAbsent(options.output, "Documentation evidence");
  const evidence = collectDocumentationEvidence({
    repoRoot: options.repoRoot,
    commitSha: options.commitSha,
    claims: readJsonFile<ClaimLedger>(path.resolve(options.claims)),
    collectedAt: options.collectedAt,
  });
  const recomputed = canonicalSha256(withoutTopLevelKey(evidence, "evidenceSha256"));
  if (recomputed !== evidence.evidenceSha256) {
    throw new Error("Documentation evidence hash verification failed");
  }
  writeProtectedOutput(outputPath, canonicalJson(evidence), {
    artifactName: "Documentation evidence",
  });
  console.log(`Documentation evidence written: ${quoteProtectedOutputPath(outputPath)}`);
  if (!evidence.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`collect-doc-evidence: error: ${protectedOutputDiagnostic(error)}`);
    process.exitCode = 1;
  }
}
