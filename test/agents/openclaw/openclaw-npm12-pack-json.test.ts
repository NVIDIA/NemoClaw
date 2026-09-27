// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { patchOpenClawNpm12PackJson } from "../../../scripts/lib/patch-openclaw-npm12-pack-json.mts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const legacyEntries = "const entries = Array.isArray(parsed) ? parsed : [parsed];";
const nativeEntries = "const entries = resolveNpmJsonEntries(parsed);";

function parserFixture(): string {
  return `export function parse(raw) {
  const parsed = JSON.parse(raw);
  ${legacyEntries}
  return entries;
}\n`;
}

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
  it("accepts npm 12 keyed output without changing earlier npm output shapes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-pack-json-"));
    const source = path.join(root, "install-source-utils-fixture.js");
    try {
      fs.writeFileSync(source, parserFixture());
      expect(patchOpenClawNpm12PackJson(root, "2026.7.1")).toBe("patched");
      expect(patchOpenClawNpm12PackJson(root, "2026.7.1")).toBe("already-patched");

      const { parse } = (await import(`${pathToFileURL(source).href}?patched=1`)) as {
        parse(raw: string): unknown[];
      };
      const metadata = {
        filename: "diagnostics-otel-2026.7.1.tgz",
        id: "@openclaw/diagnostics-otel@2026.7.1",
        name: "@openclaw/diagnostics-otel",
        version: "2026.7.1",
      };
      expect(parse(JSON.stringify({ "@openclaw/diagnostics-otel": metadata }))).toEqual([metadata]);
      expect(parse(JSON.stringify([metadata]))).toEqual([metadata]);
      expect(parse(JSON.stringify(metadata))).toEqual([metadata]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts the reviewed native npm 12 parser in OpenClaw 2026.9.1", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-native-"));
    const source = path.join(root, "install-source-utils-fixture.js");
    const resolver = path.join(root, "npm-registry-spec-fixture.js");
    try {
      fs.writeFileSync(source, nativeParserFixture());
      fs.writeFileSync(resolver, nativeResolverFixture());
      expect(patchOpenClawNpm12PackJson(root, "2026.9.1")).toBe("already-patched");

      const { parse } = (await import(`${pathToFileURL(source).href}?native=1`)) as {
        parse(raw: string): unknown[];
      };
      const metadata = {
        filename: "openclaw-2026.9.1.tgz",
        id: "openclaw@2026.9.1",
        name: "openclaw",
        version: "2026.9.1",
      };
      expect(parse(JSON.stringify({ openclaw: metadata }))).toEqual([metadata]);
      expect(parse(JSON.stringify([metadata]))).toEqual([metadata]);
      expect(parse(JSON.stringify(metadata))).toEqual([metadata]);

      fs.writeFileSync(resolver, nativeResolverFixture().replace("Object.values", "Object.keys"));
      expect(() => patchOpenClawNpm12PackJson(root, "2026.9.1")).toThrow(
        /native npm pack JSON resolver shape is unsupported/,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("pins the two-file parser layout for OpenClaw 2026.3.11", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-2026-3-11-"));
    try {
      fs.writeFileSync(path.join(root, "npm-pack-install-first.js"), parserFixture());
      fs.writeFileSync(path.join(root, "npm-pack-install-second.js"), parserFixture());
      expect(patchOpenClawNpm12PackJson(root, "2026.3.11")).toBe("patched");
      expect(patchOpenClawNpm12PackJson(root, "2026.3.11")).toBe("already-patched");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed when two-file parser markers are distributed unevenly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-uneven-markers-"));
    const first = path.join(root, "npm-pack-install-first.js");
    const second = path.join(root, "npm-pack-install-second.js");
    try {
      fs.writeFileSync(first, parserFixture());
      fs.writeFileSync(second, parserFixture());
      expect(patchOpenClawNpm12PackJson(root, "2026.3.11")).toBe("patched");

      const patchedParser = fs.readFileSync(first, "utf8");
      fs.writeFileSync(first, `${patchedParser}${patchedParser}`);
      fs.writeFileSync(second, "export {};\n");

      expect(() => patchOpenClawNpm12PackJson(root, "2026.3.11")).toThrow(/legacy=0, patched=2/);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("pins the one-file parser layout for OpenClaw 2026.4.24", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-2026-4-24-"));
    try {
      fs.writeFileSync(path.join(root, "install-source-utils-fixture.js"), parserFixture());
      expect(patchOpenClawNpm12PackJson(root, "2026.4.24")).toBe("patched");
      expect(patchOpenClawNpm12PackJson(root, "2026.4.24")).toBe("already-patched");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed when the compiled parser shape is missing or ambiguous", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm12-pack-shape-"));
    try {
      fs.writeFileSync(path.join(root, "install-source-utils-missing.js"), "export {};\n");
      expect(() => patchOpenClawNpm12PackJson(root, "2026.7.1")).toThrow(/legacy=0, patched=0/);
      fs.writeFileSync(path.join(root, "install-source-utils-first.js"), parserFixture());
      fs.writeFileSync(path.join(root, "install-source-utils-second.js"), parserFixture());
      expect(() => patchOpenClawNpm12PackJson(root, "2026.7.1")).toThrow(/expected=1, found=3/);
      expect(() => patchOpenClawNpm12PackJson(root, "2026.8.0")).toThrow(
        /has no reviewed npm 12 parser layout/,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("patches both OpenClaw image paths before plugin installation", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const baseDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile.base"), "utf8");
    const script = "patch-openclaw-npm12-pack-json.mts";
    const invocation = "node /usr/local/lib/nemoclaw/npm12.mts";

    expect(dockerfile).toContain(`COPY scripts/lib/${script} /usr/local/lib/nemoclaw/npm12.mts`);
    expect(dockerfile).toContain(invocation);
    expect(dockerfile.indexOf(invocation)).toBeLessThan(
      dockerfile.indexOf(
        'openclaw plugins install --force --accept-capabilities "npm-pack:${plugin_install_archive}"',
      ),
    );
    expect(
      dockerfile.slice(dockerfile.indexOf(invocation), dockerfile.indexOf(invocation) + 250),
    ).toContain('"$OPENCLAW_VERSION"');
    expect(baseDockerfile).toContain(`COPY scripts/lib/${script} /scripts/lib/${script}`);
    const baseInvocationIndex = baseDockerfile.indexOf(`node /scripts/lib/${script}`);
    expect(baseInvocationIndex).toBeGreaterThanOrEqual(0);
    expect(baseDockerfile.slice(baseInvocationIndex, baseInvocationIndex + 300)).toContain(
      "/usr/local/lib/node_modules/openclaw/dist",
    );
    expect(baseDockerfile.slice(baseInvocationIndex, baseInvocationIndex + 300)).toContain(
      '"$OPENCLAW_VERSION"',
    );
  });
});
