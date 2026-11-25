// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  buildFernPreviewArgs,
  DEFAULT_FERN_PREVIEW_INSTANCE,
  prepareStagingProject,
  resolveFernPreviewInstance,
} from "../../scripts/fern-preview-config.mts";

describe("Fern preview configuration", () => {
  it("publishes both guides and the shared home inside a combined PR preview", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "nemoclaw-fern-preview-"));
    try {
      const repo = path.join(temp, "repo");
      const generated = path.join(temp, "generated");
      const destination = path.join(temp, "preview");
      mkdirSync(path.join(repo, "fern"), { recursive: true });
      mkdirSync(path.join(repo, "docs"));
      mkdirSync(generated);
      writeFileSync(
        path.join(repo, "docs/index.mdx"),
        "[Quickstart](../openclaw/get-started/quickstart)",
      );
      const site =
        "products:\n  - display-name: v0\n    slug: v0\n    path: ../docs/index.yml\n  - display-name: v1\n    href: https://docs.nvidia.com/nemoclaw/v1/home\n    target: _self\n";
      writeFileSync(path.join(repo, "fern/docs.yml"), site);
      writeFileSync(path.join(generated, "overview.mdx"), "# v1 deployment guide");
      writeFileSync(
        path.join(generated, "navigation.yml"),
        "navigation:\n  - page: Overview\n    slug: overview\n    path: ./overview.mdx\n",
      );

      mkdirSync(path.join(repo, "fern/.fern"));
      mkdirSync(path.join(repo, "fern/.fern-cache"));
      vi.stubEnv("FERN_STAGING_INSTANCE", "preview.example.com/docs");
      const staging = path.join(temp, "staging");
      prepareStagingProject(repo, staging);
      expect(
        parse(readFileSync(path.join(staging, "fern/docs.yml"), "utf8")).products[1].href,
      ).toBe("https://preview.example.com/docs/v1/home");
      expect(readdirSync(path.join(staging, "fern"))).toEqual(["docs.yml"]);

      prepareStagingProject(repo, destination, generated);

      const fern = path.join(destination, "fern");
      const { products, redirects } = parse(readFileSync(path.join(fern, "docs.yml"), "utf8"));
      expect(redirects).toContainEqual({
        source: "/nemoclaw/v1",
        destination: "/nemoclaw/v1/home",
      });
      expect(products[0].slug).toBe("v0");
      expect(products[1]).toEqual({
        "display-name": "v1",
        path: "./v1/navigation.yml",
        slug: "v1",
      });
      const navigationFile = path.join(fern, products[1].path);
      const { navigation } = parse(readFileSync(navigationFile, "utf8"));
      const [home, overview] = navigation;
      expect([home.slug, overview.slug]).toEqual(["home", "overview"]);
      const directory = path.dirname(navigationFile);
      expect(readFileSync(path.resolve(directory, home.path), "utf8")).toBe(
        "[Quickstart](/nemoclaw/v0/user-guide/openclaw/get-started/quickstart)",
      );
      expect(readFileSync(path.resolve(directory, overview.path), "utf8")).toBe(
        "# v1 deployment guide",
      );
      expect(readFileSync(path.join(repo, "fern/docs.yml"), "utf8")).toBe(site);
    } finally {
      vi.unstubAllEnvs();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses the staging docs instance when no override is provided", () => {
    expect(resolveFernPreviewInstance(undefined)).toBe(DEFAULT_FERN_PREVIEW_INSTANCE);
  });

  it("trims and accepts a valid hostname/path override", () => {
    expect(resolveFernPreviewInstance("  preview.docs.buildwithfern.com/nemoclaw  ")).toBe(
      "preview.docs.buildwithfern.com/nemoclaw",
    );
  });

  it.each([
    "",
    "   ",
    "--help",
    "preview.docs.buildwithfern.com",
    "preview.docs.buildwithfern.com/my docs",
    "https://preview.docs.buildwithfern.com/nemoclaw",
    "preview.docs.buildwithfern.com/nemoclaw?draft=true",
    "preview.docs.buildwithfern.com/nemoclaw#draft",
    "preview.docs.buildwithfern.com/../nemoclaw",
  ])("rejects an invalid explicit instance override: %j", (value) => {
    expect(() => resolveFernPreviewInstance(value)).toThrow(
      "FERN_STAGING_INSTANCE must use the Fern <hostname>/<path> format",
    );
  });

  it("builds the Fern preview arguments in the required order", () => {
    expect(
      buildFernPreviewArgs({
        fernVersion: "3.67.1",
        instance: "preview.docs.buildwithfern.com/nemoclaw",
        previewId: "fix-docs-preview",
      }),
    ).toEqual([
      "--yes",
      "fern-api@3.67.1",
      "generate",
      "--docs",
      "--instance",
      "preview.docs.buildwithfern.com/nemoclaw",
      "--preview",
      "--id",
      "fix-docs-preview",
      "--force",
    ]);
  });
});
