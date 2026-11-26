// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

export const DEFAULT_FERN_PREVIEW_INSTANCE =
  "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw";

const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const instancePathSegment = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]*[A-Za-z0-9])?$/;

export function resolveFernPreviewInstance(rawValue: string | undefined): string {
  if (rawValue === undefined) {
    return DEFAULT_FERN_PREVIEW_INSTANCE;
  }

  const value = rawValue.trim();
  if (!isFernPreviewInstance(value)) {
    throw new Error(
      "FERN_STAGING_INSTANCE must use the Fern <hostname>/<path> format without flags, whitespace, a URL scheme, query, or fragment",
    );
  }
  return value;
}

export function buildFernPreviewArgs(options: {
  fernVersion: string;
  instance: string;
  previewId: string;
}): string[] {
  return [
    "--yes",
    `fern-api@${options.fernVersion}`,
    "generate",
    "--docs",
    "--instance",
    options.instance,
    "--preview",
    "--id",
    options.previewId,
    "--force",
  ];
}

function isFernPreviewInstance(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    value.includes("://") ||
    /\s/.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }

  const [hostname, ...pathSegments] = value.split("/");
  const hostnameLabels = hostname.split(".");
  return (
    hostname.length <= 253 &&
    hostnameLabels.length >= 2 &&
    hostnameLabels.every((label) => hostnameLabel.test(label)) &&
    pathSegments.length > 0 &&
    pathSegments.every((segment) => instancePathSegment.test(segment))
  );
}

/** Use the branch's rendered v1 pages for PR previews, or link to v1 on shared staging. */
export function prepareStagingProject(repo: string, destination: string, v1Pages?: string): void {
  cpSync(path.join(repo, "docs"), path.join(destination, "docs"), { recursive: true });
  const fern = path.join(destination, "fern");
  cpSync(path.join(repo, "fern"), fern, {
    recursive: true,
    filter: (source) => ![".fern", ".fern-cache"].includes(path.basename(source)),
  });
  const config = path.join(fern, "docs.yml");
  const site = parse(readFileSync(config, "utf8"));
  const v1 = site.products.findIndex(
    (product: { "display-name": string }) => product["display-name"] === "v1",
  );
  if (v1 < 0) throw new Error("Expected a v1 product in fern/docs.yml");
  const v1Root = v1Pages
    ? "/nemoclaw/v1"
    : `https://${resolveFernPreviewInstance(process.env.FERN_STAGING_INSTANCE)}/v1`;
  const homePath = path.join(destination, "docs/index.mdx");
  const home = readFileSync(homePath, "utf8").replaceAll(
    /(\]\(|href=")https:\/\/docs\.nvidia\.com\/nemoclaw\/v1\//g,
    `$1${v1Root}/`,
  );
  writeFileSync(homePath, home);
  if (v1Pages) {
    const guide = path.join(fern, "v1");
    cpSync(v1Pages, guide, { recursive: true });
    const manifest = path.join(guide, "navigation.yml");
    const nav = parse(readFileSync(manifest, "utf8"));
    // Resolve v0 guide links from the shared home when served under v1.
    const docs = path.join(destination, "docs");
    const v1Home = home
      .replaceAll(/(\]\(|href=")\.\.\//g, "$1/nemoclaw/v0/user-guide/")
      .replaceAll("](/user-guide/", "](/nemoclaw/v0/user-guide/");
    writeFileSync(path.join(docs, "preview-v1-home.mdx"), v1Home);
    nav.navigation = [
      { page: "Home", slug: "home", path: "../../docs/preview-v1-home.mdx" },
      ...nav.navigation.filter((entry: { slug?: string }) => entry.slug !== "home"),
    ];
    writeFileSync(manifest, stringify(nav));
    site.redirects = [
      { source: "/nemoclaw/v1", destination: "/nemoclaw/v1/home" },
      ...(site.redirects ?? []),
    ];
    site.products[v1] = { "display-name": "v1", slug: "v1", path: "./v1/navigation.yml" };
  } else {
    site.products[v1].href = `${v1Root}/home`;
  }
  writeFileSync(config, stringify(site));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a temporary directory for the staging project");
  prepareStagingProject(path.resolve(import.meta.dirname, ".."), destination, process.argv[3]);
}
