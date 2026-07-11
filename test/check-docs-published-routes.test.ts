// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPublishedRouteIndex,
  findBrokenPublishedInferenceRoutes,
  findBrokenPublishedRedirects,
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
          - section: Configure Agents
            slug: configure-agents
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
See [Declarative Multi-Agent Manifest](../configure-agents/declarative-agents-manifest).
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

  it("validates variant redirect destinations independently", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const fernYaml = `
redirects:
  - source: /nemoclaw/user-guide/:variant/inference/legacy
    destination: /nemoclaw/user-guide/:variant/reference/commands
  - source: /nemoclaw/user-guide/openclaw/inference/static
    destination: /nemoclaw/user-guide/openclaw/reference/commands
  - source: /nemoclaw/user-guide/openclaw/inference/fixed-source
    destination: /nemoclaw/user-guide/:variant/reference/commands
`;

    expect(findBrokenPublishedRedirects(index, fernYaml)).toEqual([
      {
        source: "/nemoclaw/user-guide/deepagents/inference/legacy",
        destination: "/nemoclaw/user-guide/deepagents/reference/commands",
        resolved: "/user-guide/deepagents/reference/commands",
        variant: "deepagents",
      },
      {
        source: "/nemoclaw/user-guide/openclaw/inference/fixed-source",
        destination: "/nemoclaw/user-guide/deepagents/reference/commands",
        resolved: "/user-guide/deepagents/reference/commands",
        variant: "deepagents",
      },
    ]);
  });

  it("can guard inference links without expanding checks to unrelated links", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = commandsSource(`
See [Missing Inference](../inference/missing).
See [Missing Other Page](../other/missing).
`);

    withDocsSource(source, (docsDir) => {
      expect(findBrokenPublishedInferenceRoutes("reference/commands.mdx", index, docsDir)).toEqual([
        expect.objectContaining({
          fromRoute: "/user-guide/openclaw/reference/commands",
          resolved: "/user-guide/openclaw/inference/missing",
        }),
        expect.objectContaining({
          fromRoute: "/user-guide/hermes/reference/commands",
          resolved: "/user-guide/hermes/inference/missing",
        }),
      ]);
    });
  });

  it("includes inference section roots in focused route violations", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = commandsSource("See [Missing Inference Root](../inference).");

    withDocsSource(source, (docsDir) => {
      expect(findBrokenPublishedInferenceRoutes("reference/commands.mdx", index, docsDir)).toEqual([
        expect.objectContaining({
          fromRoute: "/user-guide/openclaw/reference/commands",
          resolved: "/user-guide/openclaw/inference",
        }),
        expect.objectContaining({
          fromRoute: "/user-guide/hermes/reference/commands",
          resolved: "/user-guide/hermes/inference",
        }),
      ]);
    });
  });
});
