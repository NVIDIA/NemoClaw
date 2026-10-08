// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { cleanupSandbox, providerPolicyRestoreArgs } from "../live/inference-routing-helpers.ts";

const home = vi.hoisted(() => `/tmp/nemoclaw-inference-cleanup-test-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function result(stdout = "", exitCode = 0): ShellProbeResult {
  return {
    command: [],
    stdout,
    stderr: "",
    exitCode,
    signal: null,
    timedOut: false,
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}
function fixture(listing: ShellProbeResult) {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  const calls: string[] = [];
  const sandbox = new SandboxClient({
    run: async (command) => {
      calls.push(command.args.join(" "));
      const response = new Map([
        ["sandbox list", listing],
        ["sandbox delete fixture", result()],
      ]).get(command.args.join(" "));
      expect(response, `unsupported command: ${command.args.join(" ")}`).toBeDefined();
      return response!;
    },
  });
  const host = {
    command: vi.fn(async () => {
      calls.push("public destroy");
      return result();
    }),
  };
  return {
    calls,
    host,
    run: () =>
      cleanupSandbox(host as unknown as HostCliClient, sandbox, "fixture", { strict: true }),
  };
}

describe("inference routing strict cleanup", () => {
  it("confirms absence before public destroy can stop the gateway (#12558)", async () => {
    const f = fixture(result("No sandboxes found.\n"));
    await f.run();
    expect(f.calls).toEqual(["sandbox delete fixture", "sandbox list", "public destroy"]);
  });
  it.each([
    ["sandbox still present", result("fixture Ready\n")],
    ["unsupported command", result("unrecognized subcommand", 2)],
    ["gateway unreachable", result("connection refused", 1)],
    ["timeout", { ...result("", 0), timedOut: true }],
    ["terminated probe", { ...result("", 0), signal: "SIGTERM" as const }],
  ])("does not claim absence for %s (#12558)", async (_name, response) => {
    const f = fixture(response);
    await expect(f.run()).rejects.toThrow("absence was not verified");
    expect(f.host.command).not.toHaveBeenCalled();
  });
  it("does not mistake a sibling's name for the target (#12558)", async () => {
    const f = fixture(result("fixture-sibling Ready\n"));
    await f.run();
    expect(f.host.command).toHaveBeenCalledOnce();
  });
});

describe("runtime identity settings restoration", () => {
  it("deletes a setting absent from the pinned CLI JSON (#12558)", () => {
    expect(providerPolicyRestoreArgs(undefined)).toEqual([
      "settings",
      "delete",
      "--global",
      "--key",
      "providers_v2_enabled",
      "--yes",
    ]);
  });
  it.each(["true", "false"])("restores an explicit %s setting (#12558)", (value) => {
    expect(providerPolicyRestoreArgs(value)).toEqual([
      "settings",
      "set",
      "--global",
      "--key",
      "providers_v2_enabled",
      "--value",
      value,
      "--yes",
    ]);
  });
  it.each([null, true, false, "", "invalid"])("rejects malformed value %s (#12558)", (value) => {
    expect(providerPolicyRestoreArgs(value)).toBeUndefined();
  });
});
