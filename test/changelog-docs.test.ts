// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { extractMarkdownLinks } from "../scripts/check-docs-published-routes.ts";

const docsDir = path.join(import.meta.dirname, "..", "docs");
const changelogDir = path.join(docsDir, "changelog");
const mdxSpdxHeader = `{/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */}`;
const expectedMigratedBulletCounts: Record<string, number> = {
  "v0.0.83": 9,
  "v0.0.82": 10,
  "v0.0.81": 7,
  "v0.0.80": 7,
  "v0.0.79": 7,
  "v0.0.78": 10,
  "v0.0.77": 4,
  "v0.0.76": 9,
  "v0.0.75": 6,
  "v0.0.74": 8,
  "v0.0.73": 6,
  "v0.0.72": 5,
  "v0.0.71": 6,
  "v0.0.70": 5,
  "v0.0.69": 7,
  "v0.0.68": 6,
  "v0.0.67": 3,
  "v0.0.66": 5,
  "v0.0.65": 6,
  "v0.0.64": 4,
  "v0.0.63": 4,
  "v0.0.62": 5,
  "v0.0.61": 6,
  "v0.0.60": 5,
  "v0.0.59": 5,
  "v0.0.58": 5,
  "v0.0.57": 6,
  "v0.0.56": 7,
  "v0.0.55": 3,
  "v0.0.54": 7,
  "v0.0.53": 8,
  "v0.0.52": 6,
  "v0.0.51": 10,
  "v0.0.50": 6,
  "v0.0.49": 11,
  "v0.0.48": 13,
  "v0.0.47": 5,
  "v0.0.46": 10,
  "v0.0.45": 7,
  "v0.0.44": 7,
  "v0.0.43": 3,
  "v0.0.42": 9,
  "v0.0.41": 5,
  "v0.0.40": 9,
  "v0.0.39": 13,
  "v0.0.38": 6,
  "v0.0.34": 0,
};

function compareVersionsDesc(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  return (
    rightParts
      .map((part, index) => part - leftParts[index])
      .find((difference) => difference !== 0) ?? 0
  );
}

describe("Fern changelog documentation", () => {
  // Compatibility boundary: Fern's staging changelog parser rejects HTML comments even when
  // the local docs check passes, so protect the required MDX header syntax directly.
  it("keeps SPDX headers parseable by the staging MDX parser", () => {
    const changelogFiles = fs
      .readdirSync(changelogDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.mdx$/.test(name))
      .sort();

    expect(changelogFiles.length).toBeGreaterThan(0);
    for (const fileName of changelogFiles) {
      const source = fs.readFileSync(path.join(changelogDir, fileName), "utf8");
      expect(
        source.startsWith(mdxSpdxHeader),
        `${fileName} must start with an MDX-compatible SPDX comment`,
      ).toBe(true);
      expect(source, `${fileName} must not use an HTML comment`).not.toContain("<!--");
    }

    const overview = fs.readFileSync(path.join(changelogDir, "overview.mdx"), "utf8");
    expect(overview).toMatch(
      /^---\n# SPDX-FileCopyrightText: Copyright \(c\) 2026 NVIDIA CORPORATION & AFFILIATES\. All rights reserved\.\n# SPDX-License-Identifier: Apache-2\.0\n---/,
    );
    expect(overview).not.toContain("<!--");
  });

  it("keeps one complete cross-agent history in dated entries", () => {
    const datedFiles = fs
      .readdirSync(changelogDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.mdx$/.test(name))
      .sort();
    const versions: string[] = [];
    const releaseBlocks = new Map<string, string>();

    for (const fileName of datedFiles) {
      const source = fs.readFileSync(path.join(changelogDir, fileName), "utf8");
      expect(source, `${fileName} must use literal CLI names`).not.toContain("$$nemoclaw");
      expect(source, `${fileName} must not contain variant-only wrappers`).not.toContain(
        "<AgentOnly",
      );

      const versionMatches = Array.from(source.matchAll(/^## (v\d+\.\d+\.\d+)$/gm));
      const fileVersions = versionMatches.map((match) => match[1]);
      expect(fileVersions.length, `${fileName} must contain at least one release`).toBeGreaterThan(
        0,
      );
      expect(fileVersions, `${fileName} must keep newest releases first`).toEqual(
        [...fileVersions].sort(compareVersionsDesc),
      );
      versions.push(...fileVersions);

      for (const [index, match] of versionMatches.entries()) {
        const version = match[1];
        const block = source.slice(match.index, versionMatches[index + 1]?.index ?? source.length);
        releaseBlocks.set(version, block);
      }

      const relativeLinks = extractMarkdownLinks(source).filter(
        ({ target }) =>
          !target.startsWith("/") &&
          !target.startsWith("#") &&
          !target.startsWith("//") &&
          !/^[a-z][a-z0-9+.-]*:/i.test(target),
      );
      expect(relativeLinks, `${fileName} must use root-absolute internal routes`).toEqual([]);
    }

    for (const [version, expectedBullets] of Object.entries(expectedMigratedBulletCounts)) {
      const block = releaseBlocks.get(version);
      expect(block, `${version} must remain in the migrated history`).toBeDefined();
      expect(
        block?.match(/^- /gm)?.length ?? 0,
        `${version} must retain its complete detailed list`,
      ).toBe(expectedBullets);
    }

    const migratedVersions = [
      ...Array.from({ length: 83 - 38 + 1 }, (_, index) => `v0.0.${83 - index}`),
      "v0.0.34",
    ];
    expect(new Set(versions).size, "release versions must be unique").toBe(versions.length);
    expect(versions).toEqual(expect.arrayContaining(migratedVersions));
  });

  it("keeps the initial release examples", () => {
    const source = fs.readFileSync(path.join(changelogDir, "2026-05-05.mdx"), "utf8");

    expect(source).toContain("## v0.0.34");
    expect(source.match(/^```bash$/gm)?.length ?? 0, "v0.0.34 must retain its examples").toBe(3);
  });

  it("sorts complete semantic versions newest first", () => {
    expect(["v0.0.99", "v0.1.0", "v1.0.0"].sort(compareVersionsDesc)).toEqual([
      "v1.0.0",
      "v0.1.0",
      "v0.0.99",
    ]);
  });

  it("keeps the changelog overview focused on releases", () => {
    const overview = fs.readFileSync(path.join(changelogDir, "overview.mdx"), "utf8");
    const updateSandboxes = fs.readFileSync(
      path.join(docsDir, "manage-sandboxes", "update-sandboxes.mdx"),
      "utf8",
    );
    const commands = fs.readFileSync(path.join(docsDir, "reference", "commands.mdx"), "utf8");

    expect(overview).not.toContain("Component Version Policy");
    expect(updateSandboxes).toContain("## Understand Agent Version Pins");
    expect(commands).toContain(
      "../manage-sandboxes/operate-sandboxes/update-sandboxes#understand-agent-version-pins",
    );
  });

  it("publishes the same native changelog source in all three user-guide variants", () => {
    const nav = parse(fs.readFileSync(path.join(docsDir, "index.yml"), "utf8")) as {
      navigation?: Array<{
        variants?: Array<{
          slug?: string;
          layout?: Array<{
            changelog?: string;
            title?: string;
            slug?: string;
            icon?: string;
            path?: string;
          }>;
        }>;
      }>;
    };
    const variants = nav.navigation?.find((item) => item.variants)?.variants ?? [];

    expect(variants.map((variant) => variant.slug)).toEqual(["openclaw", "deepagents", "hermes"]);
    for (const variant of variants) {
      expect(variant.layout?.filter((node) => node.changelog)).toEqual([
        {
          changelog: "./changelog",
          title: "Release Notes",
          slug: "release-notes",
        },
      ]);
    }
    expect(fs.existsSync(path.join(docsDir, "about", "release-notes.mdx"))).toBe(false);
  });
});
