// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";
import { testTimeoutOptions } from "../helpers/timeouts";

const CURL_PIPE_INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");

describe("installer git checkout", testTimeoutOptions(15_000), () => {
  it("fetches fully-qualified refs into a detached checkout without group- or other-writable source entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-ref-"));
    const origin = path.join(tmp, "origin");
    fs.mkdirSync(origin);
    const git = (args: string[], cwd = origin) => spawnSync("git", args, { cwd, encoding: "utf8" });

    try {
      expect(git(["init", "--initial-branch=topic"]).status).toBe(0);
      expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
      expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "fixture\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]).status).toBe(0);
      const expectedHead = git(["rev-parse", "HEAD"]).stdout.trim();

      const cases = [INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER].flatMap((installer) =>
        ["0022", "0077", "0002"].map((callerUmask) => ({ callerUmask, installer })),
      );
      cases.forEach(({ callerUmask, installer }, index) => {
        const destination = path.join(tmp, `checkout-${index}`);
        const result = spawnSync(
          "bash",
          [
            "-c",
            'umask "$CALLER_UMASK"\nsource "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref refs/heads/topic "$DESTINATION"\nprintf "CALLER_UMASK=%s\\n" "$(umask)"',
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CALLER_UMASK: callerUmask,
              DESTINATION: destination,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/NVIDIA/NemoClaw.git",
              INSTALLER_UNDER_TEST: installer,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(git(["-C", destination, "rev-parse", "HEAD"], tmp).stdout.trim()).toBe(expectedHead);
        expect(git(["-C", destination, "symbolic-ref", "-q", "HEAD"], tmp).status).not.toBe(0);
        expect(result.stdout).toContain(`CALLER_UMASK=${callerUmask}`);
        expect([
          fs.lstatSync(destination).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git")).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git", "HEAD")).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git", "config")).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git", "objects")).mode & 0o22,
          fs.lstatSync(path.join(destination, "README.md")).mode & 0o22,
        ]).toEqual([0, 0, 0, 0, 0, 0]);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checks out a lightweight tag at its commit, not the branch tip (#7474)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-tag-"));
    const origin = path.join(tmp, "origin");
    fs.mkdirSync(origin);
    const git = (args: string[], cwd = origin) => spawnSync("git", args, { cwd, encoding: "utf8" });

    try {
      expect(git(["init", "--initial-branch=main"]).status).toBe(0);
      expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
      expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "tagged\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "tagged release"]).status).toBe(0);
      const taggedHead = git(["rev-parse", "HEAD"]).stdout.trim();
      expect(git(["-c", "tag.gpgSign=false", "tag", "v9.9.9"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "post-release\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "post release"]).status).toBe(0);
      expect(git(["rev-parse", "HEAD"]).stdout.trim()).not.toBe(taggedHead);

      [...[INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER].entries()].forEach(([index, installer]) => {
        const destination = path.join(tmp, `checkout-${index}`);
        const result = spawnSync(
          "bash",
          ["-c", 'source "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref v9.9.9 "$DESTINATION"'],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DESTINATION: destination,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/NVIDIA/NemoClaw.git",
              INSTALLER_UNDER_TEST: installer,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(git(["-C", destination, "rev-parse", "HEAD"], tmp).stdout.trim()).toBe(taggedHead);
        expect(git(["-C", destination, "symbolic-ref", "-q", "HEAD"], tmp).status).not.toBe(0);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("installer version stamping", testTimeoutOptions(15_000), () => {
  const extract = (stdout: string) => stdout.match(/START([\s\S]*?)STOP/)?.[1] ?? null;

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "stamps a requested version tag and defers mutable refs to describe [case %#] (#7474)",
    (installer) => {
      const stamp = (ref: string) => {
        const result = spawnSync(
          "bash",
          [
            "-c",
            'source "$INSTALLER_UNDER_TEST"\nprintf START\nresolve_stamped_version "$REF"\nprintf STOP',
          ],
          { encoding: "utf8", env: { ...process.env, INSTALLER_UNDER_TEST: installer, REF: ref } },
        );
        expect(result.status, result.stderr).toBe(0);
        return extract(result.stdout);
      };
      expect(stamp("v0.0.93")).toBe("0.0.93");
      expect(stamp("refs/tags/v1.2.3")).toBe("1.2.3");
      expect(stamp("lkg")).toBe("");
      expect(stamp("latest")).toBe("");
      expect(stamp("main")).toBe("");
    },
  );

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "reports the stamped .version over a mismatched git describe [case %#] (#7474)",
    (installer) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-version-"));
      const git = (args: string[]) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });

      try {
        fs.writeFileSync(
          path.join(tmp, "package.json"),
          `${JSON.stringify({ version: "0.0.1" })}\n`,
        );
        expect(git(["init", "--initial-branch=main"]).status).toBe(0);
        expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
        expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
        fs.writeFileSync(path.join(tmp, "README.md"), "release\n");
        expect(git(["add", "."]).status).toBe(0);
        expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "release"]).status).toBe(0);
        expect(
          git(["-c", "tag.gpgSign=false", "tag", "-a", "v0.0.38", "-m", "old release"]).status,
        ).toBe(0);

        const resolve = (installer: string) =>
          spawnSync(
            "bash",
            [
              "-c",
              'source "$INSTALLER_UNDER_TEST"\nprintf START\nresolve_installer_version\nprintf STOP',
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                INSTALLER_UNDER_TEST: installer,
                NEMOCLAW_REPO_ROOT: tmp,
                NEMOCLAW_INSTALL_REF: "",
                NEMOCLAW_INSTALL_TAG: "",
              },
            },
          );

        fs.writeFileSync(path.join(tmp, ".version"), "0.0.93");
        const withStamp = resolve(installer);
        expect(withStamp.status, withStamp.stderr).toBe(0);
        expect(extract(withStamp.stdout)).toBe("0.0.93");

        fs.rmSync(path.join(tmp, ".version"));
        const withoutStamp = resolve(installer);
        expect(withoutStamp.status, withoutStamp.stderr).toBe(0);
        expect(extract(withoutStamp.stdout)).toBe("0.0.38");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
