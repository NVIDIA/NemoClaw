// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { BrevLaunchableFixture, type BrevWorkspaceOwnership } from "../fixtures/brev-launchable.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import {
  lifecycleCommand,
  result,
  workspaceResult,
} from "../../helpers/brev-launchable-client-fixture.ts";
import { failingReadinessCommand } from "../../helpers/brev-launchable-readiness-fixture.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the Brev Launchable fixture owns one exact workspace lifecycle", () => {
  it("creates, verifies, and deletes the same workspace identity", async () => {
    const root = temporaryRoot();
    const lifecycle = lifecycleCommand();
    const command = vi.fn(lifecycle.command);
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    const workspace = await fixture.create(ownership, "env-fixture123");
    expect(workspace.id).toBe("workspace-id");
    expect(ownership).toEqual({
      name: "fixture-workspace",
      createRequested: true,
      accepted: true,
      id: "workspace-id",
    });

    await fixture.delete(ownership, 2_000);
    expect(lifecycle.absentReads()).toBeGreaterThanOrEqual(3);
    expect(command.mock.calls.filter((call) => call[1][0] === "delete")).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "brev-workspace-cleanup.json"), "utf8")),
    ).toMatchObject({ status: "ABSENT", workspaceId: "workspace-id" });
  });

  it("refuses cleanup after the workspace identity changes", async () => {
    const root = temporaryRoot();
    const command = vi.fn(async () => workspaceResult("foreign-id"));
    const fixture = createFixture(root, command);
    const ownership: BrevWorkspaceOwnership = {
      name: "fixture-workspace",
      createRequested: true,
      accepted: true,
      id: "owned-id",
    };

    await expect(fixture.delete(ownership, 100)).rejects.toThrow(
      "Brev workspace identity changed before cleanup",
    );
    expect(command.mock.calls.flat().some((value) => value === "delete")).toBe(false);
  });

  it("refuses to delete a replacement after readiness fails", async () => {
    const root = temporaryRoot();
    const readiness = failingReadinessCommand();
    const command = vi.fn(readiness.command);
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await expect(fixture.create(ownership, "env-fixture123")).rejects.toThrow(
      "Brev workspace entered terminal state",
    );
    expect(ownership.id).toBe("owned-id");
    readiness.replace();
    await expect(fixture.delete(ownership, 100)).rejects.toThrow(
      "Brev workspace identity changed before cleanup",
    );
    expect(command.mock.calls.flat().some((value) => value === "delete")).toBe(false);
  });

  it("removes the private local script after Brev exec returns", async () => {
    const root = temporaryRoot();
    let observedScript = "";
    const command = vi.fn(async (_binary: string, args: string[]) => {
      observedScript = args[2]?.slice(1) ?? "";
      expect(fs.statSync(observedScript).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(observedScript, "utf8")).toContain("fixture script");
      return result("");
    });
    const fixture = createFixture(root, command);

    await fixture.execScript("fixture-workspace", "echo fixture script", {
      artifactName: "fixture-script",
    });

    expect(observedScript).not.toBe("");
    expect(fs.existsSync(observedScript)).toBe(false);
    expect(fs.existsSync(path.dirname(observedScript))).toBe(false);
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brev-launchable-fixture-test-"));
  roots.push(root);
  return root;
}

function createFixture(
  root: string,
  command: (...args: any[]) => Promise<ShellProbeResult>,
): BrevLaunchableFixture {
  const host = { command } as unknown as HostCliClient;
  const secrets = {
    required: () => "fixture-secret",
  } as unknown as SecretStore;
  return new BrevLaunchableFixture({ artifacts: new ArtifactSink(root), host, pollMs: 1, secrets });
}
