// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DOCS = [
  "docs/network-policy/customize-network-policy.mdx",
  "docs/network-policy/integration-policy-examples.mdx",
  "docs/reference/cli-selection-guide.mdx",
  "docs/reference/network-policies.mdx",
];

const SOURCE_REVIEW_MARKERS = [
  "invalidState: OpenShell 0.0.72 policy get --base emits metadata before the --- YAML header.",
  "sourceBoundary: OpenShell CLI output is owned by the separate OpenShell project.",
  "whyNotSourceFix: NemoClaw pins OpenShell but cannot change that upstream formatter here.",
  "regressionTest: test/policy-roundtrip-docs.test.ts validates this shared docs pattern.",
  "removalCondition: remove this pipeline after pinned OpenShell emits clean raw YAML.",
];

function readDoc(docPath: string): string {
  return readFileSync(path.join(process.cwd(), docPath), "utf8");
}

function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

describe("policy round-trip documentation examples", () => {
  it("executes the documented extractor against OpenShell 0.0.72 base output", () => {
    const extractor = "awk 'found { print } /^---$/ { found = 1 } END { if (!found) exit 1 }'";
    const valid = spawnSync("bash", ["-o", "pipefail", "-c", extractor], {
      encoding: "utf8",
      input: "Version: 1\nHash: sha256:test\n---\nversion: 1\nnetwork_policies: {}\n",
    });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toBe("version: 1\nnetwork_policies: {}\n");

    const missingHeader = spawnSync("bash", ["-o", "pipefail", "-c", extractor], {
      encoding: "utf8",
      input: "version: 1\nnetwork_policies: {}\n",
    });
    expect(missingHeader.status).not.toBe(0);
    expect(missingHeader.stdout).toBe("");
  });

  it("keeps raw policy get/set snippets aligned with NemoClaw's OpenShell command builders", () => {
    for (const docPath of DOCS) {
      const text = readDoc(docPath);
      expect(text, docPath).toContain("OpenShell 0.0.72+");
      expect(text, docPath).toMatch(/openshell policy get --base (?:my-assistant|<sandbox-name>)/);
      expect(text, docPath).toMatch(
        /openshell policy set --policy current-policy\.yaml --wait (?:my-assistant|<sandbox-name>)/,
      );
      expect(text, docPath).not.toMatch(
        /openshell policy get (?:my-assistant|<sandbox-name>) --base/,
      );
      expect(text, docPath).not.toMatch(/openshell policy get --full/);
      expect(text, docPath).not.toMatch(
        /openshell policy set (?:my-assistant|<sandbox-name>) --policy/,
      );
    }
  });

  it("keeps metadata-stripping blocks fail-closed and source-boundary documented", () => {
    for (const docPath of DOCS) {
      const block = bashBlocks(readDoc(docPath)).find((candidate) =>
        candidate.includes("tmp_policy=$(mktemp)"),
      );
      expect(block, `${docPath} extraction block`).toBeDefined();
      expect(block, docPath).toContain("# shellcheck shell=bash");
      for (const marker of SOURCE_REVIEW_MARKERS) {
        expect(block, `${docPath} missing ${marker}`).toContain(marker);
      }
      expect(block, docPath).toContain(
        "awk 'found { print } /^---$/ { found = 1 } END { if (!found) exit 1 }'",
      );
      expect(block, docPath).toContain("grep -q '^version:'");
      expect(block, docPath).toContain("grep -q '^network_policies:'");
      expect(block, docPath).not.toContain("openshell policy set");
    }
  });

  it("keeps reference pages from applying stale policy files after failed extraction", () => {
    for (const docPath of [
      "docs/reference/cli-selection-guide.mdx",
      "docs/reference/network-policies.mdx",
    ]) {
      const rawBlocks = bashBlocks(readDoc(docPath));
      const extractionBlock = rawBlocks.find((block) => block.includes("tmp_policy=$(mktemp)"));
      const applyBlock = rawBlocks.find((block) => block.includes("openshell policy set --policy"));
      expect(extractionBlock, `${docPath} extraction block`).toBeDefined();
      expect(applyBlock, `${docPath} apply block`).toBeDefined();
      expect(extractionBlock).not.toBe(applyBlock);
    }
  });
});
