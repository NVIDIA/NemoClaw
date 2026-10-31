// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { patchOpenClawNpm12PackJson } from "../../../scripts/lib/patch-openclaw-npm12-pack-json.mts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const nativeEntries = "const entries = resolveNpmJsonEntries(parsed);";

function nativeParserFixture(): string {
  return `import { s as resolveNpmJsonEntries } from "./npm-registry-spec-fixture.js";
export function parse(raw) {
  const parsed = JSON.parse(raw);
  ${nativeEntries}
  return entries;
}\n`;
}

function nativeResolverFixture(): string {
  return `function resolveNpmJsonEntries(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value;
    if (!(typeof record.id === "string" || typeof record.name === "string" || typeof record.version === "string" || typeof record.filename === "string")) {
      const entries = Object.values(record).filter((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
      if (entries.length > 0) return entries;
    }
  }
  return [value];
}
export { resolveNpmJsonEntries as s };\n`;
}

describe("OpenClaw npm 12 pack JSON compatibility", () => {
  it("accepts the reviewed native npm 12 parser in OpenClaw 2026.9.2", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-native-"));
    const source = path.join(root, "install-source-utils-fixture.js");
    const resolver = path.join(root, "npm-registry-spec-fixture.js");
    try {
      fs.writeFileSync(source, nativeParserFixture());
      fs.writeFileSync(resolver, nativeResolverFixture());
      expect(patchOpenClawNpm12PackJson(root, "2026.9.2")).toBe("already-patched");

      const { parse } = (await import(`${pathToFileURL(source).href}?native=1`)) as {
        parse(raw: string): unknown[];
      };
      const metadata = {
        filename: "openclaw-2026.9.2.tgz",
        id: "openclaw@2026.9.2",
        name: "openclaw",
        version: "2026.9.2",
      };
      expect(parse(JSON.stringify({ openclaw: metadata }))).toEqual([metadata]);
      expect(parse(JSON.stringify([metadata]))).toEqual([metadata]);
      expect(parse(JSON.stringify(metadata))).toEqual([metadata]);

      fs.writeFileSync(resolver, nativeResolverFixture().replace("Object.values", "Object.keys"));
      expect(() => patchOpenClawNpm12PackJson(root, "2026.9.2")).toThrow(
        /native npm pack JSON resolver shape is unsupported/,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["2026.3.11", "2026.4.24", "2026.7.1", "2026.9.1", "2026.8.0"])(
    "rejects unsupported runtime %s before parser discovery",
    (version) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-version-"));
      try {
        expect(() => patchOpenClawNpm12PackJson(root, version)).toThrow(
          "has no reviewed npm 12 parser layout",
        );
        expect(fs.readdirSync(root)).toEqual([]);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("rejects a missing or ambiguous native parser before writing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-pack-shape-"));
    const source = path.join(root, "install-source-utils-first.js");
    try {
      fs.writeFileSync(source, "export {};\n");
      expect(() => patchOpenClawNpm12PackJson(root, "2026.9.2")).toThrow(
        "native npm pack JSON parser shape is unsupported",
      );
      expect(fs.readFileSync(source, "utf8")).toBe("export {};\n");
      fs.writeFileSync(path.join(root, "install-source-utils-second.js"), nativeParserFixture());
      expect(() => patchOpenClawNpm12PackJson(root, "2026.9.2")).toThrow("expected=1, found=2");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("validates the production runtime before plugin installation without a retired base-image path", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const baseDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile.base"), "utf8");
    const script = "patch-openclaw-npm12-pack-json.mts";
    const invocation = "node /usr/local/lib/nemoclaw/npm12.mts";

    expect(dockerfile).toContain(`COPY scripts/lib/${script} /usr/local/lib/nemoclaw/npm12.mts`);
    expect(dockerfile).toContain(invocation);
    expect(dockerfile.indexOf(invocation)).toBeLessThan(
      dockerfile.indexOf(
        'openclaw plugins install --force --accept-capabilities "npm-pack:${plugin_archive}"',
      ),
    );
    expect(
      dockerfile.slice(dockerfile.indexOf(invocation), dockerfile.indexOf(invocation) + 250),
    ).toContain('"$OPENCLAW_VERSION"');
    expect(baseDockerfile).not.toContain(script);
    expect(baseDockerfile).not.toContain("2026.7.1");
  });
});
