// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Validate that internal cross-page links on drift-prone docs pages resolve to
// real *published* Fern routes, not merely to source files that exist on disk.
//
// Background (NemoClaw#5445): Fern publishes a page at a route built from its
// navigation section slugs (docs/index.yml), which can differ from the source
// file's directory. `docs/deployment/install-openclaw-plugins.mdx` is published
// under the `manage-sandboxes` section, so its route is
// `/user-guide/openclaw/manage-sandboxes/install-openclaw-plugins`. A link that
// mirrors the *source directory* (`../deployment/install-openclaw-plugins`)
// points at a route that does not exist and 404s on the live site even though
// the source file resolves on disk. PR #6290 made exactly that mistake because
// `fern check` and source-path checks both passed. This checker resolves links
// route-relative against the published route map so the drift cannot recur on
// the commands reference page that has regressed repeatedly. Root-absolute
// routes such as `/user-guide/openclaw/...` are valid too, and are checked
// against the same published route map.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

import { renderAgentVariantPage } from "./sync-agent-variant-docs.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(repoRoot, "docs");
const agentVariants = ["openclaw", "hermes", "deepagents"] as const;

type AgentVariant = (typeof agentVariants)[number];

export type PublishedRouteIndex = {
  /** Every published page route, e.g. `/user-guide/openclaw/reference/commands`. */
  routes: Set<string>;
  /** Docs source path (relative to docs/) → its published route(s). */
  sourceToRoutes: Map<string, PublishedSourceRoute[]>;
};

type PublishedSourceRoute = {
  route: string;
  variant: AgentVariant;
  renderedFromSharedSource: boolean;
};

type NavNode = {
  page?: string;
  section?: string;
  link?: string;
  title?: string;
  slug?: string;
  path?: string;
  contents?: NavNode[];
  layout?: NavNode[];
  variants?: NavNode[];
};

// A generated agent-variant page (`_build/agent-variants/foo.openclaw.generated.mdx`)
// is rendered from the shared source `foo.mdx`; map both paths to the same route,
// but remember that shared-source links must be checked after AgentOnly rendering.
function agentVariantSourcePath(navPath: string): string | null {
  const match = navPath.match(
    /^_build\/agent-variants\/(.+)\.(?:openclaw|hermes|deepagents)\.generated\.mdx$/,
  );
  return match ? `${match[1]}.mdx` : null;
}

function isAgentVariant(value: string): value is AgentVariant {
  return agentVariants.some((variant) => variant === value);
}

function walkLayout(
  nodes: NavNode[] | undefined,
  variant: AgentVariant,
  parents: string[],
  index: PublishedRouteIndex,
): void {
  for (const node of nodes ?? []) {
    // Fail loud rather than silently corrupt the route map: this repo always
    // declares explicit slugs, and Fern auto-derives a slug from the title when
    // one is omitted, so a slugless page/section would shift every downstream
    // route. If that convention ever changes, update this checker deliberately.
    if (node.path && !node.slug) {
      throw new Error(`docs/index.yml page '${node.path}' has no slug; route checker needs it`);
    }
    if (node.contents && node.section !== undefined && !node.slug) {
      throw new Error(
        `docs/index.yml section '${node.section}' has no slug; route checker needs it`,
      );
    }
    if (node.path && node.slug) {
      const route = `/${["user-guide", variant, ...parents, node.slug].join("/")}`;
      index.routes.add(route);
      const sourceEntries = [
        { path: node.path, renderedFromSharedSource: false },
        { path: agentVariantSourcePath(node.path), renderedFromSharedSource: true },
      ];
      for (const source of sourceEntries) {
        if (!source.path) continue;
        const existing = index.sourceToRoutes.get(source.path) ?? [];
        if (!existing.some((entry) => entry.route === route)) {
          existing.push({
            route,
            variant,
            renderedFromSharedSource: source.renderedFromSharedSource,
          });
        }
        index.sourceToRoutes.set(source.path, existing);
      }
    }
    if (node.contents) {
      const childParents = node.slug ? [...parents, node.slug] : parents;
      walkLayout(node.contents, variant, childParents, index);
    }
  }
}

export function buildPublishedRouteIndex(
  navYaml: string = readFileSync(path.join(docsRoot, "index.yml"), "utf8"),
): PublishedRouteIndex {
  const doc = parse(navYaml) as { navigation?: NavNode[] };
  const userGuide = doc.navigation?.find((item) => Array.isArray(item.variants));
  if (!userGuide?.variants) {
    throw new Error("docs/index.yml must define navigation variants");
  }
  const index: PublishedRouteIndex = { routes: new Set(), sourceToRoutes: new Map() };
  for (const variant of userGuide.variants) {
    if (!variant.slug || !isAgentVariant(variant.slug)) continue;
    walkLayout(variant.layout, variant.slug, [], index);
  }
  if (index.routes.size === 0) {
    throw new Error("no published routes derived from docs/index.yml");
  }
  return index;
}

/**
 * Resolve an internal link the way Fern serves it: root-absolute routes are
 * anchored after the docs base URL, and relative links are resolved against the
 * linking page's published route, NOT the source file's directory.
 */
export function resolvePublishedRoute(fromRoute: string, target: string): string {
  // Drop the query/fragment, then the .md/.mdx extension: Fern serves pages
  // extensionless, so `../foo/bar.mdx` and `../foo/bar` reach the same route.
  const cleanTarget = target.replace(/[?#].*$/, "").replace(/\.mdx?$/, "");
  if (cleanTarget.startsWith("/")) return cleanTarget.replace(/\/$/, "") || "/";
  const parts = fromRoute.replace(/^\//, "").split("/");
  parts.pop(); // drop the linking page's own slug
  for (const segment of cleanTarget.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return `/${parts.join("/")}`;
}

export type MarkdownLink = { text: string; target: string; line: number };

/** Extract markdown links, skipping fenced code blocks and inline code spans. */
export function extractMarkdownLinks(body: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const lines = body.split(/\r?\n/);
  // Track the opening fence char and length: a fence closes only on the same
  // char with length >= the opener (CommonMark), so a 3-backtick line inside a
  // 4-backtick or ~~~ block does not prematurely flip state.
  let fenceChar = "";
  let fenceLen = 0;
  let inFence = false;
  lines.forEach((rawLine, i) => {
    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const [char, len, rest] = [marker[0], marker.length, fenceMatch[2]];
      if (!inFence) {
        [inFence, fenceChar, fenceLen] = [true, char, len];
      } else if (char === fenceChar && len >= fenceLen && /^\s*$/.test(rest)) {
        [inFence, fenceChar, fenceLen] = [false, "", 0];
      }
      return;
    }
    if (inFence) return;
    // Blank out inline code spans so a `[x](y)` inside backticks is ignored, but
    // keep an empty link-text group (`[]`) matchable so links whose text is
    // entirely an inline-code span (e.g. [`nemoclaw list`](...)) are still seen.
    const scan = rawLine.replace(/`[^`]*`/g, "");
    // Tolerate an optional CommonMark link title: [text](target "title").
    const linkRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(scan)) !== null) {
      links.push({ text: match[1], target: match[2], line: i + 1 });
    }
  });
  return links;
}

function isInternalRouteLink(target: string): boolean {
  if (target.startsWith("#")) return false; // same-page anchor
  if (target.startsWith("//")) return false; // protocol-relative external URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // scheme (http:, mailto:, …)
  return true;
}

export type RouteViolation = {
  sourcePath: string;
  fromRoute: string;
  text: string;
  target: string;
  line: number;
  resolved: string;
};

/**
 * Validate every internal cross-page link on a docs source page against the
 * published route map. Returns the links that resolve to no published route.
 */
export function findBrokenPublishedRoutes(
  sourcePath: string,
  index: PublishedRouteIndex,
  docsDir: string = docsRoot,
): RouteViolation[] {
  const publishedRoutes = index.sourceToRoutes.get(sourcePath);
  if (!publishedRoutes || publishedRoutes.length === 0) {
    throw new Error(`${sourcePath} is not a published navigation page in docs/index.yml`);
  }
  const source = readFileSync(path.join(docsDir, sourcePath), "utf8");
  const violations: RouteViolation[] = [];
  for (const publishedRoute of publishedRoutes) {
    const body = renderBodyForPublishedRoute(source, sourcePath, publishedRoute);
    const links = extractMarkdownLinks(body).filter((link) => isInternalRouteLink(link.target));
    for (const link of links) {
      const resolved = resolvePublishedRoute(publishedRoute.route, link.target);
      if (!index.routes.has(resolved)) {
        violations.push({ sourcePath, fromRoute: publishedRoute.route, ...link, resolved });
      }
    }
  }
  return violations;
}

function renderBodyForPublishedRoute(
  source: string,
  sourcePath: string,
  publishedRoute: PublishedSourceRoute,
): string {
  if (!publishedRoute.renderedFromSharedSource) return source;
  return renderAgentVariantPage(source, publishedRoute.variant, { sourcePath });
}

export type ResolvedPageLink = {
  /** The raw link target as written in the source, e.g. `../deployment/x`. */
  target: string;
  /** The published route of the linking page. */
  fromRoute: string;
  /** The route the link resolves to, the way Fern serves it. */
  resolved: string;
  /** Whether `resolved` is an actual published route (false ⇒ 404 on the site). */
  published: boolean;
};

/**
 * Resolve a single named link on a published docs page to the route a reader
 * navigates to. Returns null if the page has no link with that display text.
 */
export function resolvePageLinkByText(
  sourcePath: string,
  linkText: string,
  index: PublishedRouteIndex,
  docsDir: string = docsRoot,
): ResolvedPageLink | null {
  return resolvePageLinksByText(sourcePath, linkText, index, docsDir)[0] ?? null;
}

export function resolvePageLinksByText(
  sourcePath: string,
  linkText: string,
  index: PublishedRouteIndex,
  docsDir: string = docsRoot,
): ResolvedPageLink[] {
  const routes = index.sourceToRoutes.get(sourcePath);
  if (!routes || routes.length === 0) {
    throw new Error(`${sourcePath} is not a published navigation page in docs/index.yml`);
  }
  const source = readFileSync(path.join(docsDir, sourcePath), "utf8");
  return routes.flatMap((publishedRoute) => {
    const body = renderBodyForPublishedRoute(source, sourcePath, publishedRoute);
    const link = extractMarkdownLinks(body).find((entry) => entry.text === linkText);
    if (!link) return [];
    const fromRoute = publishedRoute.route;
    const resolved = resolvePublishedRoute(fromRoute, link.target);
    return [{ target: link.target, fromRoute, resolved, published: index.routes.has(resolved) }];
  });
}

// Pages that have repeatedly regressed on source-path-vs-published-route drift
// (NemoClaw#5445, #6290, #5465, #5460). Scoped intentionally: the wider docs
// tree has unrelated pre-existing broken links tracked separately.
const GUARDED_SOURCE_PAGES = ["reference/commands.mdx", "reference/platform-support.mdx"];

function main(): void {
  const index = buildPublishedRouteIndex();
  const violations = GUARDED_SOURCE_PAGES.flatMap((source) =>
    findBrokenPublishedRoutes(source, index),
  );
  if (violations.length > 0) {
    console.error(
      "check-docs-published-routes: internal links resolve to no published Fern route.",
    );
    console.error(
      "Link by the target page's navigation section slug (docs/index.yml), not its source directory.\n",
    );
    for (const v of violations) {
      console.error(
        `  docs/${v.sourcePath}:${v.line} [${v.text}](${v.target})\n` +
          `    from route ${v.fromRoute}\n` +
          `    resolves to ${v.resolved} — not a published route`,
      );
    }
    process.exit(1);
  }
  console.log(
    `check-docs-published-routes: OK — ${GUARDED_SOURCE_PAGES.length} guarded page(s), all internal links resolve to published routes`,
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
