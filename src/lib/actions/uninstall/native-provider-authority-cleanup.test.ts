// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { prepareGatewayProviderAuthorityRetirement } from "../../state/gateway-registry";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-authority-cleanup-"));
  onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryFile = path.join(home, "sandboxes.json");
  const authority = { providerId: "original-provider" };
  const initial = {
    defaultSandbox: null,
    defaultSelectionRevision: 3,
    sandboxes: {},
    nativeNvidiaProviderAuthorities: { nemoclaw: authority, sibling: { providerId: "sibling" } },
    nativeHostedProviderAuthorities: {
      nemoclaw: { hosted: authority },
      sibling: { hosted: authority },
    },
    nativeLocalProviderAuthorities: {
      local: { gatewayName: "nemoclaw", providerId: "local" },
      siblingLocal: { gatewayName: "sibling", providerId: "sibling-local" },
    },
    futureField: { retained: true },
  };
  const write = (value: unknown) => fs.writeFileSync(registryFile, JSON.stringify(value));
  const read = () => JSON.parse(fs.readFileSync(registryFile, "utf8"));
  write(initial);
  const writeAtomic = vi.fn((_home: string, _file: string, value: unknown) => write(value));
  const retire = prepareGatewayProviderAuthorityRetirement({
    home,
    registryFile,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    writeAtomic,
  });
  assert(retire, "Expected selected authority cleanup");
  return { home, registryFile, initial, write, read, writeAtomic, retire };
}

it("retires only the removed gateway's hosted and local authority (#13470)", () => {
  const state = fixture();
  state.retire(false);
  expect(state.read()).toEqual({
    ...state.initial,
    nativeNvidiaProviderAuthorities: { sibling: { providerId: "sibling" } },
    nativeHostedProviderAuthorities: {
      sibling: state.initial.nativeHostedProviderAuthorities.sibling,
    },
    nativeLocalProviderAuthorities: {
      siblingLocal: state.initial.nativeLocalProviderAuthorities.siblingLocal,
    },
  });
  expect(state.writeAtomic).toHaveBeenCalledOnce();
});

type TestRegistry = ReturnType<typeof fixture>["initial"];

it.each([
  {
    kind: "provider",
    change: (registry: TestRegistry) => {
      registry.nativeNvidiaProviderAuthorities.nemoclaw.providerId = "replacement";
    },
  },
  {
    kind: "hosted",
    change: (registry: TestRegistry) => {
      registry.nativeHostedProviderAuthorities.nemoclaw.hosted.providerId = "replacement";
    },
  },
  {
    kind: "local",
    change: (registry: TestRegistry) => {
      registry.nativeLocalProviderAuthorities.local.providerId = "replacement";
    },
  },
  {
    kind: "sandbox",
    change: (registry: TestRegistry) => {
      registry.sandboxes = {
        concurrent: { name: "concurrent", gatewayName: "nemoclaw", gatewayPort: 8080 },
      };
    },
  },
])("retains authority when selected $kind state changes during cleanup (#13470)", ({ change }) => {
  const state = fixture();
  const changed = state.read();
  change(changed);
  state.write(changed);
  expect(() => state.retire(false)).toThrow("changed during uninstall");
  expect(state.read()).toEqual(changed);
  expect(state.writeAtomic).not.toHaveBeenCalled();
});

it("preserves concurrent sibling updates when retiring selected authority (#13470)", () => {
  const state = fixture();
  const changed = state.read();
  changed.nativeNvidiaProviderAuthorities.sibling.providerId = "new-sibling";
  changed.sandboxes["sibling-box"] = {
    name: "sibling-box",
    gatewayName: "nemoclaw-9123",
    gatewayPort: 9123,
  };
  state.write(changed);
  state.retire(true);
  expect(state.read().nativeNvidiaProviderAuthorities.sibling.providerId).toBe("new-sibling");
  expect(state.read().sandboxes).toEqual(changed.sandboxes);
});

it("refuses to retire authority while a selected row remains after scoped pruning (#13470)", () => {
  const state = fixture();
  const changed = state.read();
  changed.sandboxes.remaining = { name: "remaining", gatewayName: "nemoclaw", gatewayPort: 8080 };
  state.write(changed);
  expect(() => state.retire(true)).toThrow("changed during uninstall");
  expect(state.writeAtomic).not.toHaveBeenCalled();
});

it("does not recreate a registry root removed by a full purge (#13470)", () => {
  const state = fixture();
  fs.rmSync(state.home, { recursive: true });
  state.retire(false);
  expect(fs.existsSync(state.home)).toBe(false);
  expect(state.writeAtomic).not.toHaveBeenCalled();
});

it("retires native authority after recovering an abandoned registry lock (#13470)", () => {
  const state = fixture();
  const lock = `${state.registryFile}.lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  const abandoned = new Date(Date.now() - 600_000);
  fs.utimesSync(lock, abandoned, abandoned);
  state.retire(false);
  expect(state.read().nativeNvidiaProviderAuthorities).not.toHaveProperty("nemoclaw");
  expect(fs.existsSync(lock)).toBe(false);
});
