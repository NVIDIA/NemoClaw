// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  buildPublishedRouteIndex,
  extractMarkdownLinks,
  findBrokenChangelogRoutes,
  findBrokenPublishedInferenceRoutes,
  findBrokenPublishedManageSandboxRoutes,
  findBrokenPublishedRedirects,
  findBrokenPublishedRoutes,
  findMissingDirectLegacyManageSandboxRedirects,
  findMissingDirectLegacyReleaseNotesRedirects,
  renderPublishedPageBodies,
  resolvePublishedRoute,
} from "../../scripts/check-docs-published-routes.mts";

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
      - slug: pi
        layout:
          - changelog: ./changelog
            title: Release Notes
            slug: release-notes
`;

const repoRoot = path.join(import.meta.dirname, "../..");
const fernYaml = readFileSync(path.join(repoRoot, "fern", "docs.yml"), "utf8");
const fernRedirects = (
  parse(fernYaml) as {
    redirects?: Array<{ source: string; destination: string }>;
  }
).redirects;

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
  it.each(["openclaw", "hermes", "deepagents", "pi"])(
    "indexes the native changelog route for %s",
    (variant) => {
      const index = buildPublishedRouteIndex(navYaml);

      expect(index.routes.has(`/user-guide/${variant}/release-notes`)).toBe(true);
      expect(index.routes.has(`/user-guide/${variant}/release-notes/2026/7/14`)).toBe(true);
    },
  );

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
        expect.objectContaining({
          fromRoute: "/user-guide/pi/release-notes/2026/7/14",
          resolved: "/user-guide/pi/release-notes/2026/reference/commands",
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

  it("rejects an Additional Setup redirect to an unpublished destination", () => {
    const index = buildPublishedRouteIndex(navYaml);
    const fernYaml = `
redirects:
  - source: /nemoclaw/get-started/prerequisites/station
    destination: /nemoclaw/user-guide/openclaw/get-started/additional-setup/missing
`;

    expect(findBrokenPublishedRedirects(index, fernYaml)).toEqual([
      {
        source: "/nemoclaw/get-started/prerequisites/station",
        destination: "/nemoclaw/user-guide/openclaw/get-started/additional-setup/missing",
        resolved: "/user-guide/openclaw/get-started/additional-setup/missing",
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

describe("Pi documentation routes", () => {
  const index = buildPublishedRouteIndex();

  it("publishes the Pi quickstart, operations, and support reference only in the Pi guide", () => {
    expect(index.routes.has("/user-guide/pi/get-started/quickstart")).toBe(true);
    expect(index.routes.has("/user-guide/pi/manage-sandboxes/run-pi")).toBe(true);
    expect(index.routes.has("/user-guide/pi/reference/commands")).toBe(true);
    expect(index.routes.has("/user-guide/pi/reference/pi-support")).toBe(true);
    expect([
      index.routes.has("/user-guide/openclaw/get-started/quickstart-pi"),
      index.routes.has("/user-guide/openclaw/manage-sandboxes/run-pi"),
      index.routes.has("/user-guide/openclaw/reference/pi-support"),
      index.routes.has("/user-guide/hermes/get-started/quickstart-pi"),
      index.routes.has("/user-guide/hermes/manage-sandboxes/run-pi"),
      index.routes.has("/user-guide/hermes/reference/pi-support"),
      index.routes.has("/user-guide/deepagents/get-started/quickstart-pi"),
      index.routes.has("/user-guide/deepagents/manage-sandboxes/run-pi"),
      index.routes.has("/user-guide/deepagents/reference/pi-support"),
    ]).toEqual([false, false, false, false, false, false, false, false, false]);
  });
});

describe("Manage Sandboxes extension routes", () => {
  const index = buildPublishedRouteIndex();

  it("redirects legacy HTML routes directly to their final pages", () => {
    expect(findMissingDirectLegacyManageSandboxRedirects()).toEqual([]);
  });

  it.each(["openclaw", "hermes", "deepagents"])(
    "publishes %s MCP pages under the MCP Servers group",
    (variant) => {
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
    },
  );

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

  it("publishes the Deep Agents runtime guide only in the Deep Agents guide", () => {
    const source = "manage-sandboxes/run-deep-agents-code.mdx";
    const quickstartSource = "get-started/quickstart-langchain-deepagents-code.mdx";
    const quickstartRoute = "/user-guide/deepagents/get-started/quickstart";
    const runtimeRoute =
      "/user-guide/deepagents/manage-sandboxes/operate-sandboxes/run-deep-agents-code";
    const [quickstartPage] = renderPublishedPageBodies(quickstartSource, index);

    expect(index.sourceToRoutes.get(source)?.map(({ route }) => route)).toEqual([runtimeRoute]);
    expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
    expect(findBrokenPublishedRoutes(quickstartSource, index)).toEqual([]);
    expect(quickstartPage.route).toBe(quickstartRoute);
    expect(
      extractMarkdownLinks(quickstartPage.body).map(({ target }) =>
        resolvePublishedRoute(quickstartRoute, target),
      ),
    ).toContain(runtimeRoute);
    expect(
      index.routes.has(
        "/user-guide/openclaw/manage-sandboxes/operate-sandboxes/run-deep-agents-code",
      ),
    ).toBe(false);
    expect(
      index.routes.has(
        "/user-guide/hermes/manage-sandboxes/operate-sandboxes/run-deep-agents-code",
      ),
    ).toBe(false);
  });

  it("preserves the legacy Deep Agents harness anchor", () => {
    const [quickstartPage] = renderPublishedPageBodies(
      "get-started/quickstart-langchain-deepagents-code.mdx",
      index,
    );

    expect(quickstartPage.body.match(/<a\s+id=["']use-the-harness["']\s*><\/a>/g)).toHaveLength(1);
  });
});

describe("Documentation Engineering routes", () => {
  const index = buildPublishedRouteIndex();

  it("publishes the agentic documentation guide for every agent variant", () => {
    const source = "resources/engineer-agentic-documentation.mdx";

    expect(index.sourceToRoutes.get(source)?.map(({ route }) => route)).toEqual([
      "/user-guide/openclaw/resources/engineer-agentic-documentation",
      "/user-guide/deepagents/resources/engineer-agentic-documentation",
      "/user-guide/hermes/resources/engineer-agentic-documentation",
    ]);
    expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
  });
});

describe("public security review boundaries", () => {
  const index = buildPublishedRouteIndex();
  const redirects = fernRedirects ?? [];
  const destinations = new Map(redirects.map(({ source, destination }) => [source, destination]));
  const redirectIndexes = new Map(redirects.map(({ source }, index) => [source, index]));

  it("keeps internal review files out of the public Security section", () => {
    const publicReviewFiles = readdirSync(path.join(repoRoot, "docs", "security")).filter((name) =>
      /review/iu.test(name),
    );

    expect(publicReviewFiles).toEqual([]);
  });

  it.each(["openclaw", "hermes", "deepagents"])(
    "keeps internal review routes out of the %s Security section",
    (variant) => {
      expect(
        index.routes.has(`/user-guide/${variant}/security/openshell-0.0.72-compatibility-review`),
      ).toBe(false);
      expect(
        index.routes.has(`/user-guide/${variant}/security/openshell-0.0.71-gateway-auth-review`),
      ).toBe(false);
    },
  );

  it.each(
    ["openshell-0.0.72-compatibility-review", "openshell-0.0.71-gateway-auth-review"].flatMap(
      (reviewSlug) =>
        [
          [
            `/nemoclaw/latest/user-guide/:variant/security/${reviewSlug}`,
            "/nemoclaw/latest/user-guide/:variant/security/security-controls/gateway-authentication-controls",
          ],
          [
            `/nemoclaw/user-guide/:variant/security/${reviewSlug}`,
            "/nemoclaw/user-guide/:variant/security/security-controls/gateway-authentication-controls",
          ],
          [
            `/nemoclaw/latest/security/${reviewSlug}`,
            "/nemoclaw/latest/user-guide/openclaw/security/security-controls/gateway-authentication-controls",
          ],
          [
            `/nemoclaw/security/${reviewSlug}`,
            "/nemoclaw/user-guide/openclaw/security/security-controls/gateway-authentication-controls",
          ],
        ].map(([sourceBase, destinationBase]) => ({ destinationBase, sourceBase })),
    ),
  )(
    "redirects $sourceBase directly to current security guidance",
    ({ sourceBase, destinationBase }) => {
      expect(destinations.get(sourceBase)).toBe(destinationBase);
      expect(destinations.get(`${sourceBase}.html`)).toBe(destinationBase);
      expect(destinations.get(`${sourceBase}/index.html`)).toBe(destinationBase);
      expect(destinations.get(`${sourceBase}.md`)).toBe(`${destinationBase}.md`);
      expect(destinations.get(`${sourceBase}.mdx`)).toBe(`${destinationBase}.mdx`);

      expect(redirectIndexes.get(`${sourceBase}.html`)).toBeLessThan(
        redirectIndexes.get("/nemoclaw/:path*.html") ?? -1,
      );
      const genericIndexSource = sourceBase.startsWith("/nemoclaw/latest/")
        ? "/nemoclaw/latest/:path*/index.html"
        : "/nemoclaw/:path*/index.html";
      expect(redirectIndexes.get(`${sourceBase}/index.html`)).toBeLessThan(
        redirectIndexes.get(genericIndexSource) ?? -1,
      );
    },
  );
});

describe("headless server deployment routes", () => {
  const index = buildPublishedRouteIndex();

  it.each(["openclaw", "hermes", "deepagents"])(
    "publishes the guide for the %s agent variant (#7180)",
    (variant) => {
      expect(index.routes.has(`/user-guide/${variant}/deployment/deploy-to-headless-server`)).toBe(
        true,
      );
    },
  );

  it("resolves every guide link against generated published routes (#7180)", () => {
    expect(findBrokenPublishedRoutes("deployment/deploy-to-headless-server.mdx", index)).toEqual(
      [],
    );
  });

  it("retires Brev-specific deployment pages in favor of the shared guide (#7180)", () => {
    expect(index.routes.has("/user-guide/openclaw/deployment/deploy-to-remote-gpu")).toBe(false);
    expect(index.routes.has("/user-guide/openclaw/deployment/brev-web-ui")).toBe(false);
  });

  const retiredBrevRouteCases = ["deploy-to-remote-gpu", "brev-web-ui"].flatMap((retiredSlug) =>
    [
      [
        `/nemoclaw/latest/user-guide/openclaw/deployment/${retiredSlug}`,
        "/nemoclaw/latest/user-guide/openclaw/deployment/deploy-to-headless-server",
      ],
      [
        `/nemoclaw/user-guide/openclaw/deployment/${retiredSlug}`,
        "/nemoclaw/user-guide/openclaw/deployment/deploy-to-headless-server",
      ],
      [
        `/nemoclaw/latest/deployment/${retiredSlug}`,
        "/nemoclaw/latest/user-guide/openclaw/deployment/deploy-to-headless-server",
      ],
      [
        `/nemoclaw/deployment/${retiredSlug}`,
        "/nemoclaw/user-guide/openclaw/deployment/deploy-to-headless-server",
      ],
    ].map(([sourceBase, destinationBase]) => ({ destinationBase, sourceBase })),
  );

  it.each(retiredBrevRouteCases)(
    "redirects $sourceBase directly to the shared guide (#7180)",
    ({ sourceBase, destinationBase }) => {
      const redirects = fernRedirects ?? [];
      const destinations = new Map(
        redirects.map(({ source, destination }) => [source, destination]),
      );
      const redirectIndexes = new Map(redirects.map(({ source }, index) => [source, index]));

      expect(destinations.get(sourceBase)).toBe(destinationBase);
      expect(destinations.get(`${sourceBase}.html`)).toBe(destinationBase);
      expect(destinations.get(`${sourceBase}/index.html`)).toBe(destinationBase);
      expect(destinations.get(`${sourceBase}.md`)).toBe(`${destinationBase}.md`);
      expect(destinations.get(`${sourceBase}.mdx`)).toBe(`${destinationBase}.mdx`);

      expect(redirectIndexes.get(`${sourceBase}.html`)).toBeLessThan(
        redirectIndexes.get("/nemoclaw/:path*.html") ?? -1,
      );
      const genericIndexSource = sourceBase.startsWith("/nemoclaw/latest/")
        ? "/nemoclaw/latest/:path*/index.html"
        : "/nemoclaw/:path*/index.html";
      expect(redirectIndexes.get(`${sourceBase}/index.html`)).toBeLessThan(
        redirectIndexes.get(genericIndexSource) ?? -1,
      );
    },
  );
});

describe("gateway lifecycle authority routes", () => {
  const index = buildPublishedRouteIndex();

  it.each(["openclaw", "hermes", "deepagents"])(
    "publishes the OpenShell gateway guide for the %s variant (#6576)",
    (variant) => {
      expect(
        index.routes.has(`/user-guide/${variant}/deployment/gateway-lifecycle-authority`),
      ).toBe(true);
    },
  );

  it("resolves every OpenShell gateway guide link for each guide variant (#6576)", () => {
    expect(findBrokenPublishedRoutes("deployment/gateway-lifecycle-authority.mdx", index)).toEqual(
      [],
    );
  });
});

describe("native changelog legacy routes", () => {
  it("redirects every retired Release Notes route directly to the changelog", () => {
    expect(findMissingDirectLegacyReleaseNotesRedirects()).toEqual([]);
  });
});
