// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROUND_TRIP_DOCS = [
  "docs/network-policy/customize-network-policy.mdx",
  "docs/network-policy/integration-policy-examples.mdx",
  "docs/reference/cli-selection-guide.mdx",
  "docs/reference/network-policies.mdx",
];

function readDoc(docPath: string): string {
  return readFileSync(path.join(process.cwd(), docPath), "utf8");
}

describe("policy round-trip documentation examples", () => {
  it("uses the NemoClaw base-policy export instead of a metadata-stripping pipeline", () => {
    for (const docPath of ROUND_TRIP_DOCS) {
      const text = readDoc(docPath);
      expect(text, docPath).toContain("OpenShell 0.0.72+");
      expect(text, docPath).toMatch(
        /\$\$nemoclaw (?:my-assistant|<sandbox-name>) policy-get > current-policy\.yaml/,
      );
      expect(text, docPath).toMatch(
        /openshell policy set --policy current-policy\.yaml --wait (?:my-assistant|<sandbox-name>)/,
      );
      expect(text, docPath).not.toContain("tmp_policy=$(mktemp)");
      expect(text, docPath).not.toContain("awk 'found { print }");
    }
  });

  it("documents raw output as diagnostic-only", () => {
    const commands = readDoc("docs/reference/commands.mdx");
    expect(commands).toContain("### `$$nemoclaw <name> policy-get`");
    expect(commands).toContain("$$nemoclaw my-assistant policy-get > current-policy.yaml");
    expect(commands).toContain("$$nemoclaw my-assistant policy-get --raw");
    expect(commands).toContain("Do not pass `--raw` output to `openshell policy set`");
  });
});
