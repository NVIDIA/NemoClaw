// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDescriptorSnapshotActions,
  decodeDescriptorSnapshotContent,
  inspectDescriptorSnapshotRoot,
  type SnapshotFileIdentity,
  scanDescriptorSnapshot,
} from "../shared/snapshot-sanitizer-boundary.cjs";
import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-sanitizer-failure-"));
  roots.push(root);
  return root;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writePythonWrapper(lines: readonly string[]): string {
  const wrapperRoot = makeRoot();
  const wrapper = path.join(wrapperRoot, "python3");
  writeFileSync(wrapper, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(wrapper, 0o755);
  vi.stubEnv("PATH", `${wrapperRoot}:${process.env.PATH ?? ""}`);
  return wrapper;
}

afterEach(() => {
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

  it("fails closed when the descriptor helper is unavailable", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    vi.stubEnv("PATH", makeRoot());

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("rejects invalid output from the descriptor helper", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    writePythonWrapper(["printf '%s\\n' '{}'", "exit 0"]);

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("rejects every malformed descriptor scan boundary", () => {
    const root = { canonicalPath: makeRoot(), identity };
    const malformedOutputs = [
      "not-json",
      JSON.stringify({ root: identity, directories: [], files: [] }),
      JSON.stringify({ root: identity, directories: { "nested\\escape": identity }, files: [] }),
      JSON.stringify({ root: identity, directories: {}, files: [null] }),
      JSON.stringify({
        root: identity,
        directories: {},
        files: [{ path: "/escape", metadata: identity }],
      }),
      JSON.stringify({
        root: identity,
        directories: {},
        files: [{ path: "config.json", metadata: null }],
      }),
      JSON.stringify({
        root: identity,
        directories: {},
        files: [{ path: "config.json", metadata: identity, content: 42 }],
      }),
    ];

    for (const output of malformedOutputs) {
      writePythonWrapper([`printf '%s\\n' ${shellQuote(output)}`]);
      expect(scanDescriptorSnapshot(root, new Set())).toBeNull();
    }
  });

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
        { root: identity, directories: {}, files: [] },
        [],
      ),
    ).toBe(true);
  });

  it("fails closed when sanitized output cannot be installed", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    const python = spawnSync(
      "python3",
      ["-I", "-c", "import os, sys; print(os.path.realpath(sys.executable))"],
      { encoding: "utf-8" },
    );
    expect(python.status, python.stderr).toBe(0);
    writePythonWrapper([
      'if [ "${4-}" = apply ]; then exit 1; fi',
      `exec ${shellQuote(python.stdout.trim())} "$@"`,
    ]);

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("aborts optional-artifact sanitization when inspection fails", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ token: "raw" }));
    writePythonWrapper(["exit 1"]);

    expect(() => sanitizeMigrationDirectory(root)).toThrow(
      /Failed to inspect migration artifacts safely/u,
    );
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
      const python = spawnSync(
        "python3",
        ["-I", "-c", "import os, sys; print(os.path.realpath(sys.executable))"],
        { encoding: "utf-8" },
      );
      expect(python.status, python.stderr).toBe(0);
      writePythonWrapper([
        `if [ "\${4-}" = scan-tree ]; then mv ${shellQuote(root)} ${shellQuote(movedRoot)}; fi`,
        `exec ${shellQuote(python.stdout.trim())} "$@"`,
      ]);

      expect(() => sanitizeMigrationDirectory(root)).toThrow(
        /Failed to inspect migration artifacts safely/u,
      );
      expect(readFileSync(path.join(movedRoot, "config.json"), "utf-8")).toContain("raw");
    },
  );
});
