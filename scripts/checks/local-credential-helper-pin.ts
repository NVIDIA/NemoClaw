// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies that the starter prompt pins the reviewed credential helper and form bytes.
 *
 * NemoClaw uses squash-only merges, so the intermediate artifact commit is not
 * an ancestor of the merged commit and may be absent from shallow checkouts.
 * This check therefore binds each local file to its advertised SHA-256 and a
 * full immutable URL. The prompt verifies fetched bytes and fails closed if
 * GitHub cannot serve that intermediate commit.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STARTER_PROMPT_PATH = "docs/_components/StarterPrompt.tsx";
const HELPER_PATH = "scripts/local-credential-helper.mts";
const FORM_PATH = "docs/resources/local-credential-form.html";

type ReviewedArtifact = Readonly<{
  label: string;
  relativePath: string;
}>;

const REVIEWED_ARTIFACTS: readonly ReviewedArtifact[] = [
  { label: "helper", relativePath: HELPER_PATH },
  { label: "form", relativePath: FORM_PATH },
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCredentialSection(promptSource: string): string {
  const match = promptSource.match(
    /## Handle Tokens Securely and Visually([\s\S]*?)\nUse this provider mapping/,
  );
  if (!match?.[1]) throw new Error("Starter prompt credential section is missing");
  return match[1];
}

function verifyArtifact(section: string, artifact: ReviewedArtifact): string[] {
  const failures: string[] = [];
  const currentBytes = fs.readFileSync(path.join(REPO_ROOT, artifact.relativePath));
  const currentDigest = sha256(currentBytes);
  const urlPattern = new RegExp(
    `https://raw\\.githubusercontent\\.com/NVIDIA/NemoClaw/([0-9a-f]{40})/${escapeRegExp(artifact.relativePath)}`,
    "g",
  );
  const matches = [...section.matchAll(urlPattern)];
  const match = matches[0];
  if (matches.length !== 1 || !match?.[1] || match.index === undefined) {
    return [`${artifact.label}: expected exactly one immutable raw GitHub URL`];
  }

  const lineStart = section.lastIndexOf("\n", match.index) + 1;
  const nextLine = section.indexOf("\n", match.index);
  const pinnedLine = section.slice(lineStart, nextLine < 0 ? undefined : nextLine);
  if (!pinnedLine.includes(currentDigest)) {
    failures.push(`${artifact.label}: immutable URL is not paired with SHA-256 ${currentDigest}`);
  }
  return failures;
}

function verifyPackageFiles(): string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    files?: unknown;
  };
  if (!Array.isArray(packageJson.files)) return ["package.json: files must be an array"];
  const failures: string[] = [];
  if (!packageJson.files.includes("scripts/")) {
    failures.push("package.json: scripts/ must ship the credential helper");
  }
  if (!packageJson.files.includes(FORM_PATH)) {
    failures.push(`package.json: ${FORM_PATH} must ship with the helper`);
  }
  if ((fs.statSync(path.join(REPO_ROOT, HELPER_PATH)).mode & 0o111) === 0) {
    failures.push(`${HELPER_PATH}: helper must remain executable`);
  }
  return failures;
}

function verifyEmbeddedFormDigest(): string[] {
  const helperSource = fs.readFileSync(path.join(REPO_ROOT, HELPER_PATH), "utf8");
  const embeddedDigest = helperSource.match(
    /EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256\s*=\s*\n?\s*"([a-f0-9]{64})"/,
  )?.[1];
  const formDigest = sha256(fs.readFileSync(path.join(REPO_ROOT, FORM_PATH)));
  return embeddedDigest === formDigest
    ? []
    : [`${HELPER_PATH}: embedded form digest does not match ${FORM_PATH}`];
}

function extractCredentialPattern(source: string, relativePath: string): string {
  const pattern = source.match(
    /CREDENTIAL_SHAPED_NAME_PATTERN\s*=\s*\n?\s*(\/[^\n]+\/[a-z]*);/,
  )?.[1];
  if (!pattern) throw new Error(`${relativePath}: credential-shaped name pattern is missing`);
  return pattern;
}

function extractStringSet(source: string, setName: string, relativePath: string): string[] {
  const body = source.match(
    new RegExp(`(?:const\\s+)?${setName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  )?.[1];
  if (!body) throw new Error(`${relativePath}: ${setName} is missing`);
  return [...body.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]).sort();
}

function verifyFieldSafetyRules(): string[] {
  const helperSource = fs.readFileSync(path.join(REPO_ROOT, HELPER_PATH), "utf8");
  const formSource = fs.readFileSync(path.join(REPO_ROOT, FORM_PATH), "utf8");
  const failures: string[] = [];
  if (
    extractCredentialPattern(helperSource, HELPER_PATH) !==
    extractCredentialPattern(formSource, FORM_PATH)
  ) {
    failures.push("helper and form credential-shaped name patterns must match exactly");
  }
  const helperControlNames = extractStringSet(
    helperSource,
    "FORBIDDEN_CHILD_ENV_NAMES",
    HELPER_PATH,
  );
  const formControlNames = extractStringSet(formSource, "PROCESS_CONTROL_FIELD_NAMES", FORM_PATH);
  if (helperControlNames.join("\n") !== formControlNames.join("\n")) {
    failures.push("helper and form process-control environment name sets must match exactly");
  }
  return failures;
}

function main(): void {
  const promptSource = fs.readFileSync(path.join(REPO_ROOT, STARTER_PROMPT_PATH), "utf8");
  const section = findCredentialSection(promptSource);
  const sectionDigests = [...section.matchAll(/\b[a-f0-9]{64}\b/g)].map(([digest]) => digest);
  const expectedDigests = REVIEWED_ARTIFACTS.map(({ relativePath }) =>
    sha256(fs.readFileSync(path.join(REPO_ROOT, relativePath))),
  );
  const pinnedCommits = REVIEWED_ARTIFACTS.flatMap(({ relativePath }) => {
    const pattern = new RegExp(
      `https://raw\\.githubusercontent\\.com/NVIDIA/NemoClaw/([0-9a-f]{40})/${escapeRegExp(relativePath)}`,
    );
    const commit = section.match(pattern)?.[1];
    return commit ? [commit] : [];
  });
  const failures = [
    ...REVIEWED_ARTIFACTS.flatMap((artifact) => verifyArtifact(section, artifact)),
    ...verifyEmbeddedFormDigest(),
    ...verifyFieldSafetyRules(),
    ...verifyPackageFiles(),
  ];
  if (
    sectionDigests.length !== expectedDigests.length ||
    [...sectionDigests].sort().join("\n") !== [...expectedDigests].sort().join("\n")
  ) {
    failures.push("starter prompt credential section must contain only the two current digests");
  }
  if (pinnedCommits.length !== REVIEWED_ARTIFACTS.length || new Set(pinnedCommits).size !== 1) {
    failures.push("starter prompt helper and form URLs must pin the same commit");
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Local credential helper and form pins are immutable and current.");
}

main();
