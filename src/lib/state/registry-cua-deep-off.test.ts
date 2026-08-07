// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const parseCuaRuntimeReadiness = vi.hoisted(() => vi.fn());

vi.mock("../cua/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cua/schema")>()),
  parseCuaRuntimeReadiness,
}));

const originalHome = process.env.HOME;
const originalCuaEnabled = process.env.NEMOCLAW_CUA_ENABLED;
const originalCuaQualification = process.env.NEMOCLAW_CUA_QUALIFICATION;
const temporaryHomes: string[] = [];

async function loadRegistryWithOpaqueReadiness(options: { frameworkOnly?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-cua-deep-off-"));
  temporaryHomes.push(home);
  const configDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "nemocua",
          provider: "nvidia",
          model: "nvidia/model",
          cuaRuntimeReadiness: { untrusted: "opaque-candidate-record" },
        },
        beta: {
          name: "beta",
          agent: "openclaw",
          model: "preserved",
          gatewayName: "nemoclaw-8081",
          gatewayPort: 8081,
        },
      },
    }),
    { mode: 0o600 },
  );
  process.env.HOME = home;
  options.frameworkOnly
    ? (process.env.NEMOCLAW_CUA_ENABLED = "1")
    : delete process.env.NEMOCLAW_CUA_ENABLED;
  delete process.env.NEMOCLAW_CUA_QUALIFICATION;
  vi.resetModules();
  return {
    home,
    registry: await import("./registry"),
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  originalCuaEnabled === undefined
    ? delete process.env.NEMOCLAW_CUA_ENABLED
    : (process.env.NEMOCLAW_CUA_ENABLED = originalCuaEnabled);
  originalCuaQualification === undefined
    ? delete process.env.NEMOCLAW_CUA_QUALIFICATION
    : (process.env.NEMOCLAW_CUA_QUALIFICATION = originalCuaQualification);
  parseCuaRuntimeReadiness.mockReset();
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("CUA registry deep-off boundary (#7755)", () => {
  it("does not parse or expose CUA readiness and preserves it across unrelated writes", async () => {
    const { home, registry } = await loadRegistryWithOpaqueReadiness();
    const persistence = await import("./registry/persistence");

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(
      registry.recordCuaRuntimeReadiness("alpha", {} as never, registry.getSandbox("alpha")!),
    ).toBe(false);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    const publicSerialization = JSON.stringify(persistence.load());
    expect(publicSerialization).not.toContain("cuaRuntimeReadiness");
    expect(publicSerialization).not.toContain("opaque-candidate-record");

    expect(registry.updateSandbox("alpha", { dashboardPort: 18080 })).toBe(true);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as {
      sandboxes: Record<string, Record<string, unknown>>;
    };
    expect(persisted.sandboxes.alpha?.cuaRuntimeReadiness).toEqual({
      untrusted: "opaque-candidate-record",
    });
    expect(persisted.sandboxes.beta).toMatchObject({ model: "preserved" });
  });

  it("keeps readiness opaque when only the framework gate is enabled (#7755)", async () => {
    const { home, registry } = await loadRegistryWithOpaqueReadiness({ frameworkOnly: true });
    const persistence = await import("./registry/persistence");

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toBeUndefined();
    expect(
      registry.recordCuaRuntimeReadiness("alpha", {} as never, registry.getSandbox("alpha")!),
    ).toBe(false);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    expect(JSON.stringify(persistence.load())).not.toContain("opaque-candidate-record");

    expect(registry.updateSandbox("alpha", { dashboardPort: 18080 })).toBe(true);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as { sandboxes: Record<string, Record<string, unknown>> };
    expect(persisted.sandboxes.alpha?.cuaRuntimeReadiness).toEqual({
      untrusted: "opaque-candidate-record",
    });
  });

  it("revokes opaque readiness when the recorded inference route changes", async () => {
    const { home, registry } = await loadRegistryWithOpaqueReadiness();

    expect(registry.updateSandbox("alpha", { model: "nvidia/other-model" })).toBe(true);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as {
      sandboxes: Record<string, Record<string, unknown>>;
    };
    expect(persisted.sandboxes.alpha?.cuaRuntimeReadiness).toBeUndefined();
    expect(persisted.sandboxes.alpha?.model).toBe("nvidia/other-model");
  });

  it("revokes opaque readiness without parsing it when policy authority changes", async () => {
    const { home, registry } = await loadRegistryWithOpaqueReadiness();

    expect(registry.updateSandbox("alpha", { policies: ["managed-inference"] })).toBe(true);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as {
      sandboxes: Record<string, Record<string, unknown>>;
    };
    expect(persisted.sandboxes.alpha?.cuaRuntimeReadiness).toBeUndefined();
    expect(persisted.sandboxes.alpha?.policies).toEqual(["managed-inference"]);
  });

  it("revokes opaque readiness before an agent can move away and back", async () => {
    const { home, registry } = await loadRegistryWithOpaqueReadiness();

    expect(registry.updateSandbox("alpha", { agent: "openclaw" })).toBe(true);
    expect(registry.updateSandbox("alpha", { agent: "nemocua" })).toBe(true);
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as {
      sandboxes: Record<string, Record<string, unknown>>;
    };
    expect(persisted.sandboxes.alpha?.agent).toBe("nemocua");
    expect(persisted.sandboxes.alpha?.cuaRuntimeReadiness).toBeUndefined();
  });

  it("revokes opaque readiness in the direct rebuild route transaction", async () => {
    const { home } = await loadRegistryWithOpaqueReadiness();
    const { commitRebuildRoutePreflight } = await import(
      "../actions/sandbox/rebuild-preflight-guards"
    );

    expect(
      commitRebuildRoutePreflight({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        targetUpdate: {
          provider: "nvidia",
          model: "nvidia/model",
          endpointUrl: null,
          preferredInferenceApi: null,
          credentialEnv: null,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(parseCuaRuntimeReadiness).not.toHaveBeenCalled();

    const persisted = JSON.parse(
      fs.readFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), "utf8"),
    ) as {
      sandboxes: Record<string, Record<string, unknown>>;
    };
    expect(persisted.sandboxes.alpha?.cuaRuntimeReadiness).toBeUndefined();
  });
});
