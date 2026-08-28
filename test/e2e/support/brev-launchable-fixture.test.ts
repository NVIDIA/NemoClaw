// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  BrevLaunchableFixture,
  type BrevRuntimeIdentity,
  type BrevWorkspaceOwnership,
  type StagingHandoff,
} from "../fixtures/brev-launchable.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the Brev Launchable fixture binds staging identity and workspace lifecycle", () => {
  it("accepts a staging handoff bound to its producer run", async () => {
    const root = temporaryRoot();
    const command = vi.fn(handoffCommand(root, stagingManifest()));
    const fixture = createFixture(root, command);

    await expect(fixture.resolveLatestStagingHandoff()).resolves.toEqual(stagingHandoff());
    expect(command.mock.calls).toHaveLength(2);
    expect(command.mock.calls[0]?.[2]).toMatchObject({
      env: { GH_TOKEN: "fixture-secret" },
      redactionValues: ["fixture-secret"],
    });
  });

  it.each([
    [
      "a mismatched producer run ID",
      (manifest: Record<string, unknown>) => {
        manifest.workflowRunId = 456;
      },
    ],
    [
      "a missing project",
      (manifest: Record<string, unknown>) => {
        delete manifest.project;
      },
    ],
    [
      "an empty image name",
      (manifest: Record<string, unknown>) => {
        manifest.imageName = "";
      },
    ],
    [
      "an invalid NemoClaw commit SHA",
      (manifest: Record<string, unknown>) => {
        manifest.nemoclawSha = "not-a-sha";
      },
    ],
    [
      "an invalid image repository commit SHA",
      (manifest: Record<string, unknown>) => {
        manifest.imageRepositorySha = "not-a-sha";
      },
    ],
  ])("rejects a staging handoff with %s", async (_case, mutate) => {
    const root = temporaryRoot();
    const manifest = stagingManifest();
    mutate(manifest);
    const fixture = createFixture(root, vi.fn(handoffCommand(root, manifest)));

    await expect(fixture.resolveLatestStagingHandoff()).rejects.toThrow(
      "latest staging image handoff is invalid",
    );
  });

  it("accepts the runtime identity from the staging handoff", async () => {
    const root = temporaryRoot();
    const credentialHome = path.join(root, "brev-home");
    vi.stubEnv("HOME", credentialHome);
    const expected = stagingHandoff();
    const identity = runtimeIdentity(expected);
    const command = vi.fn(ownedExecCommand(`probe\n${JSON.stringify(identity)}`));
    const fixture = createFixture(root, command);

    await expect(fixture.verifyIdentity(recordedOwnership(), expected)).resolves.toEqual(identity);
    expect(command.mock.calls.find((call) => call[1][0] === "exec")?.[2]?.env).toEqual({
      HOME: credentialHome,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "brev-runtime-identity.json"), "utf8")),
    ).toEqual(identity);
  });

  it.each([
    ["a different boot image", { bootImage: "projects/fixture/global/images/replacement" }],
    ["a different repository commit", { repoSha: "c".repeat(40) }],
    ["a modified repository", { repoClean: false }],
    ["runtime overrides", { runtimeOverrides: true }],
  ] satisfies Array<[string, Partial<BrevRuntimeIdentity>]>)(
    "rejects runtime identity with %s",
    async (_case, override) => {
      const root = temporaryRoot();
      const expected = stagingHandoff();
      const identity = runtimeIdentity(expected, override);
      const fixture = createFixture(root, vi.fn(ownedExecCommand(JSON.stringify(identity))));

      await expect(fixture.verifyIdentity(recordedOwnership(), expected)).rejects.toThrow(
        "standing Launchable runtime identity does not match the staging handoff",
      );
      expect(fs.existsSync(path.join(root, "brev-runtime-identity.json"))).toBe(false);
    },
  );

  it("creates, verifies, and deletes the same workspace identity", async () => {
    const root = temporaryRoot();
    const credentialHome = path.join(root, "brev-home");
    vi.stubEnv("HOME", credentialHome);
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
    expect(command.mock.calls.filter((call) => call[1][0] === "delete")).toEqual([
      ["brev", ["delete", "workspace-id"], expect.any(Object)],
    ]);
    expect(command.mock.calls.find((call) => call[1][0] === "create")?.[2]?.env).toEqual({
      HOME: credentialHome,
    });
    expect(command.mock.calls.find((call) => call[1][0] === "delete")?.[2]?.env).toEqual({
      HOME: credentialHome,
    });
    expect(command.mock.calls.every((call) => call[2]?.env?.HOME === credentialHome)).toBe(true);
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

  it("rejects a malformed workspace inventory before creation", async () => {
    const root = temporaryRoot();
    const command = vi.fn(async () => result({ status: "ok" }));
    const fixture = createFixture(root, command);

    await expect(
      fixture.create(fixture.ownership("fixture-workspace"), "env-fixture123"),
    ).rejects.toThrow("Brev workspace inventory has unexpected shape");
    expect(command.mock.calls.flat().some((value) => value === "create")).toBe(false);
  });

  it("does not confirm cleanup from a malformed workspace inventory", async () => {
    const root = temporaryRoot();
    const command = vi.fn(async () => result({ status: "ok" }));
    const fixture = createFixture(root, command);

    await expect(fixture.delete(recordedOwnership(), 100)).rejects.toThrow(
      "Brev workspace inventory has unexpected shape",
    );
    expect(command.mock.calls.flat().some((value) => value === "delete")).toBe(false);
    expect(fs.existsSync(path.join(root, "brev-workspace-cleanup.json"))).toBe(false);
  });

  it.each([
    ["create command", "create"],
    ["first readiness inventory", "readiness-list"],
  ] as const)("reconciles the created workspace when the %s fails", async (_case, failure) => {
    const root = temporaryRoot();
    const command = vi.fn(ambiguousCreateCommand({ failure }));
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await expect(fixture.create(ownership, "env-fixture123")).rejects.toThrow(
      failure === "create" ? "create staging Brev workspace failed" : "list Brev workspaces failed",
    );
    expect(ownership.id).toBeUndefined();

    await expect(fixture.delete(ownership, 2_000)).resolves.toBeUndefined();
    expect(ownership.id).toBe("owned-id");
    expect(command.mock.calls.filter((call) => call[1][0] === "delete")).toEqual([
      ["brev", ["delete", "owned-id"], expect.any(Object)],
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "brev-workspace-cleanup.json"), "utf8")),
    ).toMatchObject({ status: "ABSENT", workspaceId: "owned-id" });
  });

  it("refuses a replacement after cleanup reconciles the created workspace ID", async () => {
    const root = temporaryRoot();
    const command = vi.fn(
      ambiguousCreateCommand({ failure: "create", replaceAfterReconciliation: true }),
    );
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await expect(fixture.create(ownership, "env-fixture123")).rejects.toThrow(
      "create staging Brev workspace failed",
    );
    await expect(fixture.delete(ownership, 2_000)).rejects.toThrow(
      "Brev workspace identity changed before cleanup",
    );

    expect(ownership.id).toBe("owned-id");
    expect(command.mock.calls.flat().some((value) => value === "delete")).toBe(false);
  });

  it("does not treat repeated cleanup inventory failures as workspace absence", async () => {
    const root = temporaryRoot();
    const command = vi.fn(
      ambiguousCreateCommand({ failure: "create", failCleanupInventory: true }),
    );
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await expect(fixture.create(ownership, "env-fixture123")).rejects.toThrow(
      "create staging Brev workspace failed",
    );
    await expect(fixture.delete(ownership, 50)).rejects.toThrow(
      "Brev workspace identity reconciliation failed",
    );

    expect(command.mock.calls.flat().some((value) => value === "delete")).toBe(false);
    expect(fs.existsSync(path.join(root, "brev-workspace-cleanup.json"))).toBe(false);
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

  it("refuses a replacement during workspace readiness", async () => {
    const root = temporaryRoot();
    const readiness = replacementDuringReadinessCommand();
    const command = vi.fn(readiness.command);
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await expect(fixture.create(ownership, "env-fixture123")).rejects.toThrow(
      "Brev workspace identity changed during readiness",
    );
    expect(ownership.id).toBe("owned-id");
  });

  it("refuses a replacement before Brev exec readiness without executing on it", async () => {
    const root = temporaryRoot();
    const lifecycle = replaceableWorkspaceCommand();
    const command = vi.fn(lifecycle.command);
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await fixture.create(ownership, "env-fixture123");
    lifecycle.replace();

    await expect(fixture.waitForExec(ownership, 100)).rejects.toThrow(
      "Brev workspace identity changed before Brev exec",
    );
    expect(command.mock.calls.filter((call) => call[1][0] === "exec")).toHaveLength(0);
  });

  it("refuses a replacement before identity verification without executing on it", async () => {
    const root = temporaryRoot();
    const lifecycle = replaceableWorkspaceCommand();
    const command = vi.fn(lifecycle.command);
    const fixture = createFixture(root, command);
    const ownership = fixture.ownership("fixture-workspace");

    await fixture.create(ownership, "env-fixture123");
    lifecycle.replace();

    await expect(fixture.verifyIdentity(ownership, stagingHandoff())).rejects.toThrow(
      "Brev workspace identity changed before Brev exec",
    );
    expect(command.mock.calls.filter((call) => call[1][0] === "exec")).toHaveLength(0);
  });

  it("binds exec to the owned ID when a replacement appears after the final list", async () => {
    const root = temporaryRoot();
    let currentId = "owned-id";
    const protectedTargets: string[] = [];
    const command = vi.fn(async (_binary: string, args: string[]) => {
      switch (args[0]) {
        case "ls":
          return workspaceResult(currentId);
        case "exec": {
          currentId = "replacement-id";
          const requested = args[1] ?? "";
          const resolved = requested === "fixture-workspace" ? currentId : requested;
          protectedTargets.push(resolved);
          expect(resolved).not.toBe(currentId);
          return result("");
        }
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });
    const fixture = createFixture(root, command);

    await expect(
      fixture.execScript(recordedOwnership(), "echo credential-bearing operation", {
        artifactName: "fixture-script",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(protectedTargets).toEqual(["owned-id"]);
    expect(command.mock.calls.find((call) => call[1][0] === "exec")?.[1][1]).toBe("owned-id");
  });

  it("binds deletion to the owned ID when a replacement appears after the final list", async () => {
    const root = temporaryRoot();
    let currentId = "owned-id";
    const protectedTargets: string[] = [];
    const command = vi.fn(async (_binary: string, args: string[]) => {
      switch (args[0]) {
        case "ls":
          return workspaceResult(currentId);
        case "delete": {
          currentId = "replacement-id";
          const requested = args[1] ?? "";
          const resolved = requested === "fixture-workspace" ? currentId : requested;
          protectedTargets.push(resolved);
          expect(resolved).not.toBe(currentId);
          return result("");
        }
        case "refresh":
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });
    const fixture = createFixture(root, command);

    await expect(fixture.delete(recordedOwnership(), 2_000)).resolves.toBeUndefined();

    expect(protectedTargets).toEqual(["owned-id"]);
    expect(command.mock.calls.find((call) => call[1][0] === "delete")?.[1][1]).toBe("owned-id");
  });

  it("removes the private local script after Brev exec returns", async () => {
    const root = temporaryRoot();
    const credentialHome = path.join(root, "brev-home");
    vi.stubEnv("HOME", credentialHome);
    let observedScript = "";
    const command = vi.fn(
      async (_binary: string, args: string[], options?: ShellProbeRunOptions) => {
        switch (args[0]) {
          case "ls":
            return workspaceResult("owned-id");
          case "exec": {
            expect(options?.env).toEqual({ FIXTURE_VALUE: "fixture", HOME: credentialHome });
            observedScript = args[2]?.slice(1) ?? "";
            const descriptor = fs.openSync(observedScript, "r");
            try {
              expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
              expect(fs.readFileSync(descriptor, "utf8")).toContain("fixture script");
            } finally {
              fs.closeSync(descriptor);
            }
            return result("");
          }
          default:
            throw new Error(`unexpected command: ${args.join(" ")}`);
        }
      },
    );
    const fixture = createFixture(root, command);

    await fixture.execScript(recordedOwnership(), "echo fixture script", {
      artifactName: "fixture-script",
      env: { FIXTURE_VALUE: "fixture", HOME: "ignored" },
    });

    expect(observedScript).not.toBe("");
    expect(fs.existsSync(observedScript)).toBe(false);
    expect(fs.existsSync(path.dirname(observedScript))).toBe(false);
  });

  it("rejects Brev controller construction without a process HOME", () => {
    const root = temporaryRoot();
    vi.stubEnv("HOME", "");

    expect(() => createFixture(root, vi.fn())).toThrow("HOME is required for Brev credentials");
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

function stagingHandoff(): StagingHandoff {
  return {
    producerRunId: "123",
    bootImage: "projects/fixture-project/global/images/nemoclaw-fixture",
    nemoclawSha: "a".repeat(40),
    imageRepositorySha: "b".repeat(40),
  };
}

function stagingManifest(): Record<string, unknown> {
  const handoff = stagingHandoff();
  return {
    schemaVersion: 1,
    kind: "nemoclaw-exact-image-manifest",
    imageRepository: "brevdev/nemoclaw-image",
    producerWorkflow: ".github/workflows/build-launchable-e2e-image.yml",
    workflowRunId: 123,
    workflowRunAttempt: 1,
    status: "READY",
    channel: "staging",
    variant: "cpu",
    observedFamily: "nemoclaw-brev-staging-cpu",
    project: "fixture-project",
    imageName: "nemoclaw-fixture",
    nemoclawSha: handoff.nemoclawSha,
    imageRepositorySha: handoff.imageRepositorySha,
  };
}

function recordedOwnership(): BrevWorkspaceOwnership {
  return {
    name: "fixture-workspace",
    createRequested: true,
    accepted: true,
    id: "owned-id",
  };
}

function ownedExecCommand(
  stdout: string,
): (_binary: string, args: string[], _options?: ShellProbeRunOptions) => Promise<ShellProbeResult> {
  return async (_binary, args, _options) => {
    switch (args[0]) {
      case "ls":
        return workspaceResult("owned-id");
      case "exec":
        return result(stdout);
      default:
        throw new Error(`unexpected command: ${args.join(" ")}`);
    }
  };
}

function handoffCommand(
  root: string,
  manifest: Record<string, unknown>,
): (_binary: string, args: string[], _options?: ShellProbeRunOptions) => Promise<ShellProbeResult> {
  return async (_binary, args, _options) => {
    switch (args[0]) {
      case "api":
        return result({
          workflow_runs: [
            {
              id: 123,
              created_at: "2026-08-23T00:00:00Z",
              display_title: "Build Launchable E2E image for NemoClaw fixture",
            },
          ],
        });
      case "run":
        switch (args[1]) {
          case "download":
            fs.writeFileSync(
              path.join(root, "staging-handoff", "nemoclaw-image-manifest.v1.json"),
              JSON.stringify(manifest),
            );
            return result("");
          default:
            break;
        }
        break;
      default:
        break;
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
}

function runtimeIdentity(
  handoff: StagingHandoff,
  override: Partial<BrevRuntimeIdentity> = {},
): BrevRuntimeIdentity {
  return {
    sourceRepository: "NVIDIA/NemoClaw",
    sourcePath: "/opt/nemoclaw-image/NemoClaw",
    provisionSha: handoff.nemoclawSha,
    repoSha: handoff.nemoclawSha,
    imageRepositorySha: handoff.imageRepositorySha,
    bootImage: handoff.bootImage,
    repoClean: true,
    runtimeOverrides: false,
    ...override,
  };
}

function lifecycleCommand(): {
  command: (
    _binary: string,
    args: string[],
    _options?: ShellProbeRunOptions,
  ) => Promise<ShellProbeResult>;
  absentReads: () => number;
} {
  let present = false;
  let absent = 0;
  return {
    absentReads: () => absent,
    async command(_binary, args, _options) {
      switch (args[0]) {
        case "ls": {
          const response = present ? workspaceResult("workspace-id") : result({ workspaces: [] });
          absent += present ? 0 : 1;
          return response;
        }
        case "create":
          present = true;
          return result("");
        case "delete":
          present = false;
          return result("");
        case "refresh":
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    },
  };
}

function ambiguousCreateCommand(options: {
  failCleanupInventory?: boolean;
  failure: "create" | "readiness-list";
  replaceAfterReconciliation?: boolean;
}): (_binary: string, args: string[]) => Promise<ShellProbeResult> {
  let created = false;
  let deleted = false;
  let firstInventoryAfterCreate = true;
  let observedOwnedIdentity = false;
  return async (_binary, args) => {
    switch (args[0]) {
      case "ls": {
        switch (true) {
          case !created || deleted:
            return result({ workspaces: [] });
          case options.failCleanupInventory ||
            (options.failure === "readiness-list" && firstInventoryAfterCreate):
            firstInventoryAfterCreate = false;
            return { ...result("inventory unavailable"), exitCode: 17 };
          case options.replaceAfterReconciliation && observedOwnedIdentity:
            return workspaceResult("replacement-id");
          default:
            firstInventoryAfterCreate = false;
            observedOwnedIdentity = true;
            return workspaceResult("owned-id");
        }
      }
      case "create":
        created = true;
        return options.failure === "create"
          ? { ...result("create outcome unavailable"), exitCode: 17 }
          : result("");
      case "delete":
        deleted = true;
        return result("");
      case "refresh":
        return result("");
      default:
        throw new Error(`unexpected command: ${args.join(" ")}`);
    }
  };
}

function failingReadinessCommand(): {
  command: (_binary: string, args: string[]) => Promise<ShellProbeResult>;
  replace(): void;
} {
  let id = "owned-id";
  let created = false;
  return {
    replace() {
      id = "replacement-id";
    },
    async command(_binary, args) {
      switch (args[0]) {
        case "ls": {
          const missing = result({ workspaces: [] });
          const record = JSON.parse(workspaceResult(id).stdout) as {
            workspaces: Array<Record<string, unknown>>;
          };
          record.workspaces[0]!.status = "FAILED";
          return created ? result(record) : missing;
        }
        case "create":
          created = true;
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    },
  };
}

function replacementDuringReadinessCommand(): {
  command: (_binary: string, args: string[]) => Promise<ShellProbeResult>;
} {
  let created = false;
  let readinessPolls = 0;
  const records = [
    {
      name: "fixture-workspace",
      id: "owned-id",
      status: "CREATING",
      build_status: "PENDING",
      shell_status: "PENDING",
    },
    {
      name: "fixture-workspace",
      id: "replacement-id",
      status: "RUNNING",
      build_status: "COMPLETED",
      shell_status: "READY",
    },
  ];
  return {
    async command(_binary, args) {
      switch (args[0]) {
        case "ls":
          return created
            ? result({
                workspaces: [records[Math.min(readinessPolls++, records.length - 1)]],
              })
            : result({ workspaces: [] });
        case "create":
          created = true;
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    },
  };
}

function replaceableWorkspaceCommand(): {
  command: (_binary: string, args: string[]) => Promise<ShellProbeResult>;
  replace(): void;
} {
  let created = false;
  let replaced = false;
  return {
    replace() {
      replaced = true;
    },
    async command(_binary, args) {
      switch (args[0]) {
        case "ls":
          return created
            ? workspaceResult(replaced ? "replacement-id" : "owned-id")
            : result({ workspaces: [] });
        case "create":
          created = true;
          return result("");
        case "exec":
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    },
  };
}

function workspaceResult(id: string): ShellProbeResult {
  return result({
    workspaces: [
      {
        name: "fixture-workspace",
        id,
        status: "RUNNING",
        build_status: "COMPLETED",
        shell_status: "READY",
      },
    ],
  });
}

function result(stdout: string | unknown): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}
