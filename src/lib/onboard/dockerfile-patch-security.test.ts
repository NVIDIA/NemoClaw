// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "../../../dist/lib/onboard/dockerfile-patch";

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
    ).toThrow(/Refusing to patch Dockerfile through a symlink/);
    expect(fs.readFileSync(swappedTarget, "utf-8")).toBe("ARG NEMOCLAW_MODEL=swapped\n");
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
});
