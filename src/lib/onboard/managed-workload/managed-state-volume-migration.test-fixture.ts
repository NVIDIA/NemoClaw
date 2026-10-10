// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { managedStartupStateRoots } from "../managed-startup/state-roots";
import type { MigrationEngine } from "./managed-state-volume-migration";
import {
  MANAGED_STATE_COPY_IMAGE,
  managedStateVolumeCopyProgram,
} from "./managed-state-volume-copy";

type Volume = {
  Name: string;
  Driver: string;
  Scope: string;
  CreatedAt: string;
  Mountpoint: string;
  Options: Record<string, string> | null;
  Labels: Record<string, string>;
  bytes: string;
};
const temporary: string[] = [];
export function cleanupMigrationHarness() {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
}

export function createMigrationHarness(agent: "openclaw" | "hermes" = "openclaw") {
  vi.stubEnv("OPENSHELL_WORKSPACE", "default");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-volume-test-"));
  temporary.push(stateDir);
  const root = managedStartupStateRoots({
    agent,
    sandboxName: "alpha",
    agentIdentity: { uid: 1000, gid: 1000 },
  })[0]!;
  let generation = 0;
  const volume = (name: string, labels: Record<string, string>): Volume => ({
    Name: name,
    Driver: "local",
    Scope: "local",
    CreatedAt: new Date(1_800_000_000_000 + generation++).toISOString(),
    Mountpoint: `/volumes/${name}/_data`,
    Options: null,
    Labels: labels,
    bytes: "",
  });
  const source = volume(root.resourceIdentity, { ...root.ownershipLabels });
  source.bytes = "retained user state";
  const volumes = new Map([[source.Name, source]]);
  const attached = new Set<string>();
  const calls: string[][] = [];
  const helperId = "a".repeat(64);
  let helper: string[] | undefined;
  const controls = {
    createStatus: 0,
    copyStatus: 0,
    throwStart: false,
    cleanupStatus: 0,
    keepRemovedVolume: false,
    volumeRemoveStatus: 0,
    helperOverride: {} as Record<string, unknown>,
    afterCopy: () => {},
  };
  const run: MigrationEngine = (args) => {
    calls.push([...args]);
    const ok = (stdout = "") => ({ status: 0, stdout });
    if (args[0] === "volume" && args[1] === "inspect") {
      const observed = volumes.get(args.at(-1)!);
      return observed ? ok(JSON.stringify(observed)) : { status: 1, stderr: "no such volume" };
    }
    if (args[0] === "volume" && args[1] === "ls") return ok([...volumes.keys()].join("\n"));
    if (args[0] === "volume" && args[1] === "create") {
      const labels: Record<string, string> = {};
      args.forEach((argument, i) => {
        if (argument === "--label") {
          const [key, ...value] = args[i + 1]!.split("=");
          labels[key!] = value.join("=");
        }
      });
      const name = args.at(-1)!;
      if (!volumes.has(name)) volumes.set(name, volume(name, labels));
      return ok(name);
    }
    if (args[0] === "volume" && args[1] === "rm") {
      if (!controls.keepRemovedVolume) volumes.delete(args.at(-1)!);
      return { status: controls.volumeRemoveStatus };
    }
    if (args[0] === "ps") {
      const filter = args[args.indexOf("--filter") + 1]!;
      return ok(
        filter.startsWith("volume=")
          ? attached.has(filter.slice(7))
            ? "b".repeat(64)
            : helper
              ? helperId
              : ""
          : helper
            ? helperId
            : "",
      );
    }
    if (args[0] === "container" && args[1] === "inspect" && helper) {
      const label = helper[helper.indexOf("--label") + 1]!.split("=");
      return ok(
        JSON.stringify({
          Id: helperId,
          Name: `/${helper[helper.indexOf("--name") + 1]}`,
          Config: {
            Image: MANAGED_STATE_COPY_IMAGE,
            Entrypoint: ["/usr/local/bin/node"],
            Cmd: ["-e", managedStateVolumeCopyProgram()],
            Labels: { [label[0]!]: label[1] },
          },
          Mounts: [
            { Type: "volume", Name: source.Name, Destination: "/source", RW: false },
            { Type: "volume", Name: [...volumes.keys()][1], Destination: "/destination", RW: true },
          ],
          ...controls.helperOverride,
        }),
      );
    }
    if (args[0] === "image" || args[0] === "pull") return ok();
    if (args[0] === "create") {
      if (controls.createStatus !== 0) return { status: controls.createStatus };
      helper = [...args];
      return ok(helperId);
    }
    if (args[0] === "start") {
      if (controls.throwStart) throw new Error("transport interrupted");
      const destination = [...volumes.values()].find((item) => item.Name !== source.Name)!;
      destination.bytes = controls.copyStatus === 0 ? source.bytes : "partial copy";
      controls.afterCopy();
      return {
        status: controls.copyStatus,
        stdout: JSON.stringify({ schemaVersion: 1, sha256: "c".repeat(64) }),
      };
    }
    if (args[0] === "rm") {
      if (args.join(" ") !== `rm --force ${helperId}`)
        throw new Error("Wrong helper cleanup identity");
      if (controls.cleanupStatus === 0) helper = undefined;
      return { status: controls.cleanupStatus };
    }
    throw new Error(`Unexpected test engine command: ${args[0]}`);
  };
  const context = { providerId: "docker", workspace: "default", stateDir };
  const deps = {
    migrationStateDir: stateDir,
    runMigrationEngine: run,
    runContainerEngine: (args: readonly string[]) => run(["volume", ...args]),
    registerExitCleanup: () => () => {},
  };
  return {
    root,
    context,
    deps,
    run,
    source,
    volumes,
    attached,
    calls,
    controls,
    stateDir,
    input: { roots: [root] },
    journalFile: () =>
      path.join(
        stateDir,
        "managed-volume-migrations",
        fs.readdirSync(path.join(stateDir, "managed-volume-migrations"))[0]!,
      ),
  };
}

export type MigrationHarness = ReturnType<typeof createMigrationHarness>;
