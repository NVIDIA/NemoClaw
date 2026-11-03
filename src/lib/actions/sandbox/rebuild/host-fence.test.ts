// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";

import { expect, test } from "../../../../../test/helpers/owned-test-resources";
import {
  isCurrentPortableHostFenceHeld,
  portableHostFencePath,
} from "../../../state/portable-uninstall-retirement";
import { ProcessBoundLockContentionError } from "../../../state/registry/lock";
import { withRebuildHostFence } from "./owning-registry";

afterEach(() => vi.restoreAllMocks());

test("holds and releases the host fence around admitted rebuild work", async ({ testHome }) => {
  await withRebuildHostFence(
    testHome.home,
    async () => {
      expect(isCurrentPortableHostFenceHeld(testHome.home)).toBe(true);
    },
    { throwOnError: true },
  );
  expect(isCurrentPortableHostFenceHeld(testHome.home)).toBe(false);
  expect(fs.readdirSync(testHome.home)).not.toContain(".nemoclaw-portable-host.lock");
});

test("preserves contention errors after rebuild work starts", async ({ testHome }) => {
  const error = new ProcessBoundLockContentionError("later-lock", 1);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    withRebuildHostFence(
      testHome.home,
      async () => {
        throw error;
      },
      { throwOnError: true },
    ),
  ).rejects.toBe(error);
  expect(stderr).not.toHaveBeenCalled();
  expect(fs.readdirSync(testHome.home)).not.toContain(".nemoclaw-portable-host.lock");
});

test("reclaims a verified stale fence before admitting rebuild work", async ({ testHome }) => {
  const lock = portableHostFencePath(testHome.home);
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner"), "2147483647", { mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, stale, stale);
  const operation = vi.fn(async () => {});
  await withRebuildHostFence(testHome.home, operation, { throwOnError: true });
  expect(operation).toHaveBeenCalledOnce();
  expect(fs.readdirSync(testHome.home)).not.toContain(".nemoclaw-portable-host.lock");
});

test("frames an unverified lock without claiming a live owner", async ({ testHome }) => {
  const lock = portableHostFencePath(testHome.home);
  fs.mkdirSync(lock, { mode: 0o700 });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const operation = vi.fn(async () => {});
  await expect(
    withRebuildHostFence(testHome.home, operation, { throwOnError: true }),
  ).rejects.toThrow("Could not acquire the host lifecycle lock before rebuild.");
  const output = stderr.mock.calls.flat().join("\n");
  expect(output).toContain("no verifiable owner");
  expect(output).not.toContain("is still running");
  expect(operation).not.toHaveBeenCalled();
  expect(fs.readdirSync(lock)).toEqual([]);
});

test("propagates host-lock filesystem errors before starting rebuild", async ({ testHome }) => {
  const homeFile = path.join(testHome.home, "not-a-directory");
  fs.writeFileSync(homeFile, "preserved");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const operation = vi.fn(async () => {});
  await expect(
    withRebuildHostFence(homeFile, operation, { throwOnError: true }),
  ).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(stderr).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
  expect(fs.readFileSync(homeFile, "utf8")).toBe("preserved");
});
