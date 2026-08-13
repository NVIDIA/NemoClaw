// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  OPENSHELL_DEV_ASSET_NAMES,
  prepareOpenShellDevBinaries,
  resolveOpenShellDevArtifact,
  verifyOpenShellDevArtifact,
} from "../../../tools/e2e/openshell-dev-artifact.mts";

const API_ROOT = "https://api.github.com/repos/NVIDIA/OpenShell";
const RELEASE_URL = `${API_ROOT}/releases/tags/dev`;
const TAG_URL = `${API_ROOT}/git/ref/tags/dev`;
const ANNOTATED_TAG_SHA = "a".repeat(40);
const SOURCE_COMMIT = "b".repeat(40);

type FixtureOptions = {
  missingAsset?: string;
  driftAfterDownload?: boolean;
  corruptAsset?: string;
};

function fixtureFetch(options: FixtureOptions = {}): typeof fetch {
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
        target_commitish: SOURCE_COMMIT,
        url: `${API_ROOT}/releases/9051`,
        html_url: "https://github.com/NVIDIA/OpenShell/releases/tag/dev",
        updated_at:
          options.driftAfterDownload && releaseReads > 1
            ? "2026-08-13T22:08:00Z"
            : "2026-08-13T22:07:00Z",
        assets,
      });
    }
    if (url === TAG_URL) {
      return Response.json({
        object: {
          type: "tag",
          sha: ANNOTATED_TAG_SHA,
          url: `${API_ROOT}/git/tags/${ANNOTATED_TAG_SHA}`,
        },
      });
    }
    if (url === `${API_ROOT}/git/tags/${ANNOTATED_TAG_SHA}`) {
      return Response.json({
        object: {
          type: "commit",
          sha: SOURCE_COMMIT,
          url: `${API_ROOT}/git/commits/${SOURCE_COMMIT}`,
        },
      });
    }
    const assetMatch = url.match(new RegExp(`^${API_ROOT}/releases/assets/(\\d+)$`));
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

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-dev-artifact-"));
}

describe("OpenShell dev artifact resolver", () => {
  it("binds one source commit to immutable asset identifiers and digests (#9051)", async () => {
    const directory = temporaryDirectory();
    try {
      const resolution = await resolveOpenShellDevArtifact(directory, fixtureFetch());

      expect(resolution.classification).toBe("resolved");
      expect(resolution.sourceCommit).toBe(SOURCE_COMMIT);
      expect(resolution.artifactName).toBe(
        `openshell-dev-${SOURCE_COMMIT}-${resolution.manifestSha256}`,
      );
      const manifestSha256 = resolution.manifestSha256;
      if (!manifestSha256) throw new Error("fixture resolution omitted manifest digest");
      expect(() =>
        verifyOpenShellDevArtifact(directory, SOURCE_COMMIT, manifestSha256),
      ).not.toThrow();
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
      expect(manifest.assets.map((asset: { name: string }) => asset.name)).toEqual(
        OPENSHELL_DEV_ASSET_NAMES,
      );
      expect(manifest.assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(Number),
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            apiUrl: expect.stringMatching(/\/releases\/assets\/\d+$/),
          }),
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("classifies a missing upstream asset as infrastructure with its source URL (#9051)", async () => {
    const directory = temporaryDirectory();
    const missingAsset = OPENSHELL_DEV_ASSET_NAMES[1];
    try {
      await expect(
        resolveOpenShellDevArtifact(directory, fixtureFetch({ missingAsset })),
      ).rejects.toMatchObject({
        identifier: `release:9051:asset:${missingAsset}`,
        sourceUrl: RELEASE_URL,
      });
      const resolution = JSON.parse(
        fs.readFileSync(path.join(directory, "resolution.json"), "utf8"),
      );
      expect(resolution).toMatchObject({
        classification: "infrastructure-failure",
        identifier: `release:9051:asset:${missingAsset}`,
        sourceUrl: RELEASE_URL,
      });
      expect(fs.existsSync(path.join(directory, "assets"))).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects asset bytes that disagree with the published digest (#9051)", async () => {
    const directory = temporaryDirectory();
    const corruptAsset = OPENSHELL_DEV_ASSET_NAMES[0];
    try {
      await expect(
        resolveOpenShellDevArtifact(directory, fixtureFetch({ corruptAsset })),
      ).rejects.toMatchObject({
        identifier: `asset:${corruptAsset}:id:1000`,
        sourceUrl: `${API_ROOT}/releases/assets/1000`,
      });
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a dev release that changes during resolution (#9051)", async () => {
    const directory = temporaryDirectory();
    try {
      await expect(
        resolveOpenShellDevArtifact(directory, fixtureFetch({ driftAfterDownload: true })),
      ).rejects.toMatchObject({
        identifier: `release:9051:tag:dev:source:${SOURCE_COMMIT}`,
        sourceUrl: RELEASE_URL,
      });
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects cached bytes changed after resolution (#9051)", async () => {
    const directory = temporaryDirectory();
    try {
      const resolution = await resolveOpenShellDevArtifact(directory, fixtureFetch());
      fs.appendFileSync(path.join(directory, "assets", OPENSHELL_DEV_ASSET_NAMES[0]), "changed");
      const manifestSha256 = resolution.manifestSha256;
      if (!manifestSha256) throw new Error("fixture resolution omitted manifest digest");

      expect(() => verifyOpenShellDevArtifact(directory, SOURCE_COMMIT, manifestSha256)).toThrow(
        /size mismatch/,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("prepares only the three reviewed regular binaries (#9051)", async () => {
    const directory = temporaryDirectory();
    const binaryDirectory = `${directory}-binaries`;
    try {
      const resolution = await resolveOpenShellDevArtifact(directory, fixtureFetch());
      const manifestSha256 = resolution.manifestSha256;
      if (!manifestSha256) throw new Error("fixture resolution omitted manifest digest");
      const members = new Map([
        ["openshell-x86_64-unknown-linux-musl.tar.gz", "openshell"],
        ["openshell-gateway-x86_64-unknown-linux-gnu.tar.gz", "openshell-gateway"],
        ["openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz", "openshell-sandbox"],
      ]);

      prepareOpenShellDevBinaries(
        directory,
        binaryDirectory,
        SOURCE_COMMIT,
        manifestSha256,
        (args) => {
          const archiveName = path.basename(args[1]);
          const member = members.get(archiveName);
          if (!member) return { status: 1, stdout: "", stderr: "unexpected archive" };
          if (args[0] === "-tzf") return { status: 0, stdout: `${member}\n`, stderr: "" };
          if (args[0] === "-tvzf") {
            return {
              status: 0,
              stdout: `-rwxr-xr-x 0/0 1 2026-01-01 00:00 ${member}\n`,
              stderr: "",
            };
          }
          if (args[0] === "-xzf") {
            const outputDirectory = args[args.indexOf("-C") + 1];
            fs.writeFileSync(path.join(outputDirectory, member), member);
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "unexpected tar operation" };
        },
      );

      expect(fs.readdirSync(binaryDirectory).sort()).toEqual([
        "openshell",
        "openshell-gateway",
        "openshell-sandbox",
      ]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
      fs.rmSync(binaryDirectory, { force: true, recursive: true });
    }
  });

  it("rejects an archive with an unexpected member before extraction (#9051)", async () => {
    const directory = temporaryDirectory();
    const binaryDirectory = `${directory}-binaries`;
    try {
      const resolution = await resolveOpenShellDevArtifact(directory, fixtureFetch());
      const manifestSha256 = resolution.manifestSha256;
      if (!manifestSha256) throw new Error("fixture resolution omitted manifest digest");

      expect(() =>
        prepareOpenShellDevBinaries(
          directory,
          binaryDirectory,
          SOURCE_COMMIT,
          manifestSha256,
          () => ({ status: 0, stdout: "../openshell\n", stderr: "" }),
        ),
      ).toThrow(/expected exactly one member/);
      expect(fs.existsSync(binaryDirectory)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
      fs.rmSync(binaryDirectory, { force: true, recursive: true });
    }
  });
});
