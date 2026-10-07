// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeNativeProviderPolicy, requireNativeProviderPolicy } from "./provider-policy";

import { fixture } from "./provider-policy.test-support";

afterEach(() => vi.unstubAllEnvs());
describe("native provider policy prerequisites", () => {
  it("reads the named existing gateway without changing its settings (#12558)", async () => {
    const run = fixture();
    await requireNativeProviderPolicy("selected", run);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["settings", "get", "-g", "selected", "--global", "--json"],
      ["policy", "list", "-g", "selected", "--global", "--limit", "1"],
    ]);
  });
  it.each(["false", "<unset>"])(
    "refuses %s composition without writing (#12558)",
    async (value) => {
      const run = fixture(value);
      await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow(
        /administrator.*enable composition/,
      );
      expect(run.mock.calls.every(([args]) => args[1] === "get")).toBe(true);
    },
  );
  it("refuses an active global override even when composition is enabled (#12558)", async () => {
    const run = fixture("true", {
      status: 0,
      stdout: JSON.stringify({ scope: "global", status: "loaded" }),
      stderr: "",
    });
    await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow(
      /global policy override/,
    );
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(["get", "list", "get"]);
  });
  it("accepts deleted global policy history (#12558)", async () => {
    const run = fixture("true", {
      status: 0,
      stdout: JSON.stringify({ scope: "global", status: "superseded" }),
      stderr: "",
    });
    await expect(requireNativeProviderPolicy("selected", run)).resolves.toBeUndefined();
  });
  it.each([
    { status: 1, stdout: "", stderr: "No global policy history found" },
    {
      status: 1,
      stdout: "",
      stderr: 'status: NotFound, message: "no global policy revision found"',
    },
    { status: 1, stdout: "", stderr: "permission denied" },
    { status: null, stdout: "", stderr: "connection lost" },
  ])(
    "stops fresh initialization when policy history cannot be verified (#12558)",
    async (response) => {
      const run = vi.fn(async () => response);
      await expect(initializeNativeProviderPolicy("selected", run)).rejects.toThrow(
        /prerequisites/,
      );
      expect(run).toHaveBeenCalledExactlyOnceWith([
        "policy",
        "list",
        "-g",
        "selected",
        "--global",
        "--limit",
        "1",
      ]);
    },
  );
  it("does not accept policy history without a verified current revision (#12558)", async () => {
    const run = fixture();
    run.mockResolvedValueOnce({
      status: 0,
      stdout: "VERSION HASH STATUS CREATED ERROR\n",
      stderr: "",
    });
    await expect(initializeNativeProviderPolicy("selected", run)).rejects.toThrow(/prerequisites/);
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(["list", "get"]);
  });
  it("initializes a fresh gateway once and verifies applied settings (#12558)", async () => {
    const run = fixture("<unset>");
    await initializeNativeProviderPolicy("selected", run);
    expect(run.mock.calls.filter(([args]) => args[1] === "set")).toHaveLength(1);
    expect(run.mock.calls.at(-2)?.[0]).toContain("get");
  });
  it("reconciles a lost initialization response without another write (#12558)", async () => {
    const original = fixture();
    const run = vi.fn(async (args: string[]) =>
      args[1] === "set" ? { status: null, error: new Error("connection lost") } : original(args),
    );
    await expect(initializeNativeProviderPolicy("selected", run)).resolves.toBeUndefined();
    expect(run.mock.calls.filter(([args]) => args[1] === "set")).toHaveLength(1);
  });
  it("observes the setting after an initialization transport exception (#12558)", async () => {
    const run = fixture();
    run.mockResolvedValueOnce({ status: 0, stdout: "", stderr: "No global policy history found" });
    run.mockRejectedValueOnce(new Error("connection lost"));
    await expect(initializeNativeProviderPolicy("selected", run)).resolves.toBeUndefined();
    expect(run.mock.calls.filter(([args]) => args[1] === "set")).toHaveLength(1);
  });
  it.each([
    { status: 1, stdout: "", stderr: "connection lost" },
    { status: 0, stdout: "{broken", stderr: "" },
    { status: 0, stdout: "[]", stderr: "" },
  ])("rejects an unverified gateway response (#12558)", async (response) => {
    await expect(requireNativeProviderPolicy("selected", async () => response)).rejects.toThrow();
  });
  it("rejects an ambient endpoint override before any command (#12558)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://another.example:443");
    const run = fixture();
    await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
