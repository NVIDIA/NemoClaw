// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  closeSync,
  fstatSync,
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
  resolveTrustedSnapshotSanitizerPythonPath,
  SnapshotSanitizerPrerequisiteError,
  type SnapshotFileIdentity,
  scanDescriptorSnapshot,
  setSnapshotSanitizerPythonPathForTest,
} from "../shared/snapshot-sanitizer-boundary.cjs";
import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const roots: string[] = [];

const LARGE_INSTALL_CONTENT = "x".repeat(15 * 1024 * 1024);

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
  setSnapshotSanitizerPythonPathForTest(wrapper);
  return wrapper;
}

function requireTrustedPython(): string {
  const python = resolveTrustedSnapshotSanitizerPythonPath();
  expect(python).toEqual(expect.any(String));
  return python as string;
}

function writeInstallMutationPythonWrapper(
  python: string,
  targetPath: string,
  aliasPath: string,
  transient: boolean,
): void {
  const hook = [
    "import os as _nemoclaw_os",
    "_nemoclaw_original_write = _nemoclaw_os.write",
    "_nemoclaw_linked = False",
    "def _nemoclaw_write(fd, payload):",
    "    global _nemoclaw_linked",
    "    written = _nemoclaw_original_write(fd, payload)",
    "    if not _nemoclaw_linked:",
    `        _nemoclaw_os.link(${JSON.stringify(targetPath)}, ${JSON.stringify(aliasPath)})`,
    ...(transient
      ? [
          `        alias_fd = _nemoclaw_os.open(${JSON.stringify(aliasPath)}, _nemoclaw_os.O_WRONLY)`,
          '        _nemoclaw_os.pwrite(alias_fd, b"M", 0)',
          "        _nemoclaw_os.close(alias_fd)",
          `        _nemoclaw_os.unlink(${JSON.stringify(aliasPath)})`,
        ]
      : []),
    "        _nemoclaw_linked = True",
    "    return written",
    "_nemoclaw_os.write = _nemoclaw_write",
  ].join("\n");
  const mediator = [
    "import os, sys",
    `hook = ${JSON.stringify(hook)}`,
    "args = sys.argv[2:]",
    'args[2] = hook + "\\n" + args[2]',
    "os.execv(sys.argv[1], [sys.argv[1], *args])",
  ].join("\n");
  writePythonWrapper([
    `exec ${shellQuote(python)} -c ${shellQuote(mediator)} ${shellQuote(python)} "$@"`,
  ]);
}

afterEach(() => {
  setSnapshotSanitizerPythonPathForTest(undefined);
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
    { label: "non-JSON output", output: "not-json" },
    {
      label: "array directories",
      output: JSON.stringify({ root: identity, directories: [], files: [] }),
    },
    {
      label: "escaping directory path",
      output: JSON.stringify({
        root: identity,
        directories: { "nested\\escape": identity },
        files: [],
      }),
    },
    {
      label: "null file",
      output: JSON.stringify({ root: identity, directories: {}, files: [null] }),
    },
    {
      label: "absolute file path",
      output: JSON.stringify({
        root: identity,
        directories: {},
        files: [{ path: "/escape", metadata: identity }],
      }),
    },
    {
      label: "null file metadata",
      output: JSON.stringify({
        root: identity,
        directories: {},
        files: [{ path: "config.json", metadata: null }],
      }),
    },
    {
      label: "non-string file content",
      output: JSON.stringify({
        root: identity,
        directories: {},
        files: [{ path: "config.json", metadata: identity, content: 42 }],
      }),
    },
  ];

  it("reports when the descriptor helper has no trusted interpreter (#8202)", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    setSnapshotSanitizerPythonPathForTest(null);

    expect(() => sanitizeOpenClawConfigFile(configPath)).toThrow(
      SnapshotSanitizerPrerequisiteError,
    );
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("reports the validated root when the apply helper has no trusted interpreter (#8202)", () => {
    const root = { canonicalPath: makeRoot(), identity };
    setSnapshotSanitizerPythonPathForTest(null);

    expect(() =>
      applyDescriptorSnapshotActions(root, { root: identity, directories: {}, files: [] }, [
        { kind: "remove", path: "config.json", metadata: identity },
      ]),
    ).toThrow(expect.objectContaining({ snapshotPath: root.canonicalPath }));
  });

  it("fails closed when the descriptor install helper is unavailable", () => {
    const root = inspectDescriptorSnapshotRoot(makeRoot());
    expect(root).not.toBeNull();
    setSnapshotSanitizerPythonPathForTest(null);

    expect(
      installDescriptorSnapshotFile(root as NonNullable<typeof root>, "openclaw.json", "{}"),
    ).toBe(false);
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
        const python = requireTrustedPython();
        writePythonWrapper([
          `if [ "\${4-}" = install ]; then ln -s ${shellQuote(outsideConfig)} ${shellQuote(
            path.join(rootPath, "openclaw.json"),
          )}; fi`,
          `exec ${shellQuote(python)} "$@"`,
        ]);

        expect(
          installDescriptorSnapshotFile(
            root as NonNullable<typeof root>,
            "openclaw.json",
            JSON.stringify({ installed: true }),
          ),
        ).toBe(false);
        expect(readFileSync(outsideConfigFd, "utf-8")).toBe(original);
        expect(fstatSync(outsideConfigFd).mode & 0o777).toBe(originalMode);
      } finally {
        closeSync(outsideConfigFd);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a persistent hard link created while sanitized config is installed",
    () => {
      const rootPath = makeRoot();
      const targetPath = path.join(rootPath, "openclaw.json");
      const aliasPath = path.join(rootPath, "openclaw-alias.json");
      const root = inspectDescriptorSnapshotRoot(rootPath);
      expect(root).not.toBeNull();
      const python = requireTrustedPython();
      writeInstallMutationPythonWrapper(python, targetPath, aliasPath, false);

      expect(
        installDescriptorSnapshotFile(
          root as NonNullable<typeof root>,
          "openclaw.json",
          LARGE_INSTALL_CONTENT,
        ),
      ).toBe(false);
      expect(() => statSync(targetPath)).toThrow();
      expect(statSync(aliasPath).isFile()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a transient hard-link mutation while sanitized config is installed",
    () => {
      const rootPath = makeRoot();
      const targetPath = path.join(rootPath, "openclaw.json");
      const aliasPath = path.join(rootPath, "openclaw-alias.json");
      const root = inspectDescriptorSnapshotRoot(rootPath);
      expect(root).not.toBeNull();
      const python = requireTrustedPython();
      writeInstallMutationPythonWrapper(python, targetPath, aliasPath, true);

      expect(
        installDescriptorSnapshotFile(
          root as NonNullable<typeof root>,
          "openclaw.json",
          LARGE_INSTALL_CONTENT,
        ),
      ).toBe(false);
      expect(() => statSync(targetPath)).toThrow();
      expect(() => statSync(aliasPath)).toThrow();
    },
  );

  it("accepts only absolute helper substitutions under Vitest", () => {
    expect(() => setSnapshotSanitizerPythonPathForTest("python3")).toThrow(
      /test Python path must be absolute/u,
    );

    const originalVitest = process.env.VITEST;
    try {
      process.env.VITEST = "false";
      expect(() => setSnapshotSanitizerPythonPathForTest(null)).toThrow(
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
      const wrapper = path.join(attackerRoot, "python3");
      writeFileSync(configPath, JSON.stringify({ apiKey: "sk-secret-value" }));
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          'if [ "${4-}" = scan-file ]; then',
          `  cp "$5/$7" ${shellQuote(stolen)}`,
          "fi",
          "exit 1",
        ].join("\n"),
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
    writePythonWrapper(["printf '%s\\n' '{}'", "exit 0"]);

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it.each(malformedDescriptorOutputs)(
    "rejects a malformed descriptor with $label",
    ({ output }) => {
      const root = { canonicalPath: makeRoot(), identity };
      writePythonWrapper([`printf '%s\\n' ${shellQuote(output)}`]);
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
        { root: identity, directories: {}, files: [] },
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

      expect(
        applyDescriptorSnapshotActions(root, scan, [
          { kind: "replace", path: config.path, metadata: config.metadata, content },
        ]),
      ).toBe(false);
      expect(readFileSync(configPath, "utf-8")).toBe("original");
    },
  );

  it("fails closed when sanitized output cannot be installed", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    const original = JSON.stringify({ apiKey: "sk-secret-value" });
    writeFileSync(configPath, original);
    const python = requireTrustedPython();
    writePythonWrapper([
      'if [ "${4-}" = apply ]; then exit 1; fi',
      `exec ${shellQuote(python)} "$@"`,
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
      const python = requireTrustedPython();
      writePythonWrapper([
        `if [ "\${4-}" = scan-tree ]; then mv ${shellQuote(root)} ${shellQuote(movedRoot)}; fi`,
        `exec ${shellQuote(python)} "$@"`,
      ]);

      expect(() => sanitizeMigrationDirectory(root)).toThrow(
        /Failed to inspect migration artifacts safely/u,
      );
      expect(readFileSync(path.join(movedRoot, "config.json"), "utf-8")).toContain("raw");
    },
  );
});
