// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MCP_BRIDGE_TEST_CREDENTIALS } from "../../test/e2e/fixtures/mcp-bridge-credentials.ts";

export interface ArtifactSecretLeak {
  credential: keyof typeof MCP_BRIDGE_TEST_CREDENTIALS;
  encoding: "base64" | "raw";
  file: string;
}

export interface ArtifactSecretScanResult {
  filesScanned: number;
  leaks: ArtifactSecretLeak[];
}

const BASE64_CANDIDATE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

function listArtifactFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`MCP artifact scan refuses symbolic link: ${path.relative(root, target)}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) visit(path.join(target, entry));
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`MCP artifact scan refuses non-regular file: ${path.relative(root, target)}`);
    }
    files.push(target);
  };
  visit(root);
  return files;
}

function decodedBase64Candidates(text: string): Buffer[] {
  return [text, text.replace(/(?:\s+|\\[rnt])+/gu, "")].flatMap((candidateText) =>
    [...candidateText.matchAll(BASE64_CANDIDATE)].map((match) => {
      const normalized = match[0].replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "=",
      );
      return Buffer.from(padded, "base64");
    }),
  );
}

export function scanMcpArtifactSecrets(rootDirectory: string): ArtifactSecretScanResult {
  const root = path.resolve(rootDirectory);
  const files = listArtifactFiles(root);
  const leaks: ArtifactSecretLeak[] = [];

  for (const file of files) {
    const data = fs.readFileSync(file);
    const text = data.toString("utf8");
    const decodedCandidates = decodedBase64Candidates(text);
    for (const [credential, secret] of Object.entries(MCP_BRIDGE_TEST_CREDENTIALS) as Array<
      [keyof typeof MCP_BRIDGE_TEST_CREDENTIALS, string]
    >) {
      const secretBytes = Buffer.from(secret, "utf8");
      if (data.includes(secretBytes)) {
        leaks.push({ credential, encoding: "raw", file: path.relative(root, file) });
      }
      const encodedForms = [
        secretBytes.toString("base64"),
        secretBytes.toString("base64").replace(/=+$/u, ""),
        secretBytes.toString("base64url"),
      ];
      if (
        encodedForms.some((encoded) => text.includes(encoded)) ||
        decodedCandidates.some((decoded) => decoded.includes(secretBytes))
      ) {
        leaks.push({ credential, encoding: "base64", file: path.relative(root, file) });
      }
    }
  }

  return { filesScanned: files.length, leaks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.argv[2];
    if (!root || process.argv.length !== 3) {
      throw new Error(
        "Usage: npx tsx tools/e2e/assert-mcp-artifact-secrets-absent.mts ARTIFACT_DIR",
      );
    }
    const result = scanMcpArtifactSecrets(root);
    if (result.leaks.length > 0) {
      for (const leak of result.leaks) {
        console.error(
          `::error file=${leak.file}::MCP artifact contains ${leak.encoding}-encoded ${leak.credential} fixture credential`,
        );
      }
      process.exitCode = 1;
    } else {
      console.log(`MCP artifact credential scan passed (${result.filesScanned} files)`);
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
