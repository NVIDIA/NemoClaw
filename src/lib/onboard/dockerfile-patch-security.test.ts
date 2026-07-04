// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";
import { assertToolDisclosureDockerfileContract } from "./dockerfile-tool-disclosure-contract";

const tmpRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dockerfile patch security guards", () => {
  it("refuses to patch a staged Dockerfile symlink", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-link-test-"));
    tmpRoots.push(dir);
    const realDockerfile = path.join(dir, "real.Dockerfile");
    const linkDockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(realDockerfile, "ARG NEMOCLAW_MODEL=old\n", "utf-8");
    fs.symlinkSync(realDockerfile, linkDockerfile);

    expect(() =>
      patchStagedDockerfile(linkDockerfile, "custom-model", "https://chat.example"),
    ).toThrow(/Refusing to patch Dockerfile through a symlink/);
  });

  it("refuses to patch a non-regular staged Dockerfile path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-dir-test-"));
    tmpRoots.push(dir);
    const dockerfileDir = path.join(dir, "Dockerfile");
    fs.mkdirSync(dockerfileDir);

    expect(() =>
      patchStagedDockerfile(dockerfileDir, "custom-model", "https://chat.example"),
    ).toThrow(/Refusing to patch non-regular Dockerfile path/);
  });

  it("refuses a staged Dockerfile symlink swapped in before write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-swap-test-"));
    tmpRoots.push(dir);
    const dockerfilePath = path.join(dir, "Dockerfile");
    const swappedTarget = path.join(dir, "swapped.Dockerfile");
    fs.writeFileSync(dockerfilePath, "ARG NEMOCLAW_MODEL=old\n", "utf-8");
    fs.writeFileSync(swappedTarget, "ARG NEMOCLAW_MODEL=swapped\n", "utf-8");

    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((file, options) => {
      const content = readFileSync(file as Parameters<typeof fs.readFileSync>[0], options as never);
      fs.unlinkSync(dockerfilePath);
      fs.symlinkSync(swappedTarget, dockerfilePath);
      return content;
    });

    expect(() =>
      patchStagedDockerfile(dockerfilePath, "custom-model", "https://chat.example"),
    ).toThrow(/Refusing to patch Dockerfile because it changed during validation/);
    expect(fs.readFileSync(swappedTarget, "utf-8")).toBe("ARG NEMOCLAW_MODEL=swapped\n");
  });

  it("refuses an initially hard-linked staged Dockerfile without modifying its external alias", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-hardlink-test-"));
    tmpRoots.push(dir);
    const externalPath = path.join(dir, "external.Dockerfile");
    const dockerfilePath = path.join(dir, "Dockerfile");
    const original = "ARG NEMOCLAW_MODEL=external\n";
    fs.writeFileSync(externalPath, original, "utf-8");
    fs.linkSync(externalPath, dockerfilePath);

    expect(() =>
      patchStagedDockerfile(dockerfilePath, "custom-model", "https://chat.example"),
    ).toThrow(/Refusing to patch hard-linked Dockerfile path/);
    expect(fs.readFileSync(externalPath, "utf-8")).toBe(original);
  });

  it("refuses an external hardlink swapped in between read and replacement", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-hardlink-swap-test-"));
    tmpRoots.push(dir);
    const dockerfilePath = path.join(dir, "Dockerfile");
    const externalPath = path.join(dir, "external.Dockerfile");
    const externalAlias = path.join(dir, "external-alias.Dockerfile");
    const external = "ARG NEMOCLAW_MODEL=external\n";
    fs.writeFileSync(dockerfilePath, "ARG NEMOCLAW_MODEL=old\n", "utf-8");
    fs.writeFileSync(externalPath, external, "utf-8");
    fs.linkSync(externalPath, externalAlias);

    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((file, options) => {
      const content = readFileSync(file as Parameters<typeof fs.readFileSync>[0], options as never);
      fs.unlinkSync(dockerfilePath);
      fs.linkSync(externalPath, dockerfilePath);
      return content;
    });

    expect(() =>
      patchStagedDockerfile(dockerfilePath, "custom-model", "https://chat.example"),
    ).toThrow(/Refusing to patch Dockerfile because it changed during validation/);
    expect(fs.readFileSync(externalPath, "utf-8")).toBe(external);
    expect(fs.readFileSync(externalAlias, "utf-8")).toBe(external);
  });

  it("refuses a Dockerfile reached through a stable symlinked staging parent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-parent-link-test-"));
    tmpRoots.push(dir);
    const realParent = path.join(dir, "real-parent");
    const linkedParent = path.join(dir, "linked-parent");
    fs.mkdirSync(realParent);
    const realDockerfile = path.join(realParent, "Dockerfile");
    const original = "ARG NEMOCLAW_MODEL=outside\n";
    fs.writeFileSync(realDockerfile, original, "utf-8");
    fs.symlinkSync(realParent, linkedParent, "dir");

    expect(() =>
      patchStagedDockerfile(
        path.join(linkedParent, "Dockerfile"),
        "custom-model",
        "https://chat.example",
      ),
    ).toThrow(/Refusing to patch Dockerfile through a symlinked parent/);
    expect(fs.readFileSync(realDockerfile, "utf-8")).toBe(original);
  });

  it("refuses a non-regular staged Dockerfile swapped in before write without truncating", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-dir-swap-test-"));
    tmpRoots.push(dir);
    const dockerfilePath = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "ARG NEMOCLAW_MODEL=old\n", "utf-8");

    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((file, options) => {
      const content = readFileSync(file as Parameters<typeof fs.readFileSync>[0], options as never);
      fs.unlinkSync(dockerfilePath);
      fs.mkdirSync(dockerfilePath);
      return content;
    });
    const truncateSpy = vi.spyOn(fs, "ftruncateSync");

    expect(() =>
      patchStagedDockerfile(dockerfilePath, "custom-model", "https://chat.example"),
    ).toThrow();
    expect(truncateSpy).not.toHaveBeenCalled();
    expect(fs.statSync(dockerfilePath).isDirectory()).toBe(true);
  });

  it("uses read-only wording when contract validation rejects a Dockerfile symlink", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-contract-link-test-"));
    tmpRoots.push(dir);
    const realDockerfile = path.join(dir, "real.Dockerfile");
    const linkDockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(realDockerfile, "FROM scratch\n", "utf-8");
    fs.symlinkSync(realDockerfile, linkDockerfile);

    expect(() => assertToolDisclosureDockerfileContract(linkDockerfile, "progressive")).toThrow(
      /Refusing to open Dockerfile through a symlink/,
    );
  });

  it.skipIf(process.platform === "win32" || typeof fs.constants.O_NONBLOCK !== "number")(
    "rejects a Dockerfile FIFO without blocking during validation",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-fifo-test-"));
      tmpRoots.push(dir);
      const fifo = path.join(dir, "Dockerfile");
      execFileSync("mkfifo", [fifo]);

      expect(() => assertToolDisclosureDockerfileContract(fifo, "progressive")).toThrow(
        /Custom Dockerfile path is not a file/,
      );
    },
  );

  it("rejects an ancestor directory swap around the Dockerfile open", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-parent-swap-test-"));
    tmpRoots.push(dir);
    const trustedDir = path.join(dir, "trusted");
    const movedTrustedDir = path.join(dir, "trusted-moved");
    const redirectedDir = path.join(dir, "redirected");
    fs.mkdirSync(trustedDir);
    fs.mkdirSync(redirectedDir);
    const validContract = [
      "FROM scratch",
      "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
      "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(trustedDir, "Dockerfile"), validContract, "utf-8");
    fs.writeFileSync(path.join(redirectedDir, "Dockerfile"), validContract, "utf-8");

    const openSync = fs.openSync.bind(fs);
    let swappedParent = false;
    const openThroughSwappedParent = (...args: Parameters<typeof fs.openSync>) => {
      fs.renameSync(trustedDir, movedTrustedDir);
      fs.renameSync(redirectedDir, trustedDir);
      try {
        const fd = openSync(...args);
        swappedParent = true;
        return fd;
      } finally {
        fs.renameSync(trustedDir, redirectedDir);
        fs.renameSync(movedTrustedDir, trustedDir);
      }
    };
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      return swappedParent || path.basename(String(args[0])) !== "Dockerfile"
        ? openSync(...args)
        : openThroughSwappedParent(...args);
    }) as typeof fs.openSync);

    expect(() =>
      assertToolDisclosureDockerfileContract(path.join(trustedDir, "Dockerfile"), "progressive"),
    ).toThrow(/Dockerfile because it changed during validation/);
    expect(swappedParent).toBe(true);
  });
});
