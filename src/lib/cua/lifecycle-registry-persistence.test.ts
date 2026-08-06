// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-registry-cas-"));
process.env.HOME = testHome;
const { executeCuaLifecycleRegistryTransaction } = await import("./lifecycle-registry-transaction");
const { beginCuaSideEffectReconciliation } = await import("./reconciliation");
const persistence = await import("../state/registry/persistence");
const registryLock = await import("../state/registry/lock");

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("CUA lifecycle durable registry CAS", () => {
  it("continues the exact in-flight attempt after durable pending state loads as required", () => {
    persistence.save({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { name: "alpha" } },
    });

    const outcome = executeCuaLifecycleRegistryTransaction({
      sandboxName: "alpha",
      deps: {
        load: persistence.load,
        save: persistence.save,
        withLock: registryLock.withLock,
      },
      execute: (working) => {
        const staged = working.load();
        beginCuaSideEffectReconciliation(staged.sandboxes.alpha!, "target.attach");
        working.save(staged);
        expect(working.checkpoint()).toBe(true);
        expect(JSON.parse(fs.readFileSync(persistence.REGISTRY_FILE, "utf8"))).toMatchObject({
          sandboxes: {
            alpha: {
              cuaReconciliation: {
                phase: "pending",
                trigger: "target.attach",
              },
            },
          },
        });
        expect(persistence.load().sandboxes.alpha?.cuaReconciliation).toMatchObject({
          phase: "required",
          trigger: "target.attach",
        });

        delete staged.sandboxes.alpha!.cuaReconciliation;
        staged.sandboxes.alpha!.lifecycleGeneration = "accepted-generation";
        working.save(staged);
        return "accepted";
      },
      conflict: () => "rejected",
    });

    expect(outcome).toBe("accepted");
    expect(persistence.load().sandboxes.alpha).toMatchObject({
      lifecycleGeneration: "accepted-generation",
    });
    expect(persistence.load().sandboxes.alpha?.cuaReconciliation).toBeUndefined();
  });
});
