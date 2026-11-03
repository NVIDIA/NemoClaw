// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildRemediatedOpenClawPluginArchive,
  hashPackageTree,
  patchOpenClawMusicMetadataPackageGraph,
  remediateReviewedOpenClawPluginArchive,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

const roots: string[] = [];
const dependencies = {
  "@borewit/text-codec": "^0.2.2",
  "@tokenizer/token": "^0.3.0",
  "content-type": "^2.1.0",
  debug: "^4.4.3",
  "file-type": "^21.3.4",
  "media-typer": "^2.0.0",
  strtok3: "^10.3.5",
  "token-types": "^6.1.2",
  "uint8array-extras": "^1.5.0",
  "win-guid": "^0.2.1",
};
function fixture(version = "2026.9.2") {
  const root = mkdtempSync(path.join(tmpdir(), "music-metadata-remediation-"));
  roots.push(root);
  const plugin = path.join(root, "plugin"),
    replacement = path.join(root, "replacement");
  const baileys = path.join(plugin, "node_modules/baileys");
  const target = path.join(baileys, "node_modules/music-metadata");
  for (const directory of [target, replacement]) mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "@openclaw/whatsapp",
      version,
      dependencies: { baileys: "7.0.0-rc14" },
    }),
  );
  writeFileSync(
    path.join(baileys, "package.json"),
    JSON.stringify({
      name: "baileys",
      version: "7.0.0-rc14",
      dependencies: { "music-metadata": "^11.12.3" },
    }),
  );
  for (const [directory, version] of [
    [target, "11.15.0"],
    [replacement, "11.16.0"],
  ]) {
    writeFileSync(
      path.join(directory!, "package.json"),
      JSON.stringify({ name: "music-metadata", version, dependencies, engines: { node: ">=18" } }),
    );
    writeFileSync(path.join(directory!, "parser.js"), version!);
  }
  return { plugin, target, replacement };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("replaces the bundled parser and permits an unchanged retry", () => {
  const { plugin, target, replacement } = fixture();
  const patch = () =>
    patchOpenClawMusicMetadataPackageGraph(plugin, replacement, "@openclaw/whatsapp@2026.9.2");
  patch();
  patch();
  expect(readFileSync(path.join(target, "parser.js"), "utf8")).toBe("11.16.0");
  writeFileSync(path.join(target, "parser.js"), "modified");
  expect(patch).toThrow("Music metadata changed after remediation");
});
it("preserves the installed parser when replacement dependencies drift", () => {
  const { plugin, target, replacement } = fixture();
  const filename = path.join(replacement, "package.json");
  const metadata = JSON.parse(readFileSync(filename, "utf8"));
  metadata.dependencies.strtok3 = "^11.0.0";
  writeFileSync(filename, JSON.stringify(metadata));
  expect(() =>
    patchOpenClawMusicMetadataPackageGraph(plugin, replacement, "@openclaw/whatsapp@2026.9.2"),
  ).toThrow();
  expect(readFileSync(path.join(target, "parser.js"), "utf8")).toBe("11.15.0");
});

it("preserves npm's nested parser dependencies across replacement and retry", () => {
  const { plugin, target, replacement } = fixture();
  const nested = path.join(target, "node_modules", "file-type");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, "index.js"), "retained dependency");
  patchOpenClawMusicMetadataPackageGraph(plugin, replacement, "@openclaw/whatsapp@2026.9.2");
  patchOpenClawMusicMetadataPackageGraph(plugin, replacement, "@openclaw/whatsapp@2026.9.2");
  expect(readFileSync(path.join(nested, "index.js"), "utf8")).toBe("retained dependency");
});

it.each([
  [
    "2026.9.2",
    "sha512-fLr8urxlwrYm6r9RVXdVlYACuiXPehWu7LeZmR02SuBNb4H2onG5rs2lms9lamOrGsA+73z4qCtpBWG/WBibSg==",
  ],
  [
    "2026.9.5",
    "sha512-oycnF4CR3Ch5j3zGbJDunWqvGAGXMgT9nv1kqbcE1Ur90GZPZNqt9DM/ebDDPjss0jjOxAOzMnDePz64ruA6cQ==",
  ],
])(
  "rebuilds WhatsApp %s with the fixed parser and rejects source drift",
  (version, reviewedTree) => {
    const { plugin, target, replacement } = fixture(version);
    const root = path.dirname(plugin);
    const metadataPath = path.join(plugin, "package.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.bundledDependencies = ["baileys"];
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const expected = path.join(root, "expected");
    cpSync(plugin, expected, { recursive: true });
    const expectedParser = path.join(expected, "node_modules/baileys/node_modules/music-metadata");
    rmSync(expectedParser, { recursive: true });
    cpSync(replacement, expectedParser, { recursive: true });
    const expectedTree = hashPackageTree(expected);
    const pack = (directory: string, filename: string) => {
      const staging = mkdtempSync(path.join(root, "pack-"));
      cpSync(directory, path.join(staging, "package"), { recursive: true });
      const result = spawnSync("tar", ["-czf", filename, "-C", staging, "package"], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    };
    const sourceArchive = path.join(root, "whatsapp.tgz");
    const replacementArchive = path.join(root, "replacement.tgz");
    pack(plugin, sourceArchive);
    pack(replacement, replacementArchive);
    // Only the registry transport is synthetic; extraction, dispatch, remediation,
    // npm packing, and the emitted archive integrity checks use the real consumers.
    const npmExecutable = path.join(root, "registry-fixture.cjs");
    writeFileSync(
      npmExecutable,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const integrity = "sha512-D5zZHjQUbfR+JhHjnwdbgeB4qj7zVJtisCB1I0GAI5sjSPGqPLoY14WMIzMeR8iA+4nSFswVLpO4crksZUybBg==";
if (args[1] !== "music-metadata@11.16.0") process.exit(1);
if (args[0] === "view" && args[2] === "dist.integrity") console.log(integrity);
else if (args[0] === "view" && args[2] === "dist.tarball") console.log("https://registry.npmjs.org/music-metadata/-/music-metadata-11.16.0.tgz");
else if (args[0] === "pack" && args[2] === "--pack-destination") {
  fs.copyFileSync(${JSON.stringify(replacementArchive)}, path.join(args[3], "music-metadata.tgz"));
  console.log(JSON.stringify([{ filename: "music-metadata.tgz", integrity }]));
} else process.exit(1);
`,
      { mode: 0o700 },
    );
    const request = {
      archivePath: sourceArchive,
      packageSpec: `@openclaw/whatsapp@${version}`,
      workingDirectory: path.join(root, "work"),
      expectedPatchedTreeIntegrity: expectedTree,
      env: { NEMOCLAW_REVIEWED_NPM_EXECUTABLE: npmExecutable },
    };
    // The production consumer must retain its version-specific full-package pin,
    // even when a caller supplies the synthetic fixture's expected tree.
    expect(() => remediateReviewedOpenClawPluginArchive(request)).toThrow(
      `tree integrity mismatch: expected ${reviewedTree}, got ${expectedTree}`,
    );
    const result = buildRemediatedOpenClawPluginArchive(request);
    const extracted = path.join(root, "output");
    mkdirSync(extracted);
    const unpack = spawnSync("tar", ["-xzf", result.archivePath, "-C", extracted], {
      encoding: "utf8",
    });
    expect(unpack.status, unpack.stderr).toBe(0);
    const parser = path.join(extracted, "package/node_modules/baileys/node_modules/music-metadata");
    expect(JSON.parse(readFileSync(path.join(parser, "package.json"), "utf8")).version).toBe(
      "11.16.0",
    );
    expect(readFileSync(path.join(parser, "parser.js"), "utf8")).toBe("11.16.0");
    expect(hashPackageTree(path.join(extracted, "package"))).toBe(expectedTree);
    expect(result.treeIntegrity).toBe(expectedTree);
    const sourceMetadata = path.join(target, "package.json");
    const changed = JSON.parse(readFileSync(sourceMetadata, "utf8"));
    changed.version = "11.14.0";
    writeFileSync(sourceMetadata, JSON.stringify(changed));
    pack(plugin, sourceArchive);
    expect(() => buildRemediatedOpenClawPluginArchive(request)).toThrow(
      "Bundled music metadata must be music-metadata@11.15.0",
    );
    expect(readFileSync(path.join(target, "parser.js"), "utf8")).toBe("11.15.0");
  },
);
