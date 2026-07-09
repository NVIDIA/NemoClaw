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
  it("keeps the URL-based MCP recipe least-privilege and narrowly scoped (#5322)", () => {
    const text = readDoc("docs/network-policy/customize-network-policy.mdx");
    const section = text
      .split("### Custom Recipe: URL-Based MCP Server")[1]
      ?.split("### Export, Edit, and Set the Base Policy")[0];

    expect(section).toBeDefined();
    expect(section).toContain('- allow: { method: GET, path: "/mcp" }');
    expect(section).toContain('- allow: { method: POST, path: "/mcp" }');
    expect(section).not.toContain('path: "/**"');
    expect(section?.match(/- \{ path: \/usr\/local\/bin\//g)).toHaveLength(1);
    expect(section).toContain("only the process that opens the connection");
    expect(section).toContain("do not replace it with `/**`");
    expect(section).toContain("does not disable OpenShell's SSRF protection");
    expect(section).toContain("getaddrinfo EAI_AGAIN");
    expect(section).toContain("is not fixed by widening this allowlist");
  });

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
