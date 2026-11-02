// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { patchOpenClawMusicMetadataPackageGraph } from "../../../scripts/lib/openclaw-npm-remediation.mts";

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
function fixture() {
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
      version: "2026.9.2",
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
