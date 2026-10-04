// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OPENSHELL_DEV_ASSET_NAMES } from "../../../tools/e2e/openshell-dev-artifact.mts";

export const API_ROOT = "https://api.github.com/repos/NVIDIA/OpenShell";
export const RELEASE_URL = `${API_ROOT}/releases/tags/dev`;
export const SOURCE_COMMIT = "b".repeat(40);

type FixtureOptions = {
  missingAsset?: string;
  driftAfterDownload?: boolean;
  corruptAsset?: string;
  sourceCommit?: string;
};

export function fixtureFetch(options: FixtureOptions = {}): typeof fetch {
  const contents = new Map(
    OPENSHELL_DEV_ASSET_NAMES.map((name) => [name, Buffer.from(`fixture:${name}\n`)] as const),
  );
  let releaseReads = 0;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === RELEASE_URL) {
      releaseReads += 1;
      const assets = OPENSHELL_DEV_ASSET_NAMES.filter((name) => name !== options.missingAsset).map(
        (name, index) => {
          const bytes = contents.get(name);
          if (!bytes) throw new Error(`missing fixture bytes for ${name}`);
          return {
            id: 1000 + index,
            name,
            size: bytes.byteLength,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            url: `${API_ROOT}/releases/assets/${1000 + index}`,
            browser_download_url: `https://github.com/NVIDIA/OpenShell/releases/download/dev/${name}`,
          };
        },
      );
      return Response.json({
        id: 9051,
        tag_name: "dev",
        target_commitish: options.sourceCommit ?? SOURCE_COMMIT,
        url: `${API_ROOT}/releases/9051`,
        html_url: "https://github.com/NVIDIA/OpenShell/releases/tag/dev",
        updated_at:
          options.driftAfterDownload && releaseReads > 1
            ? "2026-08-13T22:08:00Z"
            : "2026-08-13T22:07:00Z",
        assets,
      });
    }
    const assetMatch = url.match(
      /^https:\/\/api\.github\.com\/repos\/NVIDIA\/OpenShell\/releases\/assets\/(\d+)$/,
    );
    if (assetMatch) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://release-assets.githubusercontent.com/${assetMatch[1]}` },
      });
    }
    const downloadMatch = url.match(/^https:\/\/release-assets\.githubusercontent\.com\/(\d+)$/);
    if (downloadMatch) {
      const index = Number(downloadMatch[1]) - 1000;
      const name = OPENSHELL_DEV_ASSET_NAMES[index];
      if (!name) throw new Error(`unexpected fixture asset id ${downloadMatch[1]}`);
      const expected = contents.get(name);
      if (!expected) throw new Error(`missing fixture bytes for ${name}`);
      const bytes = name === options.corruptAsset ? Buffer.from(expected).fill(120) : expected;
      return new Response(bytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-dev-artifact-"));
}
