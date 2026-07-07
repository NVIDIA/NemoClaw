// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Route-level regression for NemoClaw#5445: the OpenClaw commands reference page
// linked to `../deployment/install-openclaw-plugins`, which mirrors the target's
// SOURCE directory (`docs/deployment/install-openclaw-plugins.mdx`) rather than
// its PUBLISHED nav section. Fern serves that page under the `manage-sandboxes`
// section, so the source-directory link 404s on the live site even though the
// file exists on disk. `fern check` and source-path checks (PR #6290) missed it.
//
// These assertions exercise behavior: the route map is derived from
// docs/index.yml and the link is resolved the way Fern serves it, both inside
// the checker under test (docs page reads happen there, not here).

import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  extractMarkdownLinks,
  findBrokenPublishedRoutes,
  resolvePageLinkByText,
  resolvePublishedRoute,
} from "../scripts/check-docs-published-routes.ts";

const COMMANDS_SOURCE = "reference/commands.mdx";
const CORRECT_ROUTE = "/user-guide/openclaw/manage-sandboxes/install-openclaw-plugins";
const WRONG_ROUTE = "/user-guide/openclaw/deployment/install-openclaw-plugins";

const index = buildPublishedRouteIndex();
const installLink = resolvePageLinkByText(COMMANDS_SOURCE, "Install OpenClaw Plugins", index);

describe("docs published-route map derived from docs/index.yml (#5445)", () => {
  it("publishes Install OpenClaw Plugins under the manage-sandboxes section (#5445)", () => {
    expect(index.routes.has(CORRECT_ROUTE)).toBe(true);
  });

  it("does not publish the plugins page under a deployment route (#5445)", () => {
    expect(index.routes.has(WRONG_ROUTE)).toBe(false);
  });

  it("maps the commands source to the published OpenClaw commands route (#5445)", () => {
    expect(index.sourceToRoutes.get(COMMANDS_SOURCE)).toContain(
      "/user-guide/openclaw/reference/commands",
    );
  });
});

describe("OpenClaw commands page Install OpenClaw Plugins link (#5445)", () => {
  it("still links to Install OpenClaw Plugins from the commands page (#5445)", () => {
    expect(installLink).not.toBeNull();
  });

  it("resolves to the published manage-sandboxes route, not a source-path route (#5445)", () => {
    // Pre-fix (../deployment/install-openclaw-plugins) this resolved to
    // WRONG_ROUTE (not a published route), so these assertions failed on
    // upstream/main and pass only after the link is corrected.
    expect(installLink?.resolved).toBe(CORRECT_ROUTE);
    expect(installLink?.resolved).not.toBe(WRONG_ROUTE);
    expect(installLink?.published).toBe(true);
  });

  it("has no relative link that resolves to a nonexistent published route (#5445)", () => {
    expect(findBrokenPublishedRoutes(COMMANDS_SOURCE, index)).toEqual([]);
  });
});

describe("route resolver and link extractor robustness (#5445)", () => {
  it("resolves route-relative links the way Fern serves them (#5445)", () => {
    const from = "/user-guide/openclaw/reference/commands";
    expect(resolvePublishedRoute(from, "../manage-sandboxes/install-openclaw-plugins")).toBe(
      CORRECT_ROUTE,
    );
    expect(resolvePublishedRoute(from, "../deployment/install-openclaw-plugins")).toBe(WRONG_ROUTE);
    // Fern serves extensionless routes; a stray .mdx suffix resolves the same.
    expect(resolvePublishedRoute(from, "../manage-sandboxes/install-openclaw-plugins.mdx")).toBe(
      CORRECT_ROUTE,
    );
    // Fragments and queries do not change the target route.
    expect(resolvePublishedRoute(from, "../reference/network-policies#policy-tiers")).toBe(
      "/user-guide/openclaw/reference/network-policies",
    );
  });

  it("extracts links with code-span text, titles, and skips code fences (#5445)", () => {
    const body = [
      "[Install OpenClaw Plugins](../manage-sandboxes/install-openclaw-plugins)",
      '[`nemoclaw list`](../reference/commands "List sandboxes")',
      "````md",
      "```",
      "[fenced](../should/be/ignored)",
      "````",
      "`[inline code](../also/ignored)`",
    ].join("\n");
    const targets = extractMarkdownLinks(body).map((link) => link.target);
    expect(targets).toContain("../manage-sandboxes/install-openclaw-plugins");
    // Code-span link text is still captured; the title suffix is stripped.
    expect(targets).toContain("../reference/commands");
    // A 3-backtick line inside a 4-backtick block must not end the fence.
    expect(targets).not.toContain("../should/be/ignored");
    expect(targets).not.toContain("../also/ignored");
  });
});
