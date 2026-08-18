// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveTrustedSnapshotSanitizerPythonPath,
  setSnapshotSanitizerPythonPathForTest,
  SnapshotSanitizerPrerequisiteError,
} from "../../../nemoclaw/dist/shared/snapshot-sanitizer-boundary.cjs";
import { sanitizeBackupDirectory } from "./sandbox.js";

const testDirectories: string[] = [];

function createBackup(): string {
  const backupPath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-backup-"));
  testDirectories.push(backupPath);
  mkdirSync(join(backupPath, "state"), { recursive: true });
  return backupPath;
}

afterEach(() => {
  setSnapshotSanitizerPythonPathForTest(undefined);
  vi.unstubAllEnvs();
  for (const testDirectory of testDirectories.splice(0)) {
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

describe("rebuild backup credential sanitization", () => {
  it("sanitizes a real env file and restricts its mode", () => {
    const backupPath = createBackup();
    const envPath = join(backupPath, "state", ".env");
    writeFileSync(envPath, "CUSTOM=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nLOG_LEVEL=info\n", {
      mode: 0o644,
    });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(envPath, "utf-8")).toBe("CUSTOM=[STRIPPED_BY_MIGRATION]\nLOG_LEVEL=info\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("restricts an already-safe config artifact without changing its content", () => {
    const backupPath = createBackup();
    const envPath = join(backupPath, "state", ".env");
    const contents = "LOG_LEVEL=info\n";
    writeFileSync(envPath, contents, { mode: 0o644 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(envPath, "utf-8")).toBe(contents);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  // The Hermes WhatsApp bridge ships under a `state_dirs` entry, so its
  // manifest and installed tree reach this sanitizer on every rebuild. The
  // bridge re-runs `npm install` when the manifest hash stops matching its
  // recorded stamp. Any byte change here triggers a reinstall from the lockfile,
  // and the same sanitization pass can have rewritten that lockfile.
  // source-shape-contract: security -- The credential scan must return a document it did not redact with its bytes intact, because a consumer hashes those exact bytes to decide whether its inputs changed.
  it("returns a credential-free JSON manifest byte for byte", () => {
    const backupPath = createBackup();
    const manifestPath = join(backupPath, "state", "package.json");
    // Four-space indent and a trailing newline: neither survives a re-emit
    // through JSON.stringify, so a reformat is visible as a content change.
    const contents = `{\n    "name": "whatsapp-bridge",\n    "dependencies": {\n        "express": "^4.21.2"\n    }\n}\n`;
    writeFileSync(manifestPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(manifestPath, "utf-8")).toBe(contents);
  });

  it("leaves a dependency lockfile untouched", () => {
    const backupPath = createBackup();
    const bridgeDirectory = join(backupPath, "state", "scripts", "whatsapp-bridge");
    mkdirSync(bridgeDirectory, { recursive: true });
    const lockPath = join(bridgeDirectory, "package-lock.json");
    // A resolved dependency map keys on the bare package name, so `cookie`
    // reaches the credential key matcher and its version becomes the
    // `[STRIPPED_BY_MIGRATION]` marker. `npm install` then fails with
    // EINVALIDTAGNAME.
    const contents = `{\n  "name": "whatsapp-bridge",\n  "packages": {\n    "node_modules/express": {\n      "version": "4.21.2",\n      "dependencies": {\n        "cookie": "0.7.1"\n      }\n    }\n  }\n}\n`;
    writeFileSync(lockPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(lockPath, "utf-8")).toBe(contents);
  });

  it("leaves an installed npm lockfile byte for byte when it contains no credentials", () => {
    const backupPath = createBackup();
    const modulesDirectory = join(backupPath, "state", "node_modules");
    mkdirSync(modulesDirectory, { recursive: true });
    const lockPath = join(modulesDirectory, ".package-lock.json");
    const contents = `{\n    "lockfileVersion": 3,\n    "packages": {\n        "node_modules/cookie": {\n            "version": "0.7.1",\n            "resolved": "https://registry.example.test/sk-example-dependency-with-a-long-name-0.7.1.tgz"\n        }\n    }\n}\n`;
    writeFileSync(lockPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(lockPath, "utf-8")).toBe(contents);
  });

  it.each([
    ["credential field", '{"lockfileVersion":3,"token":"opaque-runtime-secret"}'],
    [
      "credential-bearing URL",
      '{"lockfileVersion":3,"resolved":"https://registry.example.test/pkg.tgz?token=opaque"}',
    ],
    [
      "URL user information",
      '{"lockfileVersion":3,"resolved":"https://build-user:build-password@registry.example.test/pkg.tgz"}',
    ],
  ])("removes a recognized lockfile containing %s", (_label, contents) => {
    const backupPath = createBackup();
    const lockPath = join(backupPath, "state", "package-lock.json");
    writeFileSync(lockPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes a recognized lockfile that cannot be inspected", () => {
    const backupPath = createBackup();
    const lockPath = join(backupPath, "state", "package-lock.json");
    writeFileSync(lockPath, '{"token":"123456789"', { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes a JSON lockfile with syntax that YAML would accept", () => {
    const backupPath = createBackup();
    const lockPath = join(backupPath, "state", "package-lock.json");
    writeFileSync(lockPath, '{"lockfileVersion":3,}', { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("preserves a credential-free YAML lockfile byte for byte", () => {
    const backupPath = createBackup();
    const lockPath = join(backupPath, "state", "pnpm-lock.yaml");
    const contents = "lockfileVersion: '9.0'\npackages:\n  cookie@0.7.1:\n    resolution: {}\n";
    writeFileSync(lockPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(lockPath, "utf-8")).toBe(contents);
  });

  // source-shape-contract: security -- Package names inside an installed manifest are the exact bytes the credential key matcher would rewrite, so only the unmodified content proves the dependency-tree exclusion holds.
  it("leaves an installed package manifest that names a credential-shaped dependency", () => {
    const backupPath = createBackup();
    const vendoredDirectory = join(backupPath, "state", "scripts", "node_modules", "express");
    mkdirSync(vendoredDirectory, { recursive: true });
    const manifestPath = join(vendoredDirectory, "package.json");
    // `cookie` and `path-key` are package names here, but they match the
    // credential key matcher, so without the dependency-tree exclusion their
    // versions become the `[STRIPPED_BY_MIGRATION]` marker and `npm install`
    // fails.
    const contents = `{"name":"express","dependencies":{"cookie":"0.7.1","path-key":"3.1.1","token":"1.0.0"}}`;
    writeFileSync(manifestPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(manifestPath, "utf-8")).toBe(contents);
  });

  it.each([
    ["credential field", '{"name":"unsafe-package","token":"opaque-runtime-secret"}'],
    ["npm authentication field", '{"name":"unsafe-package","_auth":"opaque-runtime-secret"}'],
    [
      "credential-bearing URL",
      '{"name":"unsafe-package","repository":"https://build-user:build-password@example.test/pkg.git"}',
    ],
    [
      "provider-shaped secret",
      '{"name":"unsafe-package","metadata":"sk-abcdefghijklmnopqrstuvwxyz0123456789"}',
    ],
  ])("removes an installed package manifest containing %s", (_label, contents) => {
    const backupPath = createBackup();
    const vendoredDirectory = join(backupPath, "state", "node_modules", "unsafe-package");
    mkdirSync(vendoredDirectory, { recursive: true });
    const manifestPath = join(vendoredDirectory, "package.json");
    writeFileSync(manifestPath, contents, { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(manifestPath)).toBe(false);
  });

  it("removes an installed package manifest that cannot be inspected as JSON", () => {
    const backupPath = createBackup();
    const vendoredDirectory = join(backupPath, "state", "node_modules", "invalid-package");
    mkdirSync(vendoredDirectory, { recursive: true });
    const manifestPath = join(vendoredDirectory, "package.json");
    writeFileSync(manifestPath, '{"name":"invalid-package"', { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(manifestPath)).toBe(false);
  });

  it("still strips a credential header from an agent configuration", () => {
    const backupPath = createBackup();
    const configPath = join(backupPath, "state", "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { remote: { headers: { Cookie: "session=abc123" } } } }),
      { mode: 0o600 },
    );

    sanitizeBackupDirectory(backupPath);

    const sanitized = readFileSync(configPath, "utf-8");
    expect(sanitized).not.toContain("session=abc123");
    expect(sanitized).toContain("[STRIPPED_BY_MIGRATION]");
  });

  it("still removes a credential file inside a dependency tree", () => {
    const backupPath = createBackup();
    const vendoredDirectory = join(backupPath, "state", "scripts", "node_modules", "some-package");
    mkdirSync(vendoredDirectory, { recursive: true });
    const authPath = join(vendoredDirectory, "auth.json");
    writeFileSync(authPath, '{"token":"sk-abcdefghijklmnopqrstuvwxyz0123456789"}', { mode: 0o600 });

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(authPath)).toBe(false);
  });

  it("still sanitizes a credential config inside a dependency tree", () => {
    const backupPath = createBackup();
    const vendoredDirectory = join(backupPath, "state", "scripts", "node_modules", "some-package");
    mkdirSync(vendoredDirectory, { recursive: true });
    const configPath = join(vendoredDirectory, "config.json");
    writeFileSync(configPath, '{"apiKey":"sk-abcdefghijklmnopqrstuvwxyz0123456789"}', {
      mode: 0o644,
    });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(configPath, "utf-8")).toContain("[STRIPPED_BY_MIGRATION]");
    expect(readFileSync(configPath, "utf-8")).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("still sanitizes an environment file inside a dependency tree", () => {
    const backupPath = createBackup();
    const vendoredDirectory = join(backupPath, "state", "scripts", "node_modules", "some-package");
    mkdirSync(vendoredDirectory, { recursive: true });
    const envPath = join(vendoredDirectory, ".env");
    writeFileSync(envPath, "TOKEN=opaque-runtime-secret\nLOG_LEVEL=info\n", { mode: 0o644 });

    sanitizeBackupDirectory(backupPath);

    expect(readFileSync(envPath, "utf-8")).toBe("TOKEN=[STRIPPED_BY_MIGRATION]\nLOG_LEVEL=info\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("omits unsanitizable config and env artifacts", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    const jsonPath = join(backupPath, "state", "config.json");
    const envPath = join(backupPath, "state", ".env");
    const safePath = join(backupPath, "state", "notes.txt");
    writeFileSync(yamlPath, "api_key: [unclosed\n");
    writeFileSync(jsonPath, '{"apiKey":');
    writeFileSync(envPath, Buffer.from([0xff]));
    writeFileSync(safePath, "safe");

    sanitizeBackupDirectory(backupPath);

    expect(existsSync(yamlPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(readFileSync(safePath, "utf-8")).toBe("safe");
  });

  it("removes and rejects the whole backup when an unsafe artifact cannot be deleted", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    writeFileSync(yamlPath, "api_key: [unclosed\n");

    expect(() =>
      sanitizeBackupDirectory(backupPath, {
        sanitizeDirectory: () => {
          throw new Error("injected unlink failure");
        },
      }),
    ).toThrow("Credential sanitization failed; removed the incomplete backup");
    expect(existsSync(backupPath)).toBe(false);
  });

  it("permits a rerun after removing a snapshot that the sanitizer could not inspect (#8202)", () => {
    const backupPath = createBackup();
    writeFileSync(join(backupPath, "state", "config.json"), '{"apiKey":"sk-secret-value"}');
    setSnapshotSanitizerPythonPathForTest(null);

    expect(() => sanitizeBackupDirectory(backupPath)).toThrow(
      "python3 is required for snapshot sanitization; install python3 and rerun. Credential sanitization failed; removed the incomplete backup",
    );
    expect(existsSync(backupPath)).toBe(false);
  });

  it("keeps a helper failure distinct from a missing interpreter (#8202)", () => {
    const backupPath = createBackup();
    writeFileSync(join(backupPath, "state", "config.json"), '{"apiKey":"sk-secret-value"}');
    const wrapperRoot = mkdtempSync(join(tmpdir(), "nemoclaw-failing-python-"));
    testDirectories.push(wrapperRoot);
    const pythonWrapper = join(wrapperRoot, "python3");
    writeFileSync(pythonWrapper, "#!/bin/sh\nexit 1\n");
    chmodSync(pythonWrapper, 0o755);
    setSnapshotSanitizerPythonPathForTest(pythonWrapper);

    expect(() => sanitizeBackupDirectory(backupPath)).toThrow(
      "Credential sanitization failed; removed the incomplete backup",
    );
    expect(existsSync(backupPath)).toBe(false);
  });

  it("reports the validated directory when backup cleanup throws (#8202)", () => {
    const backupPath = createBackup();
    const validatedPath = realpathSync(backupPath);
    writeFileSync(join(backupPath, "state", "config.json"), '{"apiKey":"sk-secret-value"}');
    setSnapshotSanitizerPythonPathForTest(null);

    const cleanupError = new Error("injected cleanup failure");
    let received: unknown;
    try {
      sanitizeBackupDirectory(backupPath, {
        removeBackup: () => {
          throw cleanupError;
        },
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe(
      `python3 is required for snapshot sanitization; install python3 and rerun. Credential sanitization failed and backup cleanup failed; the incomplete backup may remain at ${validatedPath}`,
    );
    expect((received as Error).cause).toBeInstanceOf(AggregateError);
    expect(((received as Error).cause as AggregateError).errors).toEqual([
      expect.any(SnapshotSanitizerPrerequisiteError),
      cleanupError,
    ]);
    expect(existsSync(backupPath)).toBe(true);
  });

  it("preserves a generic sanitization error when backup cleanup also fails (#8202)", () => {
    const backupPath = createBackup();
    const sanitizeError = new Error("injected sanitization failure");
    const cleanupError = new Error("injected cleanup failure");
    let received: unknown;

    try {
      sanitizeBackupDirectory(backupPath, {
        sanitizeDirectory: () => {
          throw sanitizeError;
        },
        removeBackup: () => {
          throw cleanupError;
        },
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe(
      "Credential sanitization failed and backup cleanup failed",
    );
    expect((received as Error).cause).toBeInstanceOf(AggregateError);
    expect(((received as Error).cause as AggregateError).errors).toEqual([
      sanitizeError,
      cleanupError,
    ]);
  });

  it("reports only the validated directory when failed cleanup retains a snapshot (#8202)", () => {
    const backupPath = createBackup();
    const validatedPath = realpathSync(backupPath);
    const unvalidatedPath = `${backupPath}/.`;
    writeFileSync(join(backupPath, "state", "config.json"), '{"apiKey":"sk-secret-value"}');
    setSnapshotSanitizerPythonPathForTest(null);
    const removeBackup = vi.fn();
    const backupExists = vi.fn(() => true);

    let thrown: unknown;
    try {
      sanitizeBackupDirectory(unvalidatedPath, {
        removeBackup,
        backupExists,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      `python3 is required for snapshot sanitization; install python3 and rerun. Credential sanitization failed and the incomplete backup remains at ${validatedPath}`,
    );
    expect((thrown as Error).message).not.toContain(unvalidatedPath);
    expect(removeBackup).toHaveBeenCalledWith(unvalidatedPath);
    expect(backupExists).toHaveBeenCalledWith(unvalidatedPath);
    expect(existsSync(backupPath)).toBe(true);
  });

  it("reports when cleanup leaves an incomplete backup behind", () => {
    const backupPath = createBackup();
    const yamlPath = join(backupPath, "state", "config.yaml");
    writeFileSync(yamlPath, "api_key: [unclosed\n");

    expect(() =>
      sanitizeBackupDirectory(backupPath, {
        sanitizeDirectory: () => {
          throw new Error("injected unlink failure");
        },
        removeBackup: () => undefined,
        backupExists: () => true,
      }),
    ).toThrow("Credential sanitization failed and the incomplete backup remains");
    expect(existsSync(backupPath)).toBe(true);
  });

  it("fails closed when a scanned parent directory is swapped before apply", () => {
    const backupPath = createBackup();
    const nestedPath = join(backupPath, "state", "nested");
    const movedPath = join(backupPath, "state", "nested-original");
    mkdirSync(nestedPath);
    writeFileSync(join(nestedPath, "config.json"), '{"apiKey":"sk-inside-secret"}');

    const outsidePath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-outside-"));
    const wrapperPath = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-python-"));
    testDirectories.push(outsidePath, wrapperPath);
    const outsideConfigPath = join(outsidePath, "config.json");
    const outsideContents = '{"apiKey":"sk-outside-secret"}';
    writeFileSync(outsideConfigPath, outsideContents);

    const realPython = resolveTrustedSnapshotSanitizerPythonPath();
    expect(realPython).toEqual(expect.any(String));
    const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
    const pythonWrapper = join(wrapperPath, "python3");
    writeFileSync(
      pythonWrapper,
      `#!/bin/sh\nif [ "$4" = "apply" ]; then\n  mv ${shellQuote(nestedPath)} ${shellQuote(movedPath)}\n  ln -s ${shellQuote(outsidePath)} ${shellQuote(nestedPath)}\nfi\nexec ${shellQuote(realPython as string)} "$@"\n`,
    );
    chmodSync(pythonWrapper, 0o755);
    setSnapshotSanitizerPythonPathForTest(pythonWrapper);

    expect(() => sanitizeBackupDirectory(backupPath)).toThrow(
      "Credential sanitization failed; removed the incomplete backup",
    );
    expect(existsSync(backupPath)).toBe(false);
    expect(readFileSync(outsideConfigPath, "utf-8")).toBe(outsideContents);
  });
});
