#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BLOCK_RULES = [
  {
    id: "env-root",
    reason: "environment files may contain API keys or other secrets",
    matches: (filePath) => {
      const base = path.posix.basename(filePath);
      return base === ".env" || (base.startsWith(".env.") && base.length > 5);
    },
  },
  {
    id: "direnv-file",
    reason: "direnv files may contain secrets or machine-local configuration",
    matches: (filePath) => path.posix.basename(filePath) === ".envrc",
  },
  {
    id: "direnv-directory",
    reason: "direnv state directories are machine-local and may contain secrets",
    matches: (filePath) => /(^|\/)\.direnv(\/|$)/.test(filePath),
  },
  {
    id: "private-keys",
    reason: "private key or certificate bundles must not be committed",
    matches: (filePath) => /\.(pem|key|p12|pfx)$/i.test(filePath),
  },
  {
    id: "ssh-private-keys",
    reason: "SSH private keys must not be committed",
    matches: (filePath) => {
      const base = path.posix.basename(filePath).toLowerCase();
      return /(?:^|_)(rsa|ed25519|ecdsa)$/.test(base);
    },
  },
  {
    id: "java-keystores",
    reason: "Java keystore files may contain private keys or secrets",
    matches: (filePath) => /\.(jks|keystore)$/i.test(path.posix.basename(filePath)),
  },
  {
    id: "cloud-credentials",
    reason: "credential JSON files must not be committed",
    matches: (filePath) => {
      const base = path.posix.basename(filePath);
      return base === "credentials.json" || /^service-account.*\.json$/i.test(base);
    },
  },
  {
    id: "auth-dotfiles",
    reason: "auth dotfiles may contain registry or machine credentials",
    matches: (filePath) => {
      const base = path.posix.basename(filePath).toLowerCase();
      return base === ".netrc" || base === ".npmrc" || base === ".pypirc";
    },
  },
  {
    id: "terraform-vars",
    reason: "Terraform variable files often contain credentials or environment secrets",
    matches: (filePath) => /\.tfvars$/i.test(path.posix.basename(filePath)),
  },
  {
    id: "secret-manifests",
    reason: "secret manifest files must not be committed",
    matches: (filePath) => {
      const base = path.posix.basename(filePath).toLowerCase();
      return (
        base === "key.json" ||
        base === "token.json" ||
        base === "secrets.json" ||
        base === "secrets.yaml"
      );
    },
  },
  {
    id: "macos-metadata",
    reason: "macOS Finder metadata should never be tracked",
    matches: (filePath) => path.posix.basename(filePath) === ".DS_Store",
  },
  {
    id: "windows-metadata",
    reason: "Windows Explorer metadata should never be tracked",
    matches: (filePath) => {
      const base = path.posix.basename(filePath).toLowerCase();
      return base === "thumbs.db" || base === "desktop.ini";
    },
  },
  {
    id: "python-bytecode",
    reason: "Python bytecode and cache directories are generated artifacts",
    matches: (filePath) =>
      /(^|\/)__pycache__(\/|$)/.test(filePath) || /\.pyc$/i.test(path.posix.basename(filePath)),
  },
  {
    id: "node-modules",
    reason: "node_modules content is generated locally and must not be committed",
    matches: (filePath) => /(^|\/)node_modules(\/|$)/.test(filePath),
  },
];

const FIXTURE_ALLOWLIST = [/^testdata\//, /(^|\/)testdata\//, /^test\/fixtures\//, /(^|\/)test\/fixtures\//];

function normalizeFilePath(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isFixturePath(filePath) {
  return FIXTURE_ALLOWLIST.some((pattern) => pattern.test(filePath));
}

function findBlockedFiles(filePaths) {
  const findings = [];
  for (const rawPath of filePaths) {
    const filePath = normalizeFilePath(rawPath);
    if (!filePath || isFixturePath(filePath)) {
      continue;
    }
    const rule = BLOCK_RULES.find((candidate) => candidate.matches(filePath));
    if (rule) {
      findings.push({ filePath, ruleId: rule.id, reason: rule.reason });
    }
  }
  return findings;
}

function getChangedFiles(baseRef, headRef) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...${headRef}`],
    { encoding: "utf-8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    console.error("Usage: node scripts/check-banned-files.mjs <base-ref> <head-ref>");
    return 2;
  }

  const [baseRef, headRef] = argv;
  let changedFiles;
  try {
    changedFiles = getChangedFiles(baseRef, headRef);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list changed files: ${message}`);
    return 2;
  }

  const findings = findBlockedFiles(changedFiles);
  if (findings.length === 0) {
    console.log("No banned files found in changed paths.");
    return 0;
  }

  console.error("Blocked files detected in this PR:");
  for (const finding of findings) {
    console.error(`- ${finding.filePath} (${finding.reason})`);
  }
  console.error("");
  console.error("Please remove these files from the PR or move legitimate fixtures under testdata/ or test/fixtures/.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { BLOCK_RULES, findBlockedFiles, getChangedFiles, isFixturePath, main, normalizeFilePath };
