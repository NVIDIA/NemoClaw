// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPublishedRouteIndex,
  findBrokenChangelogRoutes,
  findBrokenPublishedInferenceRoutes,
  findBrokenPublishedManageSandboxRoutes,
  findBrokenPublishedRedirects,
  findBrokenPublishedRoutes,
  findMissingDirectLegacyManageSandboxRedirects,
  findMissingDirectLegacyReleaseNotesRedirects,
  resolvePublishedRoute,
} from "../scripts/check-docs-published-routes.mts";

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
          - changelog: ./changelog
            title: Release Notes
            slug: release-notes
      - slug: hermes
        layout:
          - section: Reference
            slug: reference
            contents:
              - page: Commands
                path: _build/agent-variants/reference/commands.hermes.generated.mdx
                slug: commands
          - changelog: ./changelog
            title: Release Notes
            slug: release-notes
      - slug: deepagents
        layout:
          - changelog: ./changelog
            title: Release Notes
            slug: release-notes
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

function withChangelogSource(source: string, run: (docsDir: string) => void): void {
  const docsDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-changelog-routes-"));
  try {
    const changelogDir = path.join(docsDir, "changelog");
    mkdirSync(changelogDir, { recursive: true });
    writeFileSync(path.join(changelogDir, "2026-07-14.mdx"), source);
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
${body}
`;
}

describe("published docs route checking", () => {
  it("indexes the native changelog route for every agent variant", () => {
    const index = buildPublishedRouteIndex(navYaml);

    for (const variant of ["openclaw", "hermes", "deepagents"]) {
      expect(index.routes.has(`/user-guide/${variant}/release-notes`)).toBe(true);
      expect(index.routes.has(`/user-guide/${variant}/release-notes/2026/7/14`)).toBe(true);
    }
  });

  it("requires the shared changelog in every agent variant", () => {
    const incompleteNav = navYaml.replace(
      `      - slug: deepagents
        layout:
          - changelog: ./changelog
            title: Release Notes
            slug: release-notes
`,
      `      - slug: deepagents
        layout: []
`,
    );

    expect(() => findBrokenChangelogRoutes(buildPublishedRouteIndex(incompleteNav))).toThrow(
      "/user-guide/deepagents/release-notes",
    );
  });

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

  it("validates every changelog link against published routes", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = `## v0.0.83

See [Commands](/user-guide/openclaw/reference/commands).
See [July 14 release](/user-guide/openclaw/release-notes/2026/7/14).
`;

    withChangelogSource(source, (docsDir) => {
      expect(findBrokenChangelogRoutes(index, docsDir)).toEqual([]);
    });
  });

  it("rejects relative links from dated changelog permalinks", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = `## v0.0.83

See [Commands](../reference/commands).
`;

    withChangelogSource(source, (docsDir) => {
      expect(findBrokenChangelogRoutes(index, docsDir)).toEqual([
        expect.objectContaining({
          fromRoute: "/user-guide/openclaw/release-notes/2026/7/14",
          resolved: "/user-guide/openclaw/release-notes/2026/reference/commands",
        }),
        expect.objectContaining({
          fromRoute: "/user-guide/hermes/release-notes/2026/7/14",
          resolved: "/user-guide/hermes/release-notes/2026/reference/commands",
        }),
        expect.objectContaining({
          fromRoute: "/user-guide/deepagents/release-notes/2026/7/14",
          resolved: "/user-guide/deepagents/release-notes/2026/reference/commands",
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

  it("validates static Manage Sandboxes redirect destinations", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const fernYaml = `
redirects:
  - source: /nemoclaw/user-guide/openclaw/manage-sandboxes/legacy
    destination: /nemoclaw/user-guide/openclaw/reference/commands
  - source: /nemoclaw/user-guide/openclaw/manage-sandboxes/broken
    destination: /nemoclaw/user-guide/openclaw/manage-sandboxes/missing
  - source: /nemoclaw/manage-sandboxes/:path*
    destination: /nemoclaw/user-guide/openclaw/manage-sandboxes/:path*
`;

    expect(findBrokenPublishedRedirects(index, fernYaml)).toEqual([
      {
        source: "/nemoclaw/user-guide/openclaw/manage-sandboxes/broken",
        destination: "/nemoclaw/user-guide/openclaw/manage-sandboxes/missing",
        resolved: "/user-guide/openclaw/manage-sandboxes/missing",
        variant: null,
      },
    ]);
  });

  it("rejects Manage Sandboxes HTML redirects that would require a second hop", () => {
    const fernYaml = `
redirects:
  - source: /nemoclaw/latest/:path*/index.html
    destination: /nemoclaw/latest/:path*
  - source: /nemoclaw/:path*.html
    destination: /nemoclaw/:path*
  - source: /nemoclaw/latest/manage-sandboxes/lifecycle
    destination: /nemoclaw/latest/user-guide/openclaw/manage-sandboxes/operate-sandboxes/view-sandbox-status
`;

    expect(findMissingDirectLegacyManageSandboxRedirects(fernYaml)).toEqual([
      {
        source: "/nemoclaw/latest/manage-sandboxes/lifecycle.html",
        destination: null,
        expected:
          "/nemoclaw/latest/user-guide/openclaw/manage-sandboxes/operate-sandboxes/view-sandbox-status",
      },
      {
        source: "/nemoclaw/latest/manage-sandboxes/lifecycle/index.html",
        destination: null,
        expected:
          "/nemoclaw/latest/user-guide/openclaw/manage-sandboxes/operate-sandboxes/view-sandbox-status",
      },
    ]);
  });

  it("requires direct redirects for every retired Release Notes URL form", () => {
    const fernYaml = `
redirects:
  - source: /nemoclaw/latest/user-guide/:variant/about/release-notes
    destination: /nemoclaw/latest/user-guide/:variant/release-notes
`;

    expect(findMissingDirectLegacyReleaseNotesRedirects(fernYaml)).toHaveLength(19);
    expect(findMissingDirectLegacyReleaseNotesRedirects(fernYaml)).toContainEqual({
      source: "/nemoclaw/about/release-notes.html",
      destination: null,
      expected: "/nemoclaw/user-guide/openclaw/release-notes",
    });
    expect(findMissingDirectLegacyReleaseNotesRedirects(fernYaml)).toContainEqual({
      source: "/nemoclaw/about/release-notes.md",
      destination: null,
      expected: "/nemoclaw/user-guide/openclaw/release-notes.md",
    });
  });

  it("requires direct Release Notes HTML redirects before generic HTML rules", () => {
    const fernYaml = `
redirects:
  - source: /nemoclaw/:path*.html
    destination: /nemoclaw/:path*
  - source: /nemoclaw/latest/user-guide/:variant/about/release-notes.html
    destination: /nemoclaw/latest/user-guide/:variant/release-notes
`;

    expect(findMissingDirectLegacyReleaseNotesRedirects(fernYaml)).toContainEqual({
      source: "/nemoclaw/latest/user-guide/:variant/about/release-notes.html",
      destination: "/nemoclaw/latest/user-guide/:variant/release-notes",
      expected: "/nemoclaw/latest/user-guide/:variant/release-notes",
      mustPrecede: "/nemoclaw/:path*.html",
    });
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

  it("can guard Manage Sandboxes links without expanding checks to unrelated links", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = commandsSource(`
See [Missing Sandbox Page](../manage-sandboxes/operate-sandboxes/missing).
See [Missing Other Page](../other/missing).
`);

    withDocsSource(source, (docsDir) => {
      expect(
        findBrokenPublishedManageSandboxRoutes("reference/commands.mdx", index, docsDir),
      ).toEqual([
        expect.objectContaining({
          fromRoute: "/user-guide/openclaw/reference/commands",
          resolved: "/user-guide/openclaw/manage-sandboxes/operate-sandboxes/missing",
        }),
        expect.objectContaining({
          fromRoute: "/user-guide/hermes/reference/commands",
          resolved: "/user-guide/hermes/manage-sandboxes/operate-sandboxes/missing",
        }),
      ]);
    });
  });

  it("includes Manage Sandboxes section roots in focused route violations", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const source = commandsSource("See [Missing Manage Sandboxes Root](../manage-sandboxes).");

    withDocsSource(source, (docsDir) => {
      expect(
        findBrokenPublishedManageSandboxRoutes("reference/commands.mdx", index, docsDir),
      ).toEqual([
        expect.objectContaining({
          resolved: "/user-guide/openclaw/manage-sandboxes",
        }),
        expect.objectContaining({
          resolved: "/user-guide/hermes/manage-sandboxes",
        }),
      ]);
    });
  });
});

describe("Manage Sandboxes extension routes", () => {
  const index = buildPublishedRouteIndex();

  it("redirects legacy HTML routes directly to their final pages", () => {
    expect(findMissingDirectLegacyManageSandboxRedirects()).toEqual([]);
  });

  it("publishes MCP pages under the MCP Servers group for every agent variant", () => {
    for (const variant of ["openclaw", "hermes", "deepagents"]) {
      expect(
        index.routes.has(
          `/user-guide/${variant}/manage-sandboxes/mcp-servers/about-managed-mcp-servers`,
        ),
      ).toBe(true);
      expect(
        index.routes.has(
          `/user-guide/${variant}/manage-sandboxes/extend-sandboxes/about-managed-mcp-servers`,
        ),
      ).toBe(false);
    }
  });

  it("publishes plugin installation directly under supported Manage Sandboxes variants", () => {
    expect(index.routes.has("/user-guide/openclaw/manage-sandboxes/install-openclaw-plugins")).toBe(
      true,
    );
    expect(index.routes.has("/user-guide/hermes/manage-sandboxes/install-hermes-plugins")).toBe(
      true,
    );
    expect(
      index.routes.has("/user-guide/deepagents/manage-sandboxes/install-openclaw-plugins"),
    ).toBe(false);
  });
});

describe("native changelog legacy routes", () => {
  it("redirects every retired Release Notes route directly to the changelog", () => {
    expect(findMissingDirectLegacyReleaseNotesRedirects()).toEqual([]);
  });
});
