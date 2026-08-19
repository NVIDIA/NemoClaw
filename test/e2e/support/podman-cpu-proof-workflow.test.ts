// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parsePortableCpuDelegationProofMode,
  PORTABLE_CPU_DELEGATION_PROOF_CONTRACT,
  portableCpuDelegationProofCli,
  type CommandOptions,
  type CommandResult,
  type HostCommandRunner,
  type HostFilesystem,
  type HostPathStat,
  type PortableCpuDelegationProofMode,
  runPortableCpuDelegationProofMode,
} from "../../../scripts/checks/run-portable-cpu-delegation-proof.mts";
import { PORTABLE_HOST_GATEWAY_IP } from "../../../src/lib/onboard/experimental/portable-profile.ts";
import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

const APP_DROP_IN = PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.appSliceDropIn;
const DELEGATION_DROP_IN = PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.delegationDropIn;
const USER_SLICE_DROP_IN = `/etc/systemd/system/user-1001.slice.d/${PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.userSliceDropInName}`;

type PodmanProofWorkflow = Workflow & {
  on: { pull_request: { paths: string[]; types: string[] } };
  permissions: Record<string, string>;
};

function workflow(): PodmanProofWorkflow {
  return readYaml(".github/workflows/podman-cpu-proof.yaml") as PodmanProofWorkflow;
}

function proofJob(): WorkflowJob {
  const job = workflow().jobs["podman-cpu-lifecycle"];
  expect(job).toBeDefined();
  return job!;
}

function delegationJob(): WorkflowJob {
  const job = workflow().jobs["portable-cpu-delegation"];
  expect(job).toBeDefined();
  return job!;
}

function namedStep(name: string): WorkflowStep {
  const step = proofJob().steps?.find((candidate) => candidate.name === name);
  expect(step, `missing Podman CPU proof step '${name}'`).toBeDefined();
  return step!;
}
function namedDelegationStep(name: string): WorkflowStep {
  const step = delegationJob().steps?.find((candidate) => candidate.name === name);
  expect(step, `missing CPU delegation proof step '${name}'`).toBeDefined();
  return step!;
}
type RecordedCommand = {
  readonly argv: readonly string[];
  readonly executable: string;
  readonly options: CommandOptions;
};
class ProofFixtureRunner implements HostCommandRunner {
  readonly calls: RecordedCommand[] = [];
  readonly contents = new Map<string, string>();
  readonly directories = new Set([path.dirname(DELEGATION_DROP_IN), path.dirname(APP_DROP_IN)]);
  readonly envAtCreate = new Map<string, string>();
  readonly files = new Set<string>();
  readonly identities = new Map<string, string>();
  readonly ownerModes = new Map<string, string>();
  failIdentityFor = "";
  failMoveFor = "";
  failRemovalFor = "";
  failRemovalPrefix = "";
  failTestFor = "";
  failTee = false;
  failUserLookup = false;
  failWorkspaceModeRestore = false;
  managerStartDiagnostic = "";
  managerStartFailures = 0;
  userCreated = false;
  constructor(
    readonly home: string,
    readonly githubEnv: string,
  ) {}
  seedFile(target: string, id = "1:1"): void {
    this.files.add(target);
    this.identities.set(target, id);
  }
  hasResource(target: string): boolean {
    return this.files.has(target) || this.directories.has(target);
  }
  private ok(stdout = ""): CommandResult {
    return { status: 0, stdout, stderr: "" };
  }
  private failed(stderr = "fixture failure"): CommandResult {
    return { status: 1, stdout: "", stderr };
  }
  private identityFor(target: string): string {
    const value = this.identities.get(target) ?? `1:${String(this.identities.size + 1)}`;
    this.identities.set(target, value);
    return value;
  }
  private stat(argv: readonly string[], target: string): CommandResult {
    const fail = target === this.failIdentityFor;
    this.failIdentityFor = fail ? "" : this.failIdentityFor;
    return fail
      ? this.failed("identity fixture failure")
      : argv[2] === "%U:%G %a"
        ? this.ok(`${this.ownerModes.get(target) ?? "root:root 755"}\n`)
        : this.ok(`${this.identityFor(target)}\n`);
  }
  private move(source: string, target: string): CommandResult {
    this.seedFile(target, this.identityFor(source));
    this.files.delete(source);
    this.contents.set(target, this.contents.get(source) ?? "");
    this.contents.delete(source);
    return this.ok();
  }
  private tee(target: string, options: CommandOptions): CommandResult {
    this.seedFile(target);
    this.contents.set(target, options.input ?? "");
    return this.ok(options.input ?? "");
  }
  private remove(target: string): CommandResult {
    for (const file of this.files) file.startsWith(`${target}/`) ? this.files.delete(file) : false;
    this.files.delete(target);
    this.directories.delete(target);
    this.ownerModes.delete(target);
    return this.ok();
  }
  private test(argv: readonly string[]): CommandResult {
    const flag = argv[0];
    const target = argv.at(-1) ?? "";
    const present = this.files.has(target) || this.directories.has(target);
    const result =
      flag === "-L"
        ? false
        : flag === "-d"
          ? this.directories.has(target)
          : flag === "-f"
            ? this.files.has(target)
            : flag === "-e"
              ? present
              : true;
    return target === this.failTestFor
      ? this.failed("sudo test fixture failure")
      : result
        ? this.ok()
        : this.failed("");
  }
  private sudo(argv: readonly string[], options: CommandOptions): CommandResult {
    const operation = argv[0];
    const target = argv.at(-1) ?? "";
    switch (operation) {
      case "test":
        return this.test(argv.slice(1));
      case "stat":
        return this.stat(argv, target);
      case "mkdir":
        this.directories.add(target);
        this.envAtCreate.set(target, fs.readFileSync(this.githubEnv, "utf8"));
        this.ownerModes.set(
          target,
          `root:root ${Number.parseInt(argv[2] ?? "755", 8).toString(8)}`,
        );
        return this.ok();
      case "mv": {
        const source = argv.at(-2) ?? "";
        return target === this.failMoveFor
          ? this.failed("move fixture failure")
          : this.move(source, target);
      }
      case "rm":
        return target === this.failRemovalFor ||
          (this.failRemovalPrefix !== "" && target.startsWith(this.failRemovalPrefix))
          ? this.failed("removal fixture failure")
          : this.remove(target);
      case "rmdir":
        return [...this.files, ...this.directories].some(
          (entry) => entry !== target && entry.startsWith(`${target}/`),
        )
          ? this.failed("directory not empty")
          : target === this.failRemovalFor
            ? this.failed("removal fixture failure")
            : this.remove(target);
      case "tee":
        return this.failTee ? this.failed("tee fixture failure") : this.tee(target, options);
      case "cat":
        return this.ok(this.contents.get(target) ?? "");
      case "grep":
        return (this.contents.get(target) ?? "").includes(argv[2] ?? "")
          ? this.ok()
          : this.failed();
      case "useradd":
        this.userCreated = true;
        return this.ok();
      case "userdel":
        this.userCreated = false;
        return this.ok();
      case "systemctl":
        switch (argv[1]) {
          case "start": {
            const failStart = this.managerStartFailures > 0;
            this.managerStartFailures -= Number(failStart);
            return failStart ? this.failed(this.managerStartDiagnostic) : this.ok();
          }
          case "status":
            return this.failed(this.managerStartDiagnostic);
          default:
            return this.ok();
        }
      case "journalctl":
        return this.ok(this.managerStartDiagnostic);
      case "chmod":
        return this.failWorkspaceModeRestore && argv[1] !== "0600" && argv[1] !== "0644"
          ? this.failed()
          : this.ok();
      default:
        return this.ok();
    }
  }
  run(executable: string, argv: readonly string[], options: CommandOptions = {}): CommandResult {
    this.calls.push({ executable, argv: [...argv], options });
    switch (executable) {
      case "sudo":
        return argv[0] === "--user" ? this.ok() : this.sudo(argv, options);
      case "id":
        return argv[0] === "-u" ? this.ok("1001\n") : this.userCreated ? this.ok() : this.failed();
      case "getent":
        return this.failUserLookup
          ? this.failed("getent fixture failure")
          : this.userCreated
            ? this.ok(`nemoclaw-e2e:x:1001:1001:nemoclaw-cpu-proof-7-1:${this.home}:/bin/bash\n`)
            : { status: 2, stdout: "", stderr: "" };
      case "stat":
        return this.ok("755\n");
      case "python3":
        return this.ok(options.input ?? "");
      default:
        return this.ok();
    }
  }
}
type RecordedFilesystemCall = {
  readonly operation: string;
  readonly target: string;
};
class ProofFixtureFilesystem implements HostFilesystem {
  readonly calls: RecordedFilesystemCall[] = [];
  readonly envAtCreate = new Map<string, string>();
  failLstatOnceFor = "";
  lstatSuccessesBeforeFailure = 0;
  failWriteTarget = "";
  constructor(readonly githubEnv: string) {}
  private lstatFailure(target: string): never {
    throw Object.assign(new Error(`lstat fixture failure: ${target}`), { code: "EIO" });
  }
  private publishConcurrentMarker(target: string): never {
    fs.writeFileSync(target, "concurrent\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    throw new Error("filesystem fixture write failure");
  }
  appendText(target: string, content: string): void {
    this.calls.push({ operation: "appendText", target });
    fs.appendFileSync(target, content, { encoding: "utf8" });
  }
  exists(target: string): boolean {
    this.calls.push({ operation: "exists", target });
    return fs.existsSync(target);
  }
  lstat(target: string): HostPathStat {
    this.calls.push({ operation: "lstat", target });
    const matches = target === this.failLstatOnceFor;
    const fail = matches && this.lstatSuccessesBeforeFailure === 0;
    this.failLstatOnceFor = fail ? "" : this.failLstatOnceFor;
    this.lstatSuccessesBeforeFailure = matches
      ? Math.max(0, this.lstatSuccessesBeforeFailure - 1)
      : this.lstatSuccessesBeforeFailure;
    return fail ? this.lstatFailure(target) : fs.lstatSync(target);
  }
  makeDirectory(
    target: string,
    options: { readonly mode: number; readonly recursive: boolean },
  ): void {
    this.calls.push({ operation: "makeDirectory", target });
    fs.mkdirSync(target, options);
    this.envAtCreate.set(target, fs.readFileSync(this.githubEnv, "utf8"));
  }
  readText(target: string): string {
    this.calls.push({ operation: "readText", target });
    return fs.readFileSync(target, "utf8");
  }
  removeDirectory(target: string): void {
    this.calls.push({ operation: "removeDirectory", target });
    fs.rmdirSync(target);
  }
  removeFile(target: string): void {
    this.calls.push({ operation: "removeFile", target });
    fs.unlinkSync(target);
  }
  writeExclusive(target: string, content: string): void {
    this.calls.push({ operation: "writeExclusive", target });
    return target === this.failWriteTarget
      ? this.publishConcurrentMarker(target)
      : fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
}
function createProofFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cpu-proof-script-"));
  const workspace = path.join(directory, "workspace");
  const runnerTemp = path.join(directory, "runner-temp");
  const home = path.join(directory, "home");
  fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    E2E_ARTIFACT_DIR: path.join(workspace, "e2e-artifacts", "portable-cpu-delegation"),
    E2E_CPU_DELEGATION_USER: "nemoclaw-e2e",
    E2E_SOURCE_REVISION: "a".repeat(40),
    E2E_TARGET_ID: "portable-cpu-delegation",
    GITHUB_ENV: path.join(directory, "github-env"),
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "7",
    GITHUB_WORKSPACE: workspace,
    NEMOCLAW_RUN_LIVE_E2E: "1",
    PATH: process.env.PATH,
    RUNNER_TEMP: runnerTemp,
  };
  fs.writeFileSync(env.GITHUB_ENV!, "", { mode: 0o600 });
  return {
    directory,
    env,
    filesystem: new ProofFixtureFilesystem(env.GITHUB_ENV!),
    randomId: () => "00000000-0000-4000-8000-000000000000",
    runner: new ProofFixtureRunner(home, env.GITHUB_ENV!),
  };
}
type ProofFixture = ReturnType<typeof createProofFixture>;
function loadGithubEnv(fixture: ProofFixture): void {
  const records = fs.readFileSync(fixture.env.GITHUB_ENV!, "utf8").split("\n").filter(Boolean);
  for (const record of records) {
    const separator = record.indexOf("=");
    fixture.env[record.slice(0, separator)] = record.slice(separator + 1);
  }
}
function withProofFixture(run: (fixture: ProofFixture) => void): void {
  const fixture = createProofFixture();
  try {
    run(fixture);
  } finally {
    fs.rmSync(fixture.directory, { force: true, recursive: true });
  }
}
describe("native Podman CPU proof workflow", () => {
  it("selects the rootless proof when the Portable gateway authority changes (#9587)", () => {
    const authorityPath = "src/lib/onboard/experimental/portable-profile.ts";
    const selectedPath = workflow().on.pull_request.paths.find(
      (candidate) => candidate === authorityPath,
    );

    expect(selectedPath).toBe(authorityPath);
  });

  it("executes the five typed proof modes with exact argv and durable cleanup receipts (#9188)", () => {
    withProofFixture((fixture) => {
      const modes: readonly PortableCpuDelegationProofMode[] = [
        "prepare",
        "reject",
        "admit",
        "diagnostics",
        "cleanup",
      ];
      expect(modes.map((mode) => parsePortableCpuDelegationProofMode([mode]))).toEqual(modes);
      runPortableCpuDelegationProofMode("prepare", fixture);
      loadGithubEnv(fixture);
      runPortableCpuDelegationProofMode("reject", fixture);
      runPortableCpuDelegationProofMode("admit", fixture);
      runPortableCpuDelegationProofMode("diagnostics", fixture);
      runPortableCpuDelegationProofMode("cleanup", fixture);
      const proofStates = fixture.runner.calls
        .flatMap((call) => call.argv)
        .filter((argument) => argument.startsWith("E2E_CPU_DELEGATION_STATE="));
      expect(proofStates).toEqual([
        "E2E_CPU_DELEGATION_STATE=missing",
        "E2E_CPU_DELEGATION_STATE=delegated",
      ]);
      expect(fixture.runner.calls).toContainEqual(
        expect.objectContaining({
          executable: "sudo",
          argv: expect.arrayContaining(["systemctl", "daemon-reload"]),
        }),
      );
      expect(
        fixture.runner.calls.every(
          ({ executable, argv, options }) =>
            !(["bash", "sh"].includes(executable) && argv.includes("-c")) && !("shell" in options),
        ),
      ).toBe(true);
      expect(fixture.runner.files.has(DELEGATION_DROP_IN)).toBe(false);
      expect(fixture.runner.files.has(APP_DROP_IN)).toBe(false);
      expect(fixture.runner.files.has(USER_SLICE_DROP_IN)).toBe(false);
      expect(fs.existsSync(fixture.env.E2E_WORKSPACE_TRAVERSE_MARKER!)).toBe(false);
      expect(fixture.runner.userCreated).toBe(false);
      expect(fixture.filesystem.calls.map(({ operation }) => operation)).toEqual(
        expect.arrayContaining([
          "appendText",
          "exists",
          "lstat",
          "readText",
          "removeDirectory",
          "removeFile",
          "writeExclusive",
        ]),
      );
      expect(
        fixture.filesystem.calls.every(
          ({ target }) =>
            target === fixture.env.GITHUB_ENV ||
            target.startsWith(fixture.env.GITHUB_WORKSPACE!) ||
            target.startsWith(fixture.env.RUNNER_TEMP!),
        ),
      ).toBe(true);
    });
  });
  it.each([
    ["219/CGROUP", false, 1],
    ["status=1/FAILURE", true, 0],
  ] as const)(
    "opens a later login only for an immediate %s manager-start failure (#9188)",
    (diagnostic, shouldThrow, expectedLoginCount) => {
      withProofFixture((fixture) => {
        runPortableCpuDelegationProofMode("prepare", fixture);
        loadGithubEnv(fixture);
        fixture.runner.managerStartDiagnostic = diagnostic;
        fixture.runner.managerStartFailures = 1;
        const outcome = (() => {
          try {
            runPortableCpuDelegationProofMode("admit", fixture);
            return "";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        })();
        expect(outcome === "").toBe(!shouldThrow);
        expect(outcome).toMatch(shouldThrow ? /failed without 219\/CGROUP/u : /^$/u);
        expect(
          fixture.runner.calls.filter(({ argv }) => argv[0] === "--login" && argv[1] === "--user"),
        ).toHaveLength(expectedLoginCount);
      });
    },
  );
  it("preserves identity and workspace-mode receipts when cleanup is incomplete (#9188)", () => {
    withProofFixture((fixture) => {
      const delegationMarker = path.join(
        fixture.env.RUNNER_TEMP!,
        "nemoclaw-cpu-delegation-drop-in-created",
      );
      const workspaceMarker = path.join(
        fixture.env.RUNNER_TEMP!,
        "nemoclaw-workspace-traverse-modes",
      );
      fs.writeFileSync(delegationMarker, "1:1\n", { mode: 0o600 });
      fs.writeFileSync(workspaceMarker, "755\t/checkout-parent\n", { mode: 0o600 });
      fixture.runner.seedFile(DELEGATION_DROP_IN, "2:2");
      fixture.runner.failWorkspaceModeRestore = true;
      expect(() => runPortableCpuDelegationProofMode("cleanup", fixture)).toThrow(
        /cleanup was incomplete/u,
      );
      expect(fs.readFileSync(delegationMarker, "utf8")).toBe("1:1\n");
      expect(fs.readFileSync(workspaceMarker, "utf8")).toBe("755\t/checkout-parent\n");
      expect(fixture.runner.files.has(DELEGATION_DROP_IN)).toBe(true);
    });
  });
  it("preserves a retry receipt when a cleanup predicate command fails (#9188)", () => {
    withProofFixture((fixture) => {
      const target = DELEGATION_DROP_IN;
      const marker = path.join(fixture.env.RUNNER_TEMP!, "nemoclaw-cpu-delegation-drop-in-created");
      fs.writeFileSync(marker, "1:1\n", { mode: 0o600 });
      fixture.runner.seedFile(target, "1:1");
      fixture.runner.failTestFor = target;
      fixture.env.E2E_CPU_DELEGATION_DROP_IN_CREATED = "1";
      expect(() => runPortableCpuDelegationProofMode("cleanup", fixture)).toThrow(
        /sudo test fixture failure/u,
      );
      expect(fs.readFileSync(marker, "utf8")).toBe("1:1\n");
      expect(fixture.runner.files.has(target)).toBe(true);
    });
  });
  it("preserves the user claim when account inspection fails during cleanup (#9188)", () => {
    withProofFixture((fixture) => {
      runPortableCpuDelegationProofMode("prepare", fixture);
      loadGithubEnv(fixture);
      fixture.runner.failUserLookup = true;
      expect(() => runPortableCpuDelegationProofMode("cleanup", fixture)).toThrow(
        /getent passwd nemoclaw-e2e failed/u,
      );
      expect(fixture.env.E2E_CPU_DELEGATION_USER_CLAIMED).toBe("1");
      expect(fixture.runner.userCreated).toBe(true);
    });
  });
  it("records every unrecorded intent before its exact create command (#9188)", () => {
    withProofFixture((fixture) => {
      fixture.runner.directories.delete(path.dirname(APP_DROP_IN));
      fixture.runner.directories.delete(path.dirname(DELEGATION_DROP_IN));
      runPortableCpuDelegationProofMode("prepare", fixture);
      loadGithubEnv(fixture);
      const parent = path.join(fixture.env.GITHUB_WORKSPACE!, "node_modules/.cache");
      const cache = path.join(parent, "nemoclaw-source-require");
      const appTemp = fixture.env.E2E_APP_SLICE_DROP_IN_TEMP!;
      const delegationTemp = fixture.env.E2E_CPU_DELEGATION_DROP_IN_TEMP!;
      const userSliceTemp = fixture.env.E2E_USER_SLICE_DROP_IN_TEMP!;
      const records = [
        [fixture.filesystem.envAtCreate.get(parent), "E2E_SOURCE_CACHE_PARENT_CREATED"],
        [fixture.runner.envAtCreate.get(cache), "E2E_SOURCE_CACHE_CREATED"],
        [
          fixture.runner.envAtCreate.get(path.dirname(APP_DROP_IN)),
          "E2E_APP_SLICE_DROP_IN_DIR_CREATED",
        ],
        [
          fixture.runner.envAtCreate.get(path.dirname(DELEGATION_DROP_IN)),
          "E2E_CPU_DELEGATION_DROP_IN_DIR_CREATED",
        ],
        [
          fixture.runner.envAtCreate.get(path.dirname(USER_SLICE_DROP_IN)),
          "E2E_USER_SLICE_DROP_IN_DIR_CREATED",
        ],
        [fixture.runner.envAtCreate.get(appTemp), "E2E_APP_SLICE_DROP_IN_TEMP_CREATED"],
        [fixture.runner.envAtCreate.get(delegationTemp), "E2E_CPU_DELEGATION_DROP_IN_TEMP_CREATED"],
        [fixture.runner.envAtCreate.get(userSliceTemp), "E2E_USER_SLICE_DROP_IN_TEMP_CREATED"],
      ] as const;
      expect(
        records.every(
          ([environment, name]) => environment?.includes(`${name}=unrecorded\n`) === true,
        ),
      ).toBe(true);
      expect(fixture.runner.envAtCreate.get(appTemp)).toContain(
        `E2E_APP_SLICE_DROP_IN_TEMP=${appTemp}\n`,
      );
      expect(fixture.runner.envAtCreate.get(delegationTemp)).toContain(
        `E2E_CPU_DELEGATION_DROP_IN_TEMP=${delegationTemp}\n`,
      );
      expect(fixture.runner.envAtCreate.get(userSliceTemp)).toContain(
        `E2E_USER_SLICE_DROP_IN_TEMP=${userSliceTemp}\n`,
      );
    });
  });
  it.each(["app", "delegation", "userSlice", "cache", "staging"] as const)(
    "rolls back an ordinary caught %s identity failure (#9188)",
    (targetName) => {
      withProofFixture((fixture) => {
        const parent = path.join(fixture.env.GITHUB_WORKSPACE!, "node_modules/.cache");
        const targets = {
          app: path.dirname(APP_DROP_IN),
          cache: path.join(parent, "nemoclaw-source-require"),
          delegation: path.dirname(DELEGATION_DROP_IN),
          userSlice: path.dirname(USER_SLICE_DROP_IN),
          staging: `${path.dirname(APP_DROP_IN)}/.nemoclaw-cpu-controller.00000000-0000-4000-8000-000000000000`,
        } as const;
        const target = targets[targetName];
        fixture.runner.directories.delete(target);
        fixture.runner.failIdentityFor = target;
        expect(() => runPortableCpuDelegationProofMode("prepare", fixture)).toThrow(
          /identity fixture failure/u,
        );
        expect(fixture.runner.hasResource(target)).toBe(false);
      });
    },
  );
  it("rolls back an ordinary caught cache-parent identity failure (#9188)", () => {
    withProofFixture((fixture) => {
      const parent = path.join(fixture.env.GITHUB_WORKSPACE!, "node_modules/.cache");
      fixture.filesystem.failLstatOnceFor = parent;
      fixture.filesystem.lstatSuccessesBeforeFailure = 1;
      expect(() => runPortableCpuDelegationProofMode("prepare", fixture)).toThrow(/lstat fixture/u);
      expect(fs.existsSync(parent)).toBe(false);
    });
  });
  it.each(["app", "delegation", "userSlice", "cache", "staging"] as const)(
    "recovers an exact %s post-create crash snapshot without an identity (#9188)",
    (targetName) => {
      withProofFixture((fixture) => {
        const parent = path.join(fixture.env.GITHUB_WORKSPACE!, "node_modules/.cache");
        const targets = {
          app: path.dirname(APP_DROP_IN),
          cache: path.join(parent, "nemoclaw-source-require"),
          delegation: path.dirname(DELEGATION_DROP_IN),
          userSlice: path.dirname(USER_SLICE_DROP_IN),
          staging: `${path.dirname(APP_DROP_IN)}/.nemoclaw-cpu-controller.00000000-0000-4000-8000-000000000000`,
        } as const;
        const receipts = {
          app: [
            "E2E_APP_SLICE_DROP_IN_DIR_CREATED",
            "E2E_APP_SLICE_DROP_IN_DIR_ID",
            "root:root 755",
            "nemoclaw-app-slice-drop-in-dir-created",
          ],
          cache: [
            "E2E_SOURCE_CACHE_CREATED",
            "E2E_SOURCE_CACHE_ID",
            "root:root 700",
            "nemoclaw-source-require-cache-created",
          ],
          delegation: [
            "E2E_CPU_DELEGATION_DROP_IN_DIR_CREATED",
            "E2E_CPU_DELEGATION_DROP_IN_DIR_ID",
            "root:root 755",
            "nemoclaw-cpu-delegation-drop-in-dir-created",
          ],
          userSlice: [
            "E2E_USER_SLICE_DROP_IN_DIR_CREATED",
            "E2E_USER_SLICE_DROP_IN_DIR_ID",
            "root:root 755",
            "nemoclaw-user-slice-drop-in-dir-created",
          ],
          staging: [
            "E2E_APP_SLICE_DROP_IN_TEMP_CREATED",
            "E2E_APP_SLICE_DROP_IN_TEMP_ID",
            "root:root 700",
            "nemoclaw-app-slice-drop-in-created",
          ],
        } as const;
        const target = targets[targetName];
        const [createdEnv, idEnv, ownerMode, markerName] = receipts[targetName];
        Object.assign(
          fixture.env,
          targetName === "userSlice"
            ? {
                E2E_CPU_DELEGATION_UID: "1001",
                E2E_USER_SLICE_DROP_IN: USER_SLICE_DROP_IN,
                E2E_USER_SLICE_DROP_IN_DIR: path.dirname(USER_SLICE_DROP_IN),
                E2E_USER_SLICE_DROP_IN_MARKER: path.join(
                  fixture.env.RUNNER_TEMP!,
                  "nemoclaw-user-slice-drop-in-created",
                ),
                E2E_USER_SLICE_DROP_IN_DIR_MARKER: path.join(
                  fixture.env.RUNNER_TEMP!,
                  "nemoclaw-user-slice-drop-in-dir-created",
                ),
              }
            : {},
        );
        fixture.env[createdEnv] = "unrecorded";
        fixture.env[idEnv] = "";
        fixture.env.E2E_APP_SLICE_DROP_IN_TEMP =
          targetName === "staging" ? target : fixture.env.E2E_APP_SLICE_DROP_IN_TEMP;
        fixture.runner.directories.add(target);
        fixture.runner.ownerModes.set(target, ownerMode);
        expect(fixture.env[idEnv]).toBe("");
        expect(fs.existsSync(path.join(fixture.env.RUNNER_TEMP!, markerName))).toBe(false);
        expect(fixture.runner.hasResource(target)).toBe(true);
        runPortableCpuDelegationProofMode("cleanup", fixture);
        expect(fixture.runner.hasResource(target)).toBe(false);
      });
    },
  );
  it("recovers an exact cache-parent post-create crash snapshot without an identity (#9188)", () => {
    withProofFixture((fixture) => {
      const parent = path.join(fixture.env.GITHUB_WORKSPACE!, "node_modules/.cache");
      fixture.env.E2E_SOURCE_CACHE_PARENT_CREATED = "unrecorded";
      fixture.env.E2E_SOURCE_CACHE_PARENT_ID = "";
      fs.mkdirSync(parent);
      expect(fixture.env.E2E_SOURCE_CACHE_PARENT_ID).toBe("");
      expect(
        fs.existsSync(
          path.join(fixture.env.RUNNER_TEMP!, "nemoclaw-source-require-cache-parent-created"),
        ),
      ).toBe(false);
      expect(fs.existsSync(parent)).toBe(true);
      runPortableCpuDelegationProofMode("cleanup", fixture);
      expect(fs.existsSync(parent)).toBe(false);
    });
  });
  it("rolls back earlier drop-ins when the final publication fails (#9188)", () => {
    withProofFixture((fixture) => {
      fixture.runner.failMoveFor = DELEGATION_DROP_IN;
      expect(() => runPortableCpuDelegationProofMode("prepare", fixture)).toThrow(
        /move fixture failure/u,
      );
      expect(fixture.runner.files.has(APP_DROP_IN)).toBe(false);
      expect(fixture.runner.files.has(DELEGATION_DROP_IN)).toBe(false);
      expect(fixture.runner.files.has(USER_SLICE_DROP_IN)).toBe(false);
    });
  });
  it.each([
    ["source cache", "cache", "nemoclaw-source-require-cache-created", "E2E_SOURCE_CACHE_ID"],
    [
      "drop-in directory",
      "directory",
      "nemoclaw-user-slice-drop-in-dir-created",
      "E2E_USER_SLICE_DROP_IN_DIR_ID",
    ],
    ["drop-in", "file", "nemoclaw-user-slice-drop-in-created", "E2E_USER_SLICE_DROP_IN_ID"],
  ] as const)(
    "retries a %s after receipt publication and rollback both fail (#9188)",
    (_name, targetName, markerName, idEnv) => {
      withProofFixture((fixture) => {
        const targets = {
          cache: path.join(
            fixture.env.GITHUB_WORKSPACE!,
            "node_modules/.cache/nemoclaw-source-require",
          ),
          directory: path.dirname(USER_SLICE_DROP_IN),
          file: USER_SLICE_DROP_IN,
        } as const;
        const target = targets[targetName];
        const marker = path.join(fixture.env.RUNNER_TEMP!, markerName);
        fixture.runner.directories.delete(targetName === "directory" ? target : "");
        fixture.filesystem.failWriteTarget = marker;
        fixture.runner.failRemovalFor = target;
        expect(() => runPortableCpuDelegationProofMode("prepare", fixture)).toThrow(
          /filesystem fixture write failure/u,
        );
        loadGithubEnv(fixture);
        expect(fs.readFileSync(marker, "utf8")).toBe("concurrent\n");
        expect(fixture.env[idEnv]).toMatch(/^[0-9]+:[0-9]+$/u);
        expect(fixture.runner.hasResource(target)).toBe(true);
        fixture.runner.failRemovalFor = "";
        fs.unlinkSync(marker);
        runPortableCpuDelegationProofMode("cleanup", fixture);
        expect(fixture.runner.hasResource(target)).toBe(false);
      });
    },
  );
  it("retries an identity-recorded temp after content and rollback fail (#9188)", () => {
    withProofFixture((fixture) => {
      fixture.runner.failTee = true;
      fixture.runner.failRemovalPrefix = `${path.dirname(USER_SLICE_DROP_IN)}/.nemoclaw-cpu-controller.`;
      expect(() => runPortableCpuDelegationProofMode("prepare", fixture)).toThrow(/tee fixture/u);
      loadGithubEnv(fixture);
      const temporary = fixture.env.E2E_USER_SLICE_DROP_IN_TEMP!;
      expect(fixture.env.E2E_USER_SLICE_DROP_IN_TEMP_ID).toMatch(/^[0-9]+:[0-9]+$/u);
      expect(fixture.runner.directories.has(temporary)).toBe(true);
      fixture.runner.failRemovalPrefix = "";
      runPortableCpuDelegationProofMode("cleanup", fixture);
      expect(fixture.runner.directories.has(temporary)).toBe(false);
    });
  });
  it("keeps import inert and rejects invalid CLI argv before a real cleanup subprocess (#9188)", () => {
    withProofFixture((fixture) => {
      const bin = path.join(fixture.directory, "bin");
      const scriptPath = path.resolve("scripts/checks/run-portable-cpu-delegation-proof.mts");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "sudo"), "#!/usr/bin/env node\nprocess.exit(0);\n", {
        mode: 0o755,
      });
      const env = {
        ...process.env,
        ...fixture.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      };
      const imported = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(scriptPath).href)})`,
        ],
        { cwd: path.resolve("."), encoding: "utf8", env },
      );
      expect(imported.status).toBe(0);
      expect(imported.stdout).toBe("");
      expect(() => portableCpuDelegationProofCli(["cleanup", "extra"], fixture)).toThrow(
        /Expected exactly one mode/u,
      );
      const rejected = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", scriptPath, "unknown"],
        { cwd: path.resolve("."), encoding: "utf8", env },
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("Expected exactly one mode");
      const cleaned = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", scriptPath, "cleanup"],
        { cwd: path.resolve("."), encoding: "utf8", env },
      );
      expect(cleaned.status).toBe(0);
      fs.writeFileSync(
        path.join(bin, "sudo"),
        "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
        { mode: 0o755 },
      );
      const signaled = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", scriptPath, "cleanup"],
        { cwd: path.resolve("."), encoding: "utf8", env },
      );
      expect(signaled.status).toBe(1);
      expect(signaled.stderr).toContain("sudo terminated by SIGTERM");
    });
  });

  it("pins one rootless socket and fails closed on Docker use", () => {
    const installGuard = namedStep("Install Docker invocation guard").run ?? "";
    const disableDocker = namedStep("Disable Docker daemon and socket").run ?? "";
    const startPodman = namedStep("Start exact rootless Podman API socket").run ?? "";
    const scripts = proofJob()
      .steps?.map((step) => step.run ?? "")
      .join("\n");

    expect(installGuard).toContain("exit 97");
    expect(installGuard).toContain("DOCKER_HOST=");
    expect(disableDocker).toContain("systemctl stop docker.service docker.socket");
    expect(disableDocker).toContain("pkill -TERM -x dockerd");
    expect(disableDocker).toContain("docker-absence-boundary.json");
    expect(disableDocker).toContain('source_revision="$(git rev-parse HEAD)"');
    expect(disableDocker).toContain('test "$source_revision" = "$E2E_SOURCE_REVISION"');
    expect(disableDocker).toContain("candidate-execution-prerequisites.json");
    expect(disableDocker).toContain("Docker socket remained available after Docker shutdown");
    const correctPastaPolicy = namedStep("Apply Ubuntu pasta signal policy correction").run ?? "";
    expect(correctPastaPolicy).toContain("/etc/apparmor.d/usr.bin.pasta");
    expect(correctPastaPolicy).toContain("signal (receive) peer=podman,");
    expect(correctPastaPolicy).toContain('apparmor_parser -r "$pasta_profile"');
    expect(startPodman).toContain("umask 077");
    expect(startPodman).toContain('socket_path="$runtime_dir/podman/podman.sock"');
    expect(startPodman).toContain('default_rootless_network_cmd = "pasta"');
    expect(startPodman).toContain("rootlessNetworkCmd");
    expect(startPodman).toContain("CONTAINERS_CONF");
    expect(startPodman).toContain('podman system service --time=0 "unix://$socket_path"');
    expect(startPodman).toContain("E2E_PODMAN_SOCKET");
    expect(scripts).not.toMatch(/\bdocker\s+(?:build|info|login|pull|run)\b/u);
    expect(scripts).not.toContain("podman-docker");
  });

  it("runs the real pinned OpenShell activation proof without synthetic fixtures", () => {
    const proof = namedStep(
      "Prove pinned OpenShell activation and registered-agent Podman CPU lifecycle",
    );
    const diagnostics = namedStep("Capture failed Podman lifecycle diagnostics");
    const cleanup = namedStep("Clean up rootless Podman runtime");
    const scripts = proofJob()
      .steps?.map((step) => step.run ?? "")
      .join("\n");

    expect(proof.run).toContain(
      "npx vitest run --project e2e-live \\\n  test/e2e/live/podman-cpu-lifecycle.test.ts \\",
    );
    expect(proof.run).toContain("test/e2e/live/podman-portable-uninstall.test.ts");
    const uninstallSource = readRepoText("test/e2e/live/podman-portable-uninstall.test.ts");
    expect(uninstallSource).toContain('executableOnPath("nemoclaw")');
    expect(uninstallSource).toContain("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR");
    expect(uninstallSource).toContain("OPENSHELL_LOCAL_TLS_DIR");
    expect(uninstallSource).toContain('["gateway", "info", "-g", "nemoclaw", "-o", "json"]');
    expect(uninstallSource).toContain('gatewayName: "nemoclaw"');
    expect(uninstallSource).toContain('"--all-gateway-ports"');
    expect(uninstallSource).toContain('"--delete-models"');
    expect(uninstallSource).toContain('"--destroy-user-data"');
    expect(uninstallSource).toContain('"--yes"');
    expect(uninstallSource).toContain("systemctl --user restart podman.socket");
    expect(uninstallSource).toContain("prepare_portable_experimental_runtime_override");
    const liveSource = readRepoText("test/e2e/live/podman-cpu-lifecycle.test.ts");
    const authorityIndex = liveSource.indexOf("expect(candidateAuthority())");
    const enginesIndex = liveSource.indexOf("let runtimeEngines = engines()");
    expect(authorityIndex).toBeGreaterThanOrEqual(0);
    expect(enginesIndex).toBeGreaterThanOrEqual(0);
    expect(authorityIndex).toBeLessThan(enginesIndex);
    expect(scripts).not.toContain("podman create");
    expect(scripts).toMatch(/onboard\.js"\)\)\.default[\s\S]*stopHostGatewayProcesses/u);
    expect(scripts).not.toContain("openshell-sandbox-$sandbox_name");
    expect(scripts).not.toContain("openshell.sandbox-name");
    expect(diagnostics.if).toBe("failure()");
    expect(diagnostics.run).toContain('podman --url "$endpoint" inspect');
    expect(diagnostics.run).toContain(
      "npx --no-install tsx test/e2e/live/podman-cpu-lifecycle-artifacts.ts",
    );
    expect(diagnostics.run).toContain("managed-container-summary.json");
    expect(diagnostics.run).not.toContain("podman-ps.txt");
    expect(diagnostics.run).not.toContain("-inspect.json");
    expect(diagnostics.run).not.toMatch(/podman\s+--url\s+"\$endpoint"\s+logs\b/u);
    expect(diagnostics.run).not.toContain("container-$container_id.log");
    expect(diagnostics.run).toContain("podman-secrets.txt");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("--filter label=openshell.managed=true");
    expect(cleanup.run).toContain('podman --url "$endpoint" rm --force');
    expect(cleanup.run).toContain('podman --url "$endpoint" volume rm --force');
    expect(cleanup.run).toContain('podman --url "$endpoint" secret rm');
    expect(cleanup.run).toContain('podman --url "$endpoint" network rm openshell-docker');
    const stopGateway = namedStep("Stop the exact portable-retirement proof gateway");
    expect(stopGateway.env?.E2E_PORTABLE_GATEWAY_STOP_SCOPE).toBe("full");
  });

  it("exports the verified Portable host gateway IP and stops the rootless Podman service after gateway IP lookup fails (#9587)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-gateway-step-"));
    const bin = path.join(directory, "bin");
    const commandLog = path.join(directory, "commands.log");
    const githubEnv = path.join(directory, "github-env");
    fs.mkdirSync(bin);
    fs.writeFileSync(githubEnv, "");
    const writeCommand = (name: string, body: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, {
        mode: 0o755,
      });
    writeCommand(
      "node",
      'printf "node\\n" >>"$COMMAND_LOG"; [ "${FAKE_NODE_FAILURE:-0}" = 0 ] || exit 23; printf "%s" "$FAKE_GATEWAY_IP"',
    );
    writeCommand(
      "sudo",
      'printf "sudo %s\\n" "$*" >>"$COMMAND_LOG"; if [ -n "${E2E_PODMAN_SERVICE_PID:-}" ] && kill -0 "$E2E_PODMAN_SERVICE_PID" 2>/dev/null; then printf "service-running-at-sudo\\n" >>"$COMMAND_LOG"; fi',
    );
    writeCommand(
      "ip",
      'printf "ip %s\\n" "$*" >>"$COMMAND_LOG"; printf "1: lo inet %s/32 scope host lo\\n" "${FAKE_IP_GATEWAY_IP:-$FAKE_GATEWAY_IP}"',
    );
    writeCommand("podman", 'printf "podman %s\\n" "$*" >>"$COMMAND_LOG"');
    const baseEnv = {
      ...process.env,
      COMMAND_LOG: commandLog,
      FAKE_GATEWAY_IP: PORTABLE_HOST_GATEWAY_IP,
      GITHUB_ENV: githubEnv,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    const run = (script: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", ["-c", script], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...baseEnv, ...env },
      });
    try {
      const configure = namedStep("Configure exact Portable host gateway alias").run ?? "";
      const configured = run(configure);
      expect(configured.status, configured.stderr).toBe(0);
      expect(fs.readFileSync(githubEnv, "utf8")).toBe(
        `E2E_PORTABLE_HOST_GATEWAY_IP=${PORTABLE_HOST_GATEWAY_IP}\n`,
      );
      expect(fs.readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "node",
        `sudo ip address replace ${PORTABLE_HOST_GATEWAY_IP}/32 dev lo`,
        "ip -o -4 address show dev lo",
      ]);

      fs.writeFileSync(githubEnv, "");
      const unverified = run(configure, { FAKE_IP_GATEWAY_IP: "169.254.99.1" });
      expect(unverified.status).not.toBe(0);
      expect(fs.readFileSync(githubEnv, "utf8")).toBe("");

      const cleanup = namedStep("Clean up rootless Podman runtime").run ?? "";
      const gatewayCleanupStart = cleanup.indexOf('portable_host_gateway_ip=""');
      expect(gatewayCleanupStart).toBeGreaterThanOrEqual(0);
      const gatewayCleanup = cleanup.slice(gatewayCleanupStart);
      const runCleanup = async (env: NodeJS.ProcessEnv) => {
        const service = spawn("sleep", ["60"], { stdio: "ignore" });
        expect(service.pid).toBeDefined();
        let timer: ReturnType<typeof setTimeout>;
        const stoppedPromise = new Promise<boolean>((resolve) => {
          service.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
          timer = setTimeout(() => resolve(false), 1_000);
        });
        const result = run(gatewayCleanup, {
          ...env,
          E2E_PODMAN_SERVICE_PID: String(service.pid),
        });
        const stopped = await stoppedPromise;
        service.kill();
        return { result, stopped };
      };
      fs.writeFileSync(commandLog, "");
      const cleaned = await runCleanup({
        E2E_PORTABLE_HOST_GATEWAY_IP: PORTABLE_HOST_GATEWAY_IP,
      });
      expect(cleaned.result.status, cleaned.result.stderr).toBe(0);
      expect(cleaned.stopped).toBe(true);
      const cleanupLog = fs.readFileSync(commandLog, "utf8");
      expect(cleanupLog).toContain(`sudo ip address delete ${PORTABLE_HOST_GATEWAY_IP}/32 dev lo`);
      expect(cleanupLog).toContain("service-running-at-sudo");

      fs.writeFileSync(commandLog, "");
      const failedLookup = await runCleanup({
        E2E_PORTABLE_HOST_GATEWAY_IP: PORTABLE_HOST_GATEWAY_IP,
        FAKE_NODE_FAILURE: "1",
      });
      expect(failedLookup.result.status, failedLookup.result.stderr).toBe(0);
      expect(failedLookup.stopped).toBe(true);
      const failureLog = fs.readFileSync(commandLog, "utf8");
      expect(failureLog).not.toContain("sudo ip address delete");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
