// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeNativeProviderPolicy, requireNativeProviderPolicy } from "./provider-policy";

const runtime = vi.hoisted(() => ({ version: "0.1.3" }));
vi.mock("../../onboard/openshell-version", async (original) => ({
  ...(await original<typeof import("../../onboard/openshell-version")>()),
  get SUPPORTED_OPENSHELL_FALLBACK_VERSION() {
    return runtime.version;
  },
}));

describe.each(["0.1.3", "0.1.5"])("OpenShell %s projection", (version) => {
  beforeEach(() => {
    runtime.version = version;
  });
  describe.each([requireNativeProviderPolicy, initializeNativeProviderPolicy])(
    "rejects invalid policy evidence without changing the projected gateway",
    (check) => {
      it.each([
        { status: 1, stdout: "{}" },
        { status: null, stdout: "{}" },
        { status: 0, stdout: "not-json" },
        { status: 0, stdout: JSON.stringify({ revisions: [], next_page_token: "more" }) },
        {
          status: 0,
          stdout: JSON.stringify({ revisions: [], next_page_token: "" }),
          error: new Error("lost transport"),
        },
      ])("rejects invalid response %j", async (response) => {
        const run = vi.fn(async () => response);
        await expect(check("selected", run)).rejects.toThrow();
        expect(run).toHaveBeenCalledExactlyOnceWith([
          "policy",
          "list",
          "-g",
          "selected",
          "--global",
          "--page-size",
          "1",
          "--output",
          "json",
        ]);
      });
    },
  );

  it.each(["loaded", "pending", "failed", "superseded"])(
    "accepts only a superseded global override in the projected runtime: %s",
    async (status) => {
      const run = vi.fn(async (args: string[]) => ({
        status: 0,
        stdout: JSON.stringify(
          args[1] === "list"
            ? { revisions: [{ version: 1 }], next_page_token: "" }
            : { scope: "global", status },
        ),
      }));
      const result = requireNativeProviderPolicy("selected", run);
      const observation = await result.then(
        () => null,
        (error: Error) => error.message,
      );
      expect(observation).toEqual(
        status === "superseded" ? null : expect.stringMatching(/global policy override/),
      );
      expect(run.mock.calls.map(([args]) => args[1])).toEqual(["list", "get"]);
    },
  );
});
