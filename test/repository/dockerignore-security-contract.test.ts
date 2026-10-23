// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DOCKERIGNORE_PATH = path.join(REPO_ROOT, ".dockerignore");

describe("Docker build context secret exclusions", () => {
  // source-shape-contract: security -- Recursive exclusions keep nested credentials outside every Docker build context consumer.
  it("excludes secret-bearing names at every directory depth", () => {
    const rules = new Set(
      fs
        .readFileSync(DOCKERIGNORE_PATH, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
    const secretPatterns = [
      ".env",
      ".env.*",
      ".envrc",
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".direnv/",
      ".ssh/",
      "secrets/",
      ".credentials",
      "*.key",
      "*.pem",
      "*.pfx",
      "*.p12",
      "*.jks",
      "*.keystore",
      "*.tfvars",
      "*_ecdsa",
      "*_ed25519",
      "*_rsa",
      "credentials.json",
      "key.json",
      "secrets.json",
      "secrets.yaml",
      "service-account*.json",
      "token.json",
    ] as const;

    expect(secretPatterns.filter((pattern) => !rules.has(`**/${pattern}`))).toEqual([]);
    expect(secretPatterns.filter((pattern) => rules.has(pattern))).toEqual([]);
  });
});
