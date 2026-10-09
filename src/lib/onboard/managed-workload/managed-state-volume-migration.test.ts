// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateManagedStateVolume,
  managedStateVolumeMigrationPhase,
  resolveMigratedManagedStateRoot,
  verifyMigratedManagedStateRoot,
} from "./managed-state-volume-migration";
import {
  prepareManagedStateVolumes,
  preflightManagedStateVolumes,
  removeManagedStateVolumes,
} from "./managed-state-volumes";
import { MANAGED_STATE_COPY_IMAGE } from "./managed-state-volume-copy";
import { createManagedStateVolumeOnboardLifecycle } from "./onboard-orchestration";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";

import {
  createMigrationHarness as harness,
  cleanupMigrationHarness,
  type MigrationHarness,
} from "./managed-state-volume-migration.test-fixture";

afterEach(cleanupMigrationHarness);

describe("retained managed volume migration", () => {
  it.each(["docker", "podman"])(
    "defers %s copying until materialization after source deletion",
    async (providerId) => {
      const h = harness();
      h.context.providerId = providerId;
      h.attached.add(h.source.Name);
      const provider = {
        identity: { id: providerId },
        workload: { managedStateMountDriverId: providerId },
        containerEngine: {
          supported: true,
          capture: (operation: string, args: readonly string[], timeout?: number) => {
            expect(operation).toBe("workload-cleanup");
            return h.run(args, timeout);
          },
        },
      } as unknown as RuntimeProviderBundle;
      const lifecycle = createManagedStateVolumeOnboardLifecycle(
        { roots: h.input.roots, runtimeProvider: provider },
        {
          migrationStateDir: h.stateDir,
          registerExitCleanup: () => () => {},
        },
      );
      expect(h.volumes.size).toBe(1);
      expect(h.calls.every((args) => args[0] === "volume" && args[1] === "inspect")).toBe(true);
      h.attached.delete(h.source.Name);
      await lifecycle.materializeSandboxCreatePlan({} as never, async (input) => {
        expect(input.managedStateMountDriverId).toBe(providerId);
        expect(input.managedStateMounts?.[0]?.source).not.toBe(h.source.Name);
        return {} as never;
      });
      lifecycle.commit();
      expect(h.volumes.size).toBe(2);
      expect(managedStateVolumeMigrationPhase(h.root, h.context)).toBe("verified");
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "copies and selects %s state without mutating the original",
    (agent) => {
      const h = harness(agent);
      const original = JSON.stringify(h.source);
      preflightManagedStateVolumes(h.input, h.deps);
      expect(h.calls.every((args) => args[0] === "volume" && args[1] === "inspect")).toBe(true);
      const scope = prepareManagedStateVolumes(h.input, h.deps)!;
      const destination = h.volumes.get(scope.mounts[0]!.source)!;
      expect(destination.Name).not.toBe(h.source.Name);
      expect(destination.bytes).toBe(h.source.bytes);
      expect(destination.Labels).toMatchObject({
        ...h.root.ownershipLabels,
        "openshell.ai/sandbox-attachable": "true",
        "openshell.ai/sandbox-attachable-workspace": "default",
      });
      expect(JSON.stringify(h.source)).toBe(original);
      expect(scope.cleanupIncompleteCreate()).toEqual([]);
      scope.commit();
      const helper = h.calls.find((args) => args[0] === "create")!;
      expect(helper).toContain(MANAGED_STATE_COPY_IMAGE);
      expect(helper).toContain(
        `type=volume,src=${h.source.Name},dst=/source,readonly,volume-nocopy`,
      );
      expect(helper).toContain("none");
      expect(helper).toContain("--read-only");
      expect(helper.join(" ")).not.toMatch(/docker\.sock|type=bind/u);
      const before = h.calls.filter((args) => args[0] === "start").length;
      expect(prepareManagedStateVolumes(h.input, h.deps)!.mounts).toEqual(scope.mounts);
      expect(h.calls.filter((args) => args[0] === "start")).toHaveLength(before);
      expect(resolveMigratedManagedStateRoot(h.root, h.context).resourceIdentity).toBe(
        destination.Name,
      );
      expect(fs.statSync(h.journalFile()).mode & 0o777).toBe(0o600);
    },
  );

  it("waits for exact source volume quiescence without deleting a user container", () => {
    const h = harness();
    h.attached.add(h.source.Name);
    preflightManagedStateVolumes(h.input, h.deps);
    expect(() => prepareManagedStateVolumes(h.input, h.deps)).toThrow("still attached");
    expect(h.volumes.size).toBe(1);
    expect(h.calls.some((args) => ["rm", "create", "pull"].includes(args[0]!))).toBe(false);
  });

  it.each([
    {
      problem: "foreign",
      change: (h: MigrationHarness) => {
        h.source.Labels = {};
      },
    },
    {
      problem: "remote driver",
      change: (h: MigrationHarness) => {
        h.source.Driver = "nfs";
      },
    },
    {
      problem: "driver options",
      change: (h: MigrationHarness) => {
        h.source.Options = { device: "/sensitive" };
      },
    },
    {
      problem: "conflicting approval",
      change: (h: MigrationHarness) => {
        h.source.Labels["openshell.ai/sandbox-attachable"] = "false";
      },
    },
  ])("rejects $problem before any copy", ({ change }) => {
    const h = harness();
    change(h);
    expect(() => preflightManagedStateVolumes(h.input, h.deps)).toThrow();
    expect(h.volumes.size).toBe(1);
    expect(h.calls.every((args) => args[0] === "volume" && args[1] === "inspect")).toBe(true);
  });

  it.each([
    {
      problem: "copy failure",
      change: (h: MigrationHarness) => {
        h.controls.copyStatus = 1;
      },
    },
    {
      problem: "transport exception",
      change: (h: MigrationHarness) => {
        h.controls.throwStart = true;
      },
    },
    {
      problem: "cleanup failure",
      change: (h: MigrationHarness) => {
        h.controls.cleanupStatus = 1;
      },
    },
    {
      problem: "source changed",
      change: (h: MigrationHarness) => {
        h.controls.afterCopy = () => {
          h.source.CreatedAt = new Date().toISOString();
        };
      },
    },
    {
      problem: "destination changed",
      change: (h: MigrationHarness) => {
        h.controls.afterCopy = () => {
          [...h.volumes.values()][1]!.CreatedAt = new Date().toISOString();
        };
      },
    },
    {
      problem: "new source user",
      change: (h: MigrationHarness) => {
        h.controls.afterCopy = () => {
          h.attached.add(h.source.Name);
        };
      },
    },
  ])("retains both volumes and refuses adoption after $problem", ({ change }) => {
    const h = harness();
    change(h);
    expect(() => prepareManagedStateVolumes(h.input, h.deps)).toThrow();
    expect(h.source.bytes).toBe("retained user state");
    expect(h.volumes.size).toBe(2);
    expect(managedStateVolumeMigrationPhase(h.root, h.context)).toBe("copying");
    expect(() => resolveMigratedManagedStateRoot(h.root, h.context)).toThrow("incomplete copy");
    expect(() => prepareManagedStateVolumes(h.input, h.deps)).toThrow("incomplete copy");
    expect(h.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    expect(h.calls.filter((args) => args[0] === "rm")).toHaveLength(1);
    expect(h.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  });

  it("rejects an unreceipted destination rather than overwriting its data", () => {
    const h = harness();
    const selected = migrateManagedStateVolume(h.root, h.context, h.run);
    const saved = h.volumes.get(selected.resourceIdentity)!.bytes;
    fs.unlinkSync(h.journalFile());
    expect(() => migrateManagedStateVolume(h.root, h.context, h.run)).toThrow("already exists");
    expect(h.volumes.get(selected.resourceIdentity)!.bytes).toBe(saved);
    expect(h.calls.filter((args) => args[0] === "start")).toHaveLength(1);
  });

  it.each([
    {
      problem: "missing",
      change: (h: MigrationHarness, name: string) => {
        h.volumes.delete(name);
      },
    },
    {
      problem: "replaced",
      change: (h: MigrationHarness, name: string) => {
        h.volumes.get(name)!.CreatedAt = new Date().toISOString();
      },
    },
  ])("rejects a $problem selected copy before deleting a source sandbox", ({ change }) => {
    const h = harness();
    const selected = migrateManagedStateVolume(h.root, h.context, h.run);
    change(h, selected.resourceIdentity);
    expect(() => preflightManagedStateVolumes(h.input, h.deps)).toThrow();
    expect(() => verifyMigratedManagedStateRoot(h.root, h.context, h.run)).toThrow();
    expect(h.source.bytes).toBe("retained user state");
  });

  it("destroys only the selected copy; a fresh install does not resurrect the retained backup", () => {
    const h = harness();
    const first = prepareManagedStateVolumes(h.input, h.deps)!;
    first.commit();
    const destination = first.mounts[0]!.source;
    expect(removeManagedStateVolumes(h.input, h.deps)).toEqual([
      { status: "removed", retainedVolumeName: h.source.Name },
    ]);
    expect(h.volumes.has(h.source.Name)).toBe(true);
    expect(h.volumes.has(destination)).toBe(false);
    expect(removeManagedStateVolumes(h.input, h.deps)).toEqual([
      { status: "absent", retainedVolumeName: h.source.Name },
    ]);
    preflightManagedStateVolumes(h.input, h.deps);
    const fresh = prepareManagedStateVolumes(h.input, h.deps)!;
    expect(fresh.mounts[0]!.source).toBe(destination);
    expect(h.volumes.get(destination)!.bytes).toBe("");
    expect(() => preflightManagedStateVolumes(h.input, h.deps)).toThrow("Uncommitted");
    fresh.commit();
    verifyMigratedManagedStateRoot(h.root, h.context, h.run);
    expect(h.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    expect(h.source.bytes).toBe("retained user state");
  });

  it("does not retire the selection until destination absence is observed", () => {
    const h = harness();
    prepareManagedStateVolumes(h.input, h.deps)!.commit();
    h.controls.keepRemovedVolume = true;
    expect(removeManagedStateVolumes(h.input, h.deps)[0]).toMatchObject({ status: "failed" });
    expect(managedStateVolumeMigrationPhase(h.root, h.context)).toBe("verified");
  });

  it.each([
    { problem: "corrupt", change: (file: string) => fs.writeFileSync(file, "{}") },
    { problem: "world readable", change: (file: string) => fs.chmodSync(file, 0o644) },
    {
      problem: "symlink",
      change: (file: string) => {
        fs.renameSync(file, file + ".saved");
        fs.symlinkSync(file + ".saved", file);
      },
    },
    {
      problem: "untrusted directory",
      change: (file: string) => fs.chmodSync(path.dirname(file), 0o777),
    },
  ])("rejects a $problem selection journal", ({ change }) => {
    const h = harness();
    prepareManagedStateVolumes(h.input, h.deps)!.commit();
    change(h.journalFile());
    expect(() => resolveMigratedManagedStateRoot(h.root, h.context)).toThrow();
  });
});
