// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import {
  loadManagedLlamaCppOwner,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
  type ManagedLlamaCppOwner,
} from "./managed-state";

const UUID_ONE = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1";
const UUID_TWO = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee2";

const childSource = `
import state from ${JSON.stringify(new URL("./managed-state.ts", import.meta.url).href)};
const { bindLegacyManagedLlamaCppOwnerGpu, managedLlamaCppStatePaths } = state;
const [home, uuid, serializedOwner] = process.argv.slice(1);
process.stdout.write("ready\\n");
process.stdin.once("data", () => {
  try {
    const owner = bindLegacyManagedLlamaCppOwnerGpu(managedLlamaCppStatePaths(home), JSON.parse(serializedOwner), uuid);
    process.stdout.write("bound:" + owner.gpuDeviceUuid + "\\n");
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
  }
});
`;

function startUpgrade(home: string, uuid: string, owner: ManagedLlamaCppOwner) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      childSource,
      home,
      uuid,
      JSON.stringify(owner),
    ],
    { stdio: "pipe" },
  );
  const closed = once(child, "close");
  let output = "";
  let errors = "";
  child.stdout.on("data", (data: Buffer) => (output += data.toString()));
  child.stderr.on("data", (data: Buffer) => (errors += data.toString()));
  return {
    child,
    ready: once(child.stdout, "data"),
    closed,
    output: () => output,
    errors: () => errors,
  };
}

it("keeps one owner UUID when two processes upgrade the same legacy owner", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-owner-race-")));
  const paths = managedLlamaCppStatePaths(home);
  const owner: ManagedLlamaCppOwner = {
    schemaVersion: 1,
    sandboxName: "station-agent",
    catalogDigest: `sha256:${"a".repeat(64)}`,
    presetDigest: `sha256:${"b".repeat(64)}`,
    recipeDigest: `sha256:${"c".repeat(64)}`,
    recipeId: "llama-cpp.station-test.v1",
  };
  let firstChild: ChildProcessWithoutNullStreams | undefined;
  let secondChild: ChildProcessWithoutNullStreams | undefined;
  try {
    reserveManagedLlamaCppOwner(paths, owner);
    const first = startUpgrade(home, UUID_ONE, owner);
    const second = startUpgrade(home, UUID_TWO, owner);
    firstChild = first.child;
    secondChild = second.child;
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.end("go");
    second.child.stdin.end("go");
    const results = await Promise.all([first.closed, second.closed]);
    expect(
      results.map(([code]) => code),
      `${first.errors()} ${second.errors()}`,
    ).toEqual([0, 0]);
    const persisted = loadManagedLlamaCppOwner(paths)?.gpuDeviceUuid;
    expect([UUID_ONE, UUID_TWO]).toContain(persisted);
    expect(first.output()).toContain(`bound:${persisted}`);
    expect(second.output()).toContain(`bound:${persisted}`);
  } finally {
    firstChild?.kill();
    secondChild?.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
