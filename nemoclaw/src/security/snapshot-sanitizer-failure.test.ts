// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDescriptorSnapshotActions,
  decodeDescriptorSnapshotContent,
  inspectDescriptorSnapshotRoot,
  installDescriptorSnapshotFile,
  resolveSnapshotSanitizerHelperPath,
  SnapshotSanitizerOperationError,
  SnapshotSanitizerPrerequisiteError,
  type SnapshotFileIdentity,
  scanDescriptorSnapshot,
  setSnapshotSanitizerHelperPathForTest,
} from "../shared/snapshot-sanitizer-boundary.cjs";
import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-sanitizer-failure-"));
  roots.push(root);
  return root;
}

function writeRawNodeHelper(lines: readonly string[]): string {
  const wrapperRoot = makeRoot();
  const wrapper = path.join(wrapperRoot, "snapshot-helper.mjs");
  writeFileSync(wrapper, lines.join("\n"));
  setSnapshotSanitizerHelperPathForTest(wrapper);
  return wrapper;
}

function writeNodeHelperWrapper(beforeForward: readonly string[]): string {
  const helper = resolveSnapshotSanitizerHelperPath();
  return writeRawNodeHelper([
    'import { readFileSync, renameSync, symlinkSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    ...beforeForward,
    'const input = readFileSync(0, "utf8");',
    `const helper = ${JSON.stringify(helper)};`,
    'const helperArguments = helper.endsWith(".mts") ? ["--import", "tsx", helper, process.argv[2]] : [helper, process.argv[2]];',
    "const result = spawnSync(process.execPath, helperArguments, {",
    '  encoding: "utf8", env: {}, input, maxBuffer: 48 * 1024 * 1024,',
    "});",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "process.exit(result.status ?? 1);",
  ]);
}

function writeStaticHelperResult(result: unknown): string {
  return writeRawNodeHelper([
    `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result }))});`,
  ]);
}

afterEach(() => {
  setSnapshotSanitizerHelperPathForTest(undefined);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("migration snapshot sanitizer fallbacks", () => {
  const identity: SnapshotFileIdentity = {
    dev: "1",
    ino: "2",
    mode: "16832",
    nlink: "1",
    size: "0",
    mtimeNs: "3",
    ctimeNs: "4",
  };
  const malformedDescriptorOutputs = [
    {
      label: "invalid root identity",
      output: JSON.stringify({ root: null, files: [] }),
    },
    {
      label: "non-array files",
      output: JSON.stringify({ root: identity, files: {} }),
    },
    {
      label: "null file",
      output: JSON.stringify({ root: identity, files: [null] }),
    },
    {
      label: "absolute file path",
      output: JSON.stringify({
        root: identity,
        files: [{ path: "/escape", metadata: identity }],
      }),
    },
    {
      label: "Windows-separated file path",
      output: JSON.stringify({
        root: identity,
        files: [{ path: "nested\\\\config.json", metadata: identity }],
      }),
    },
    {
      label: "null file metadata",
      output: JSON.stringify({
        root: identity,
        files: [{ path: "config.json", metadata: null }],
      }),
    },
    {
      label: "non-string file content",
      output: JSON.stringify({
        root: identity,
        files: [{ path: "config.json", metadata: identity, content: 42 }],
      }),
    },
  ];

  it("reports when native snapshot support is unavailable (#11174)", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    setSnapshotSanitizerHelperPathForTest(null);

    expect(() => sanitizeOpenClawConfigFile(configPath)).toThrow(
      SnapshotSanitizerPrerequisiteError,
    );
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("reports the validated root when native snapshot support is unavailable (#11174)", () => {
    const root = { canonicalPath: makeRoot(), identity };
    setSnapshotSanitizerHelperPathForTest(null);

    expect(() =>
      applyDescriptorSnapshotActions(root, { root: identity, files: [] }, [
        { kind: "remove", path: "config.json", metadata: identity },
      ]),
    ).toThrow(expect.objectContaining({ snapshotPath: root.canonicalPath }));
  });

  it("fails closed when the descriptor install helper is unavailable", () => {
    const root = inspectDescriptorSnapshotRoot(makeRoot());
    expect(root).not.toBeNull();
    setSnapshotSanitizerHelperPathForTest(null);

    expect(() =>
      installDescriptorSnapshotFile(root as NonNullable<typeof root>, "openclaw.json", "{}"),
    ).toThrow(SnapshotSanitizerPrerequisiteError);
  });

  it("rejects nested install targets before creating any entry", () => {
    const rootPath = makeRoot();
    const root = inspectDescriptorSnapshotRoot(rootPath);
    expect(root).not.toBeNull();

    expect(
      installDescriptorSnapshotFile(root as NonNullable<typeof root>, "nested/openclaw.json", "{}"),
    ).toBe(false);
    expect(() => statSync(path.join(rootPath, "nested", "openclaw.json"))).toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a destination swap before exclusive config installation",
    () => {
      const rootPath = makeRoot();
      const outsideRoot = makeRoot();
      const outsideConfig = path.join(outsideRoot, "outside.json");
      const original = JSON.stringify({ mustRemain: true });
      writeFileSync(outsideConfig, original, { mode: 0o640 });
      const outsideConfigFd = openSync(outsideConfig, "r");
      try {
        const originalMode = fstatSync(outsideConfigFd).mode & 0o777;
        const root = inspectDescriptorSnapshotRoot(rootPath);
        expect(root).not.toBeNull();
        writeNodeHelperWrapper([
          "if (process.argv[2] === 'install') {",
          `  symlinkSync(${JSON.stringify(outsideConfig)}, ${JSON.stringify(
            path.join(rootPath, "openclaw.json"),
          )});`,
          "}",
        ]);

        expect(() =>
          installDescriptorSnapshotFile(
            root as NonNullable<typeof root>,
            "openclaw.json",
            JSON.stringify({ installed: true }),
          ),
        ).toThrow(/snapshot-mutation-failed/u);
        expect(readFileSync(outsideConfigFd, "utf-8")).toBe(original);
        expect(fstatSync(outsideConfigFd).mode & 0o777).toBe(originalMode);
      } finally {
        closeSync(outsideConfigFd);
      }
    },
  );

  it.runIf(process.platform !== "win32")("rejects mutation of a scanned hard-linked file", () => {
    const rootPath = makeRoot();
    const targetPath = path.join(rootPath, "auth.json");
    const aliasPath = path.join(makeRoot(), "openclaw-alias.json");
    writeFileSync(targetPath, "original");
    const root = inspectDescriptorSnapshotRoot(rootPath)!;
    const scan = scanDescriptorSnapshot(root, new Set(["auth.json"]))!;
    const config = scan.files.find((file) => file.path === "auth.json")!;
    linkSync(targetPath, aliasPath);

    expect(() =>
      applyDescriptorSnapshotActions(root, scan, [
        {
          kind: "remove",
          path: config.path,
          metadata: config.metadata,
        },
      ]),
    ).toThrow(/snapshot-mutation-failed/u);
    expect(readFileSync(targetPath, "utf8")).toBe("original");
    expect(readFileSync(aliasPath, "utf8")).toBe("original");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a hard-linked readable config during scanning",
    () => {
      const rootPath = makeRoot();
      const targetPath = path.join(rootPath, "config.json");
      writeFileSync(targetPath, "{}");
      linkSync(targetPath, path.join(rootPath, "config-alias.json"));
      const root = inspectDescriptorSnapshotRoot(rootPath)!;

      expect(() => scanDescriptorSnapshot(root, new Set())).toThrow(/snapshot-scan-failed/u);
    },
  );

  it("accepts only absolute helper substitutions under Vitest", () => {
    expect(() => setSnapshotSanitizerHelperPathForTest("snapshot-helper.mjs")).toThrow(
      /test helper path must be absolute/u,
    );

    const originalVitest = process.env.VITEST;
    try {
      process.env.VITEST = "false";
      expect(() => setSnapshotSanitizerHelperPathForTest(null)).toThrow(
        /only available under Vitest/u,
      );
    } finally {
      process.env.VITEST = originalVitest;
    }
  });

  it.runIf(process.platform !== "win32")(
    "ignores a PATH-preceding helper before it can read unsanitized credentials",
    () => {
      const root = makeRoot();
      const configPath = path.join(root, "openclaw.json");
      const attackerRoot = makeRoot();
      const stolen = path.join(attackerRoot, "stolen-config");
      const wrapper = path.join(attackerRoot, "node");
      writeFileSync(configPath, JSON.stringify({ apiKey: "sk-secret-value" }));
      writeFileSync(
        wrapper,
        ["#!/bin/sh", `cp ${JSON.stringify(configPath)} ${JSON.stringify(stolen)}`, "exit 1"].join(
          "\n",
        ),
      );
      chmodSync(wrapper, 0o755);
      vi.stubEnv("PATH", `${attackerRoot}:${process.env.PATH ?? ""}`);

      expect(sanitizeOpenClawConfigFile(configPath)).toBe(true);
      expect(() => readFileSync(stolen)).toThrow();
      expect(readFileSync(configPath, "utf-8")).not.toContain("sk-secret-value");
    },
  );

  it("rejects invalid output from the descriptor helper", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    writeStaticHelperResult({});

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("rejects malformed helper protocol responses", () => {
    const root = { canonicalPath: makeRoot(), identity };
    writeRawNodeHelper(['process.stdout.write("not-json");']);
    expect(scanDescriptorSnapshot(root, new Set())).toBeNull();

    writeRawNodeHelper(['process.stdout.write("{}");']);
    expect(scanDescriptorSnapshot(root, new Set())).toBeNull();

    writeRawNodeHelper(["process.stdout.write('{\"ok\":true}');"]);
    expect(scanDescriptorSnapshot(root, new Set())).toBeNull();

    writeRawNodeHelper(['process.stdout.write(\'{"ok":false,"prerequisite":true}\');']);
    expect(() => scanDescriptorSnapshot(root, new Set())).toThrow(
      SnapshotSanitizerPrerequisiteError,
    );

    writeRawNodeHelper([
      'process.stdout.write(\'{"ok":false,"code":"unexpected-sensitive-code"}\');',
    ]);
    expect(scanDescriptorSnapshot(root, new Set())).toBeNull();
  });

  it("passes only the required Windows root variables to the helper", () => {
    const root = { canonicalPath: makeRoot(), identity };
    vi.stubEnv("SYSTEMROOT", "C:\\Windows");
    vi.stubEnv("WINDIR", "C:\\Windows");
    writeRawNodeHelper([
      `const valid = process.env.SYSTEMROOT === "C:\\\\Windows" && process.env.WINDIR === "C:\\\\Windows";`,
      `const result = valid ? ${JSON.stringify({ root: identity, files: [] })} : null;`,
      "process.stdout.write(JSON.stringify({ ok: true, result }));",
    ]);

    expect(scanDescriptorSnapshot(root, new Set())).toEqual({ root: identity, files: [] });
  });

  it("surfaces only the bounded failure class reported by the helper (#11174)", () => {
    const root = { canonicalPath: makeRoot(), identity };
    writeRawNodeHelper([
      'process.stdout.write(\'{"ok":false,"code":"snapshot-size-limit-exceeded"}\');',
    ]);

    let received: unknown;
    try {
      scanDescriptorSnapshot(root, new Set());
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(SnapshotSanitizerOperationError);
    expect(received).toMatchObject({
      code: "snapshot-size-limit-exceeded",
      message: "Native snapshot sanitization failed: snapshot-size-limit-exceeded",
      snapshotPath: root.canonicalPath,
    });
  });

  it("omits scanned content from the descriptor apply request", () => {
    const root = { canonicalPath: makeRoot(), identity };
    writeRawNodeHelper([
      'import { readFileSync } from "node:fs";',
      'const request = JSON.parse(readFileSync(0, "utf8"));',
      'const metadataOnly = request.scan.files.every((file) => !Object.hasOwn(file, "content"));',
      "process.stdout.write(JSON.stringify({ ok: true, result: metadataOnly }));",
    ]);

    expect(
      applyDescriptorSnapshotActions(
        root,
        { root: identity, files: [{ path: "config.json", metadata: identity, content: "e30=" }] },
        [{ kind: "remove", path: "config.json", metadata: identity }],
      ),
    ).toBe(true);
  });

  it.each(malformedDescriptorOutputs)(
    "rejects a malformed descriptor with $label",
    ({ output }) => {
      const root = { canonicalPath: makeRoot(), identity };
      writeStaticHelperResult(JSON.parse(output));
      expect(scanDescriptorSnapshot(root, new Set())).toBeNull();
    },
  );

  it("rejects unsafe roots and non-canonical helper payloads", () => {
    const root = makeRoot();
    const filePath = path.join(root, "not-a-directory");
    writeFileSync(filePath, "content");

    expect(() => inspectDescriptorSnapshotRoot(filePath)).toThrow(/not a safe directory/u);
    expect(decodeDescriptorSnapshotContent(undefined)).toBeNull();
    expect(decodeDescriptorSnapshotContent("not-base64!")).toBeNull();
    expect(decodeDescriptorSnapshotContent("AB==")).toBeNull();
    expect(
      applyDescriptorSnapshotActions(
        { canonicalPath: root, identity },
        { root: identity, files: [] },
        [],
      ),
    ).toBe(true);
  });

  it("decodes a maximum-size canonical helper payload without overflowing", () => {
    const raw = "a".repeat(16 * 1024 * 1024);
    const encoded = Buffer.from(raw, "utf-8").toString("base64");

    expect(decodeDescriptorSnapshotContent(encoded)).toBe(raw);
  });

  it("rejects large malformed and oversized helper payloads without overflowing", () => {
    const largeCanonical = Buffer.alloc(4 * 1024 * 1024, 0x61).toString("base64");
    const malformed = `${largeCanonical.slice(0, -4)}AA=A`;
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61).toString("base64");

    expect(decodeDescriptorSnapshotContent(malformed)).toBeNull();
    expect(decodeDescriptorSnapshotContent(oversized)).toBeNull();
  });

  it.each(["A", "AAAAA", "AA=A", "A===", "====", "YWJj=", "AB==", "AAB=", "/w==", "YWJj\n"])(
    "preserves canonical base64 and UTF-8 boundary rules [%s]",
    (rejected) => {
      expect(decodeDescriptorSnapshotContent("")).toBe("");
      expect(decodeDescriptorSnapshotContent("Zg==")).toBe("f");
      expect(decodeDescriptorSnapshotContent("Zm8=")).toBe("fo");
      expect(decodeDescriptorSnapshotContent("Zm9v")).toBe("foo");
      expect(decodeDescriptorSnapshotContent("aGVsbG8=")).toBe("hello");

      expect(decodeDescriptorSnapshotContent(rejected)).toBeNull();
    },
  );

  it.each(["AB==", "AAB="])(
    "rejects non-canonical base64 at the descriptor apply boundary [%s]",
    (content) => {
      const rootPath = makeRoot();
      const configPath = path.join(rootPath, "config.json");
      writeFileSync(configPath, "original");
      const root = inspectDescriptorSnapshotRoot(rootPath)!;
      const scan = scanDescriptorSnapshot(root, new Set())!;
      const config = scan.files.find((file) => file.path === "config.json")!;

      expect(scan).not.toBeNull();
      expect(config).toBeDefined();

      expect(() =>
        applyDescriptorSnapshotActions(root, scan, [
          { kind: "replace", path: config.path, metadata: config.metadata, content },
        ]),
      ).toThrow(/snapshot-mutation-failed/u);
      expect(readFileSync(configPath, "utf-8")).toBe("original");
    },
  );

  it("fails closed when sanitized output cannot be installed", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    writeNodeHelperWrapper(["if (process.argv[2] === 'apply') process.exit(1);"]);

    expect(() => sanitizeOpenClawConfigFile(configPath)).toThrow(/helper-process-failed/u);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("aborts optional-artifact sanitization when inspection fails", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ token: "raw" }));
    writeRawNodeHelper(["process.exit(1);"]);

    expect(() => sanitizeMigrationDirectory(root)).toThrow(/helper-process-failed/u);
  });

  it("removes optional artifacts that are not valid UTF-8", () => {
    const root = makeRoot();
    const artifact = path.join(root, "config.json");
    writeFileSync(artifact, Buffer.from([0xff, 0xfe, 0xfd]));

    sanitizeMigrationDirectory(root);

    expect(() => readFileSync(artifact)).toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the snapshot root disappears after identity validation",
    () => {
      const root = makeRoot();
      const movedRoot = `${root}-moved`;
      roots.push(movedRoot);
      writeFileSync(path.join(root, "config.json"), JSON.stringify({ token: "raw" }));
      writeNodeHelperWrapper([
        "if (process.argv[2] === 'scan-tree') {",
        `  renameSync(${JSON.stringify(root)}, ${JSON.stringify(movedRoot)});`,
        "}",
      ]);

      expect(() => sanitizeMigrationDirectory(root)).toThrow(/snapshot-scan-failed/u);
      expect(readFileSync(path.join(movedRoot, "config.json"), "utf-8")).toContain("raw");
    },
  );
});
