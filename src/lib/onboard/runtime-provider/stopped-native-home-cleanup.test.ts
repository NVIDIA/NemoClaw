// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildStoppedSandboxNativeHomeCleanupScript,
  clearStoppedNativeHomeWithEngine,
  sandboxNativeHomeResourceFromMounts,
} from "./stopped-sandbox-state-cleanup";

const CONTAINER_ID = "a".repeat(64);

describe("stopped native-home cleanup", () => {
  it("uses the stopped container when the native home is in its writable layer", () => {
    expect(
      sandboxNativeHomeResourceFromMounts(
        [
          {
            Type: "bind",
            Source: "/home/user/project",
            Destination: "/sandbox/project",
            RW: true,
          },
        ],
        "/sandbox",
        CONTAINER_ID,
      ),
    ).toEqual({ type: "container", source: CONTAINER_ID, target: "/sandbox" });
  });

  it("does not treat an unresolved containing mount as a writable-layer home", () => {
    expect(
      sandboxNativeHomeResourceFromMounts(
        [
          {
            Type: "bind",
            Source: "/",
            Destination: "/sandbox",
            RW: true,
          },
        ],
        "/sandbox",
        CONTAINER_ID,
      ),
    ).toBeNull();
  });

  it("authorizes exact stopped-container deletion without starting a cleanup helper", () => {
    const stateResource = {
      type: "container" as const,
      source: CONTAINER_ID,
      target: "/sandbox",
    };
    const observe = vi.fn(() => ({
      target: { resourceHandle: CONTAINER_ID, running: false, stateResource },
    }));
    const capture = vi.fn();

    expect(
      clearStoppedNativeHomeWithEngine("stopped-sandbox", "/sandbox", [], {
        capture,
        observe,
      }),
    ).toEqual({ cleared: true });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
  });

  it("refuses stopped-container deletion when its identity changes during revalidation", () => {
    const stateResource = {
      type: "container" as const,
      source: CONTAINER_ID,
      target: "/sandbox",
    };
    const observe = vi
      .fn()
      .mockReturnValueOnce({
        target: { resourceHandle: CONTAINER_ID, running: false, stateResource },
      })
      .mockReturnValueOnce({
        target: { resourceHandle: "b".repeat(64), running: false, stateResource },
      });

    expect(
      clearStoppedNativeHomeWithEngine("stopped-sandbox", "/sandbox", [], {
        capture: vi.fn(),
        observe,
      }),
    ).toEqual({ cleared: false, failure: "runtime-revalidation-failed" });
  });

  it("pulls the pinned cleanup image when a mounted stopped home needs it", () => {
    const stateResource = {
      type: "volume" as const,
      source: "openclaw-state",
      target: "/sandbox",
    };
    const observe = vi.fn(() => ({
      target: { resourceHandle: CONTAINER_ID, running: false, stateResource },
    }));
    let imageInspections = 0;
    const capture = vi.fn((args: readonly string[]) => {
      switch (args[0]) {
        case "image":
          imageInspections += 1;
          return imageInspections === 1
            ? { status: 1, stdout: "", stderr: "No such image" }
            : { status: 0, stdout: `sha256:${"c".repeat(64)}\n`, stderr: "" };
        case "pull":
        case "start":
        case "rm":
          return { status: 0, stdout: "", stderr: "" };
        case "inspect":
          return { status: 1, stdout: "", stderr: "No such container" };
        case "create":
          return { status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
        default:
          return { status: 125, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
      }
    });

    expect(
      clearStoppedNativeHomeWithEngine("stopped-sandbox", "/sandbox", [], {
        capture,
        observe,
      }),
    ).toEqual({ cleared: true });
    expect(capture).toHaveBeenCalledWith(
      ["pull", "--quiet", expect.stringContaining("node:24.18.1-trixie-slim")],
      120_000,
    );
  });

  it("removes complete native state while preserving exact user-managed paths", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-native-cleanup-"));
    try {
      const root = path.join(fixture, "sandbox");
      const preserved = path.join(root, ".deepagents", ".env");
      const removedSibling = path.join(root, ".deepagents", "cache", "state.json");
      const removedWorkspace = path.join(root, "workspace", "memory.txt");
      fs.mkdirSync(path.dirname(preserved), { recursive: true });
      fs.mkdirSync(path.dirname(removedSibling), { recursive: true });
      fs.mkdirSync(path.dirname(removedWorkspace), { recursive: true });
      fs.writeFileSync(preserved, "USER_MANAGED=1\n");
      fs.writeFileSync(removedSibling, "sandbox state\n");
      fs.writeFileSync(removedWorkspace, "sandbox state\n");

      const result = spawnSync(
        process.execPath,
        ["-e", buildStoppedSandboxNativeHomeCleanupScript(), root, JSON.stringify([preserved])],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(preserved, "utf8")).toBe("USER_MANAGED=1\n");
      expect(fs.existsSync(removedSibling)).toBe(false);
      expect(fs.existsSync(removedWorkspace)).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses a symlink in a protected path's ancestor chain", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-native-symlink-"));
    try {
      const root = path.join(fixture, "sandbox");
      const outside = path.join(fixture, "outside");
      const protectedPath = path.join(root, "project", "source");
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "keep.txt"), "outside\n");
      fs.symlinkSync(outside, path.join(root, "project"));

      const result = spawnSync(
        process.execPath,
        ["-e", buildStoppedSandboxNativeHomeCleanupScript(), root, JSON.stringify([protectedPath])],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(44);
      expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
