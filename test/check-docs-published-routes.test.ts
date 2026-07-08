// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPublishedRouteIndex,
  findBrokenPublishedRoutes,
  resolvePublishedRoute,
} from "../scripts/check-docs-published-routes.ts";

const navYaml = `
navigation:
  - section: User Guide
    variants:
      - slug: openclaw
        layout:
          - section: Reference
            slug: reference
            contents:
              - page: Commands
                path: _build/agent-variants/reference/commands.openclaw.generated.mdx
                slug: commands
          - section: Inference
            slug: inference
            contents:
              - page: Declarative Multi-Agent Manifest
                path: inference/declarative-agents-manifest.mdx
                slug: declarative-agents-manifest
      - slug: hermes
        layout:
          - section: Reference
            slug: reference
            contents:
              - page: Commands
                path: _build/agent-variants/reference/commands.hermes.generated.mdx
                slug: commands
`;

function withDocsSource(source: string, run: (docsDir: string) => void): void {
  const docsDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-doc-routes-"));
  try {
    const referenceDir = path.join(docsDir, "reference");
    mkdirSync(referenceDir, { recursive: true });
    writeFileSync(path.join(referenceDir, "commands.mdx"), source);
    run(docsDir);
  } finally {
    rmSync(docsDir, { recursive: true, force: true });
  }
}

function commandsSource(body: string): string {
  return `---
title: "Commands"
sidebar-title: "Commands"
description: "Commands."
description-agent: "Commands."
keywords: ["commands"]
---
import { AgentOnly } from "../_components/AgentGuide";

${body}
`;
}

describe("published docs route checking", () => {
  it("checks shared docs links after rendering AgentOnly blocks for each variant", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = commandsSource(`
<AgentOnly variant="openclaw">
See [Declarative Multi-Agent Manifest](../inference/declarative-agents-manifest).
</AgentOnly>

See [Hermes Commands](/user-guide/hermes/reference/commands).
`);

    withDocsSource(source, (docsDir) => {
      expect(findBrokenPublishedRoutes("reference/commands.mdx", index, docsDir)).toEqual([]);
    });
  });

  it("validates root-absolute routes after the docs base URL", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = commandsSource("See [Missing Page](/user-guide/hermes/reference/missing).");

    withDocsSource(source, (docsDir) => {
      expect(findBrokenPublishedRoutes("reference/commands.mdx", index, docsDir)).toEqual([
        expect.objectContaining({
          fromRoute: "/user-guide/openclaw/reference/commands",
          resolved: "/user-guide/hermes/reference/missing",
          target: "/user-guide/hermes/reference/missing",
        }),
        expect.objectContaining({
          fromRoute: "/user-guide/hermes/reference/commands",
          resolved: "/user-guide/hermes/reference/missing",
          target: "/user-guide/hermes/reference/missing",
        }),
      ]);
    });
  });

  it("resolves relative routes from the published URL route", () => {
    expect(
      resolvePublishedRoute("/user-guide/openclaw/reference/commands", "../inference/foo"),
    ).toBe("/user-guide/openclaw/inference/foo");
    expect(
      resolvePublishedRoute("/user-guide/openclaw/reference/commands", "/user-guide/hermes/foo"),
    ).toBe("/user-guide/hermes/foo");
  });
});
