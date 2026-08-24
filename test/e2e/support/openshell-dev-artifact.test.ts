// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  OPENSHELL_DEV_ASSET_NAMES,
  resolveOpenShellDevArtifact,
  verifyOpenShellDevArtifact,
} from "../../../tools/e2e/openshell-dev-artifact.mts";
import {
  API_ROOT,
  fixtureFetch,
  RELEASE_URL,
  SOURCE_COMMIT,
  temporaryDirectory,
} from "./openshell-dev-artifact-fixture.ts";
import { requireFixture } from "./require-fixture.ts";

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
      requireFixture(manifestSha256, "fixture resolution omitted manifest digest");
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

  it("rejects a moving release target before download (#9051)", async () => {
    const directory = temporaryDirectory();
    try {
      await expect(
        resolveOpenShellDevArtifact(directory, fixtureFetch({ sourceCommit: "main" })),
      ).rejects.toMatchObject({
        identifier: "release:9051:tag:dev",
        sourceUrl: RELEASE_URL,
      });
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
      const assetPath = path.join(directory, "assets", OPENSHELL_DEV_ASSET_NAMES[0]);
      const original = fs.readFileSync(assetPath);
      fs.writeFileSync(assetPath, Buffer.alloc(original.byteLength));
      const manifestSha256 = resolution.manifestSha256;
      requireFixture(manifestSha256, "fixture resolution omitted manifest digest");

      expect(() => verifyOpenShellDevArtifact(directory, SOURCE_COMMIT, manifestSha256)).toThrow(
        /SHA-256 mismatch/,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a cached asset replaced by a symbolic link (#9051)", async () => {
    const directory = temporaryDirectory();
    try {
      const resolution = await resolveOpenShellDevArtifact(directory, fixtureFetch());
      const manifestSha256 = resolution.manifestSha256;
      requireFixture(manifestSha256, "fixture resolution omitted manifest digest");
      const assetPath = path.join(directory, "assets", OPENSHELL_DEV_ASSET_NAMES[0]);
      fs.unlinkSync(assetPath);
      fs.symlinkSync(path.join(directory, "manifest.json"), assetPath);

      expect(() => verifyOpenShellDevArtifact(directory, SOURCE_COMMIT, manifestSha256)).toThrow(
        /must be a regular file/,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
