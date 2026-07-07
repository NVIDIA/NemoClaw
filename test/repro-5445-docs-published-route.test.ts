// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Route-level regression for NemoClaw#5445: the OpenClaw commands reference page
// linked to `../deployment/install-openclaw-plugins`, which mirrors the target's
// SOURCE directory (`docs/deployment/install-openclaw-plugins.mdx`) rather than
// its PUBLISHED nav section. Fern serves that page under the `manage-sandboxes`
// section, so the source-directory link 404s on the live site even though the
// file exists on disk. `fern check` and source-path checks (PR #6290) missed it;
// these assertions derive the published route from docs/index.yml and check the
// route the reader actually navigates to.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  extractMarkdownLinks,
  findBrokenPublishedRoutes,
  resolvePublishedRoute,
} from "../scripts/check-docs-published-routes.ts";

const REPO_ROOT = path.dirname(import.meta.dirname);
const COMMANDS_SOURCE = "reference/commands.mdx";
const CORRECT_ROUTE = "/user-guide/openclaw/manage-sandboxes/install-openclaw-plugins";
const WRONG_ROUTE = "/user-guide/openclaw/deployment/install-openclaw-plugins";

const index = buildPublishedRouteIndex();
const commandsBody = fs.readFileSync(path.join(REPO_ROOT, "docs", COMMANDS_SOURCE), "utf8");
const installLink = extractMarkdownLinks(commandsBody).find(
  (link) => link.text === "Install OpenClaw Plugins",
);
const commandsRoutes = index.sourceToRoutes.get(COMMANDS_SOURCE) ?? [];

describe("docs published-route map derived from docs/index.yml (#5445)", () => {
  it("publishes Install OpenClaw Plugins under the manage-sandboxes section (#5445)", () => {
    expect(index.routes.has(CORRECT_ROUTE)).toBe(true);
  });

  it("does not publish the plugins page under a deployment route (#5445)", () => {
    expect(index.routes.has(WRONG_ROUTE)).toBe(false);
  });

  it("maps the commands source to the published OpenClaw commands route (#5445)", () => {
    expect(commandsRoutes).toContain("/user-guide/openclaw/reference/commands");
  });
});

describe("OpenClaw commands page Install OpenClaw Plugins link (#5445)", () => {
  it("still contains the Install OpenClaw Plugins link (#5445)", () => {
    expect(installLink).toBeDefined();
  });

  it("resolves to the published manage-sandboxes route, not a source-path route (#5445)", () => {
    expect(installLink).toBeDefined();
    const resolved = resolvePublishedRoute(
      "/user-guide/openclaw/reference/commands",
      installLink?.target ?? "",
    );
    // Pre-fix (../deployment/install-openclaw-plugins) this resolved to
    // WRONG_ROUTE and this assertion failed on upstream/main.
    expect(resolved).toBe(CORRECT_ROUTE);
    expect(resolved).not.toBe(WRONG_ROUTE);
    expect(index.routes.has(resolved)).toBe(true);
  });
});

describe("commands reference relative links resolve to published routes (#5445)", () => {
  it("has no relative link that resolves to a nonexistent published route (#5445)", () => {
    const violations = findBrokenPublishedRoutes(COMMANDS_SOURCE, index);
    expect(violations).toEqual([]);
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
