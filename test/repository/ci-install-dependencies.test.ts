// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const installer = join(import.meta.dirname, "../../.github/actions/ci-install-dependencies.sh");
const compositeActionPath = join(import.meta.dirname, "../../.github/actions/ci-build-typecheck");

function makeFixture(): { root: string; trace: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-ci-install-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const trace = join(root, "npm.trace");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh\nprintf '%s\n' "$*" >> "$NPM_TRACE"\n`);
  chmodSync(npm, 0o755);
  mkdirSync(join(root, "nemoclaw"));
  const lock = JSON.stringify({
    lockfileVersion: 3,
    name: "fixture",
    packages: { "": { name: "fixture", version: "1.0.0" } },
    requires: true,
    version: "1.0.0",
  });
  writeFileSync(join(root, "package-lock.json"), `${lock}\n`);
  writeFileSync(join(root, "nemoclaw", "package-lock.json"), `${lock}\n`);
  return { root, trace, path: `${bin}:${process.env.PATH || ""}` };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("shared CI dependency installer", () => {
  it("installs from a composite-action path without lifecycle scripts", () => {
    const fixture = makeFixture();

    const result = spawnSync("bash", [installer], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: compositeActionPath,
        GITHUB_EVENT_NAME: "pull_request",
        NPM_CONFIG_CACHE: join(fixture.root, "npm-cache"),
        NPM_TRACE: fixture.trace,
        PATH: fixture.path,
        RUNNER_TEMP: join(fixture.root, "runner-temp"),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.trace, "utf8").trim().split("\n")).toEqual([
      `ci --ignore-scripts --prefer-offline --cache ${join(fixture.root, "npm-cache")}`,
      `--prefix nemoclaw ci --ignore-scripts --prefer-offline --cache ${join(fixture.root, "npm-cache")}`,
    ]);
  });

  it("rejects candidate npm configuration before npm receives the package token", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.root, "nemoclaw", ".npmrc"),
      "@nvidia:registry=https://example.invalid\n",
    );

    const result = spawnSync("bash", [installer], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: "credential-sentinel",
        NPM_TRACE: fixture.trace,
        PATH: fixture.path,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Candidate repository npm configuration is not allowed during trusted dependency installation.\n",
    );
    expect(result.stderr).not.toContain("credential-sentinel");
    expect(existsSync(fixture.trace)).toBe(false);
  });

  it("rejects a package credential in pull request jobs before npm runs", () => {
    const fixture = makeFixture();
    const result = spawnSync("bash", [installer], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        NODE_AUTH_TOKEN: "credential-sentinel",
        NPM_TRACE: fixture.trace,
        PATH: fixture.path,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Pull request dependency installation must not receive a package credential.\n",
    );
    expect(result.stderr).not.toContain("credential-sentinel");
    expect(existsSync(fixture.trace)).toBe(false);
  });

  it.each(["npm-shrinkwrap.json", "nemoclaw/npm-shrinkwrap.json"])(
    "rejects candidate %s before npm runs",
    (relativePath) => {
      const fixture = makeFixture();
      writeFileSync(join(fixture.root, relativePath), "{}\n");

      const result = spawnSync("bash", [installer], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          NODE_AUTH_TOKEN: "credential-sentinel",
          NPM_TRACE: fixture.trace,
          PATH: fixture.path,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        "Candidate npm shrinkwrap files are not allowed during trusted dependency installation.\n",
      );
      expect(existsSync(fixture.trace)).toBe(false);
    },
  );

  it.each(["package-lock.json", "nemoclaw/package-lock.json"])(
    "rejects an unreviewed dev package in %s before npm runs",
    (relativePath) => {
      const fixture = makeFixture();
      const lock = {
        lockfileVersion: 3,
        name: "fixture",
        packages: {
          "": {
            devDependencies: { "unreviewed-package": "1.0.0" },
            name: "fixture",
            version: "1.0.0",
          },
          "node_modules/unreviewed-package": {
            dev: true,
            integrity: "sha512-dGVzdA==",
            resolved: "https://packages.example.invalid/unreviewed-package.tgz",
            version: "1.0.0",
          },
        },
        requires: true,
        version: "1.0.0",
      };
      writeFileSync(join(fixture.root, relativePath), `${JSON.stringify(lock)}\n`);

      const result = spawnSync("bash", [installer], {
        cwd: fixture.root,
        encoding: "utf8",
        env: { ...process.env, NPM_TRACE: fixture.trace, PATH: fixture.path },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must use the reviewed registry");
      expect(result.stderr).not.toContain("credential-sentinel");
      expect(existsSync(fixture.trace)).toBe(false);
    },
  );
});
