// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMock = vi.hoisted(() => ({
  coordinateManagedStartupApplication: vi.fn(),
}));
vi.mock("./managed-startup/coordinator", () => coordinatorMock);

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "./managed-startup/agent-environment";
import {
  applyManagedStartupCommandEnvironmentPlan,
  applyManagedStartupImageProfile,
  buildManagedStartupImageActionPlan,
  MANAGED_STARTUP_MERGED_CA_FILE,
  MANAGED_STARTUP_PROFILE_ENV,
  MANAGED_STARTUP_RUNTIME_ENV_FILE,
  type ManagedStartupImageActionPlanInput,
  normalizeHermesManagedConfigDescriptor,
  readStableRegularFile,
  serializeManagedStartupRuntimeEnvironment,
} from "./managed-startup/image-runtime";
import {
  encodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

function dashboard(agent: ManagedStartupAgent): ManagedStartupDashboard {
  switch (agent) {
    case "openclaw":
      return {
        agent,
        mode: "loopback",
        url: "http://127.0.0.1:18789",
        port: 18_789,
        bindAddress: "127.0.0.1",
        wslExposure: false,
      };
    case "hermes":
      return {
        agent,
        mode: "disabled",
        url: "http://127.0.0.1:18789",
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      };
    case "langchain-deepagents-code":
      return { agent, mode: "disabled" };
  }
}

function actionInput(
  agent: ManagedStartupAgent,
  mode: "apply" | "clear" = "apply",
): ManagedStartupImageActionPlanInput {
  const messagingActions =
    agent === "langchain-deepagents-code"
      ? []
      : [
          {
            kind: "apply-messaging-plan" as const,
            agent,
            mode,
            phase: "runtime-setup" as const,
            runAs: "root" as const,
          },
          {
            kind: "apply-messaging-plan" as const,
            agent,
            mode,
            phase: "post-agent-install" as const,
            runAs: "sandbox" as const,
          },
        ];
  return {
    agent,
    actions: [
      ...messagingActions.slice(0, 1),
      { kind: "generate-agent-config", agent, runAs: "sandbox" },
      ...messagingActions.slice(1),
      { kind: "configure-dashboard", dashboard: dashboard(agent) },
    ],
  };
}

describe("buildManagedStartupImageActionPlan", () => {
  it.each([
    "openclaw",
    "hermes",
  ] as const)("constructs the complete offline %s messaging and config plan", (agent) => {
    const plan = buildManagedStartupImageActionPlan(actionInput(agent));

    expect(plan.map(({ action, runAs }) => ({ action, runAs }))).toEqual([
      { action: "messaging-runtime-setup", runAs: "root" },
      { action: "generate-agent-config", runAs: "sandbox" },
      { action: "messaging-post-agent-install", runAs: "sandbox" },
    ]);
    expect(plan[0]?.argv).toContain("runtime-setup");
    expect(plan[0]?.argv).not.toContain("--managed-startup-runtime");
    expect(plan[2]?.argv).toContain("post-agent-install");
    expect(plan[2]?.argv).toContain("--managed-startup-runtime");
    expect(plan.some((command) => command.argv.includes("agent-install"))).toBe(false);
    expect(
      plan.some((command) =>
        command.argv.some((argument) => /^(?:npm|npx|pip|pip3|uv)$/u.test(argument)),
      ),
    ).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every((command) => Object.isFrozen(command) && Object.isFrozen(command.argv))).toBe(
      true,
    );
  });

  it("constructs DCode's complete offline config plan without messaging actions", () => {
    expect(buildManagedStartupImageActionPlan(actionInput("langchain-deepagents-code"))).toEqual([
      {
        action: "generate-agent-config",
        runAs: "sandbox",
        argv: [
          "/usr/local/bin/node",
          "--experimental-strip-types",
          "/opt/nemoclaw-deepagents-code/generate-config.ts",
        ],
      },
    ]);
  });

  it.each([
    ["openclaw", "/scripts/generate-openclaw-config.mts"],
    ["hermes", "/opt/nemoclaw-hermes-config/generate-config.ts"],
    ["langchain-deepagents-code", "/opt/nemoclaw-deepagents-code/generate-config.ts"],
  ] as const)("selects the reviewed %s generator asset", (agent, generator) => {
    const command = buildManagedStartupImageActionPlan(actionInput(agent)).find(
      ({ action }) => action === "generate-agent-config",
    );
    expect(command?.argv.at(-1)).toBe(generator);
  });

  it("constructs the same reviewed commands for apply and clear messaging intent", () => {
    expect(buildManagedStartupImageActionPlan(actionInput("openclaw", "clear"))).toEqual(
      buildManagedStartupImageActionPlan(actionInput("openclaw", "apply")),
    );
  });

  it.each([
    [
      "cross-agent action",
      {
        ...actionInput("openclaw"),
        actions: [
          ...actionInput("openclaw").actions.slice(0, 1),
          { kind: "generate-agent-config", agent: "hermes", runAs: "sandbox" },
          ...actionInput("openclaw").actions.slice(2),
        ],
      },
      /action for hermes cannot be used by openclaw/,
    ],
    [
      "partial messaging plan",
      {
        ...actionInput("hermes"),
        actions: actionInput("hermes").actions.filter(
          (action) =>
            action.kind !== "apply-messaging-plan" || action.phase !== "post-agent-install",
        ),
      },
      /requires 1 action for each messaging phase/,
    ],
    [
      "duplicate config action",
      {
        ...actionInput("langchain-deepagents-code"),
        actions: [
          ...actionInput("langchain-deepagents-code").actions,
          {
            kind: "generate-agent-config",
            agent: "langchain-deepagents-code",
            runAs: "sandbox",
          },
        ],
      },
      /exactly one agent config/,
    ],
    [
      "out-of-order messaging",
      {
        ...actionInput("openclaw"),
        actions: [
          ...actionInput("openclaw").actions.slice(1, 3),
          actionInput("openclaw").actions[0],
          actionInput("openclaw").actions[3],
        ],
      },
      /not in the required construction order/,
    ],
    [
      "root config generation",
      {
        ...actionInput("hermes"),
        actions: actionInput("hermes").actions.map((action) =>
          action.kind === "generate-agent-config" ? { ...action, runAs: "root" } : action,
        ),
      },
      /configuration generation must run as sandbox/,
    ],
    [
      "sandbox messaging runtime setup",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.map((action) =>
          action.kind === "apply-messaging-plan" && action.phase === "runtime-setup"
            ? { ...action, runAs: "sandbox" }
            : action,
        ),
      },
      /messaging runtime setup must run as root/,
    ],
    [
      "root messaging post-agent configuration",
      {
        ...actionInput("openclaw"),
        actions: actionInput("openclaw").actions.map((action) =>
          action.kind === "apply-messaging-plan" && action.phase === "post-agent-install"
            ? { ...action, runAs: "root" }
            : action,
        ),
      },
      /messaging post-agent configuration must run as sandbox/,
    ],
    [
      "arbitrary command action",
      {
        ...actionInput("langchain-deepagents-code"),
        actions: [
          ...actionInput("langchain-deepagents-code").actions,
          { kind: "run-command", argv: ["npm", "install"] },
        ],
      },
      /unsupported managed startup construction action/,
    ],
  ])("fails closed for an incomplete or mismatched construction contract: %s", (_name, input, message) => {
    expect(() =>
      buildManagedStartupImageActionPlan(input as ManagedStartupImageActionPlanInput),
    ).toThrow(message);
  });
});

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const OPENCLAW_APPLICATION_RUNTIME_NAMES = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
] as const;

describe("managed startup image runtime", () => {
  let temporaryDirectoryPath = "";

  beforeEach(() => {
    coordinatorMock.coordinateManagedStartupApplication.mockReset();
    temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-startup-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryDirectoryPath, { force: true, recursive: true });
  });

  function temporaryDirectory(): string {
    return temporaryDirectoryPath;
  }

  function mockDescriptorOwnership(uid: bigint, gid: bigint): void {
    const realFstatSync = fs.fstatSync.bind(fs);
    const realLstatSync = fs.lstatSync.bind(fs);
    const ownership = new Map<PropertyKey, unknown>([
      ["uid", uid],
      ["gid", gid],
    ]);
    const owned = (stat: fs.BigIntStats): fs.BigIntStats =>
      new Proxy(stat, {
        get(inner, property) {
          const value = ownership.has(property)
            ? ownership.get(property)
            : (Reflect.get(inner, property, inner) as unknown);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number, options: { bigint: true }) =>
      owned(realFstatSync(descriptor, options))) as typeof fs.fstatSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options: { bigint: true }) =>
      owned(realLstatSync(file, options))) as typeof fs.lstatSync);
  }

  function mockRootReplayFilesystem(runtimeWrites: string[]): void {
    const directories = new Set([
      "/",
      "/run",
      "/run/nemoclaw",
      "/var",
      "/var/lib",
      "/var/lib/nemoclaw",
    ]);
    let runtimeFileWritten = false;
    const stat = (kind: "directory" | "file", mode: number) =>
      ({
        gid: 0,
        isDirectory: () => kind === "directory",
        isFile: () => kind === "file",
        isSymbolicLink: () => false,
        mode,
        nlink: 1,
        uid: 0,
      }) as fs.Stats;
    const missing = (): never => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };

    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
      const resolved = String(target);
      return directories.has(resolved)
        ? stat("directory", 0o755)
        : resolved === MANAGED_STARTUP_RUNTIME_ENV_FILE && runtimeFileWritten
          ? stat("file", 0o400)
          : missing();
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "chownSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "openSync").mockReturnValue(91);
    vi.spyOn(fs, "fchownSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, value) => {
      runtimeWrites.push(...(target === 91 ? [String(value)] : []));
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "renameSync").mockImplementation((_source, target) => {
      runtimeFileWritten ||= String(target) === MANAGED_STARTUP_RUNTIME_ENV_FILE;
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(missing);
  }

  it("rejects invalid OpenClaw launch controls before filesystem or coordinator mutation", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const lstat = vi.spyOn(fs, "lstatSync");
    vi.spyOn(process, "geteuid").mockReturnValue(0);

    await expect(
      applyManagedStartupImageProfile("openclaw", {
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "NaN",
        [MANAGED_STARTUP_PROFILE_ENV]: encodeManagedStartupProfile(profile),
      }),
    ).rejects.toThrow(/finite positive seconds/u);
    expect(lstat).not.toHaveBeenCalled();
    expect(coordinatorMock.coordinateManagedStartupApplication).not.toHaveBeenCalled();
  });

  it("refreshes admitted launch controls on committed replay without changing the profile", async () => {
    const profile = managedStartupE2eProfile("openclaw");
    const encodedProfile = encodeManagedStartupProfile(profile);
    const fingerprint = fingerprintManagedStartupProfile(profile);
    const runtimeWrites: string[] = [];
    mockRootReplayFilesystem(runtimeWrites);
    coordinatorMock.coordinateManagedStartupApplication.mockResolvedValue({
      adapterApplied: false,
      application: {
        status: "committed",
        stateDirectory: "/var/lib/nemoclaw/managed-startup",
        generationDirectory: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}`,
        profilePath: `/var/lib/nemoclaw/managed-startup/generation-${fingerprint}/profile.json`,
        corporateCaPath: null,
        fingerprint,
        expectedAgent: "openclaw",
        profile,
      },
    });

    const first = await applyManagedStartupImageProfile("openclaw", {
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
      [MANAGED_STARTUP_PROFILE_ENV]: encodedProfile,
    });
    const second = await applyManagedStartupImageProfile("openclaw", {
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "5",
      [MANAGED_STARTUP_PROFILE_ENV]: encodedProfile,
    });

    expect(first).toMatchObject({ adapterApplied: false, fingerprint });
    expect(second).toMatchObject({ adapterApplied: false, fingerprint });
    expect(runtimeWrites).toHaveLength(2);
    expect(runtimeWrites[0]).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS='3'");
    expect(runtimeWrites[1]).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS='5'");
    expect(coordinatorMock.coordinateManagedStartupApplication).toHaveBeenCalledTimes(2);
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("maps the complete %s profile into the reviewed image command contract", (agent) => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(managedStartupE2eProfile(agent));
    const plan = buildManagedStartupImageActionPlan({
      agent: mapped.agent,
      actions: mapped.actions,
    });

    expect(plan.map(({ action }) => action)).toEqual(
      agent === "langchain-deepagents-code"
        ? ["generate-agent-config"]
        : ["messaging-runtime-setup", "generate-agent-config", "messaging-post-agent-install"],
    );
    expect(plan.some((command) => command.argv.includes("agent-install"))).toBe(false);
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("provides valid same-profile and changed-profile fixtures for %s recreation checks", (agent) => {
    const initial = validateManagedStartupProfile(managedStartupE2eProfile(agent));
    const same = validateManagedStartupProfile(managedStartupE2eProfile(agent));
    const changed = validateManagedStartupProfile(managedStartupE2eProfile(agent, true));

    expect(fingerprintManagedStartupProfile(same)).toBe(fingerprintManagedStartupProfile(initial));
    expect(fingerprintManagedStartupProfile(changed)).not.toBe(
      fingerprintManagedStartupProfile(initial),
    );
  });

  it("binds the real corporate-CA fixture into every agent profile by exact digest", () => {
    expect(() => new X509Certificate(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)).not.toThrow();
    const digest = createHash("sha256").update(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).digest("hex");

    for (const agent of MANAGED_STARTUP_AGENTS) {
      expect(managedStartupE2eProfile(agent, false, true).corporateCa.bundleSha256).toBe(digest);
    }
  });

  it("writes a deterministic root-sourced runtime environment without profile transport", () => {
    const applicationRuntime = {
      exportEnvironment: {
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3",
      },
      unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"],
    };
    const script = serializeManagedStartupRuntimeEnvironment(
      {
        NEMOCLAW_MODEL: "model-with-'quote",
        NEMOCLAW_OBSERVABILITY: "0",
      },
      true,
      {
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_MODEL: "model-with-'quote",
      },
      applicationRuntime,
    );

    expect(script).toContain("unset NEMOCLAW_INFERENCE_BASE_URL");
    expect(script).toContain("unset NEMOCLAW_MINIMAL_BOOTSTRAP");
    expect(script).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS='0.25'");
    expect(script).toContain("export NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS='3'");
    expect(script).toContain("export NEMOCLAW_MANAGED_STARTUP_APPLIED='1'");
    expect(script).toContain("export NEMOCLAW_MODEL='model-with-'\"'\"'quote'");
    expect(script).toContain(`export SSL_CERT_FILE='${MANAGED_STARTUP_MERGED_CA_FILE}'`);
    expect(script).toContain("export _NEMOCLAW_CORPORATE_CA_MERGED='1'");
    expect(script).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(script).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(script.endsWith("\n")).toBe(true);
    expect(
      serializeManagedStartupRuntimeEnvironment(
        {
          NEMOCLAW_MODEL: "model-with-'quote",
          NEMOCLAW_OBSERVABILITY: "0",
        },
        true,
        {
          NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          NEMOCLAW_MODEL: "model-with-'quote",
        },
        applicationRuntime,
      ),
    ).toBe(script);
  });

  it("validates runtime plans while removing launch-only exports and unsets from child commands", () => {
    const ambient = {
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "stale",
      NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
      PRESERVED: "yes",
    };
    const applied = applyManagedStartupCommandEnvironmentPlan(ambient, {
      exportEnvironment: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3" },
      unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"],
    });

    expect(applied).toEqual({
      PRESERVED: "yes",
    });
    expect(ambient).toHaveProperty("NEMOCLAW_MINIMAL_BOOTSTRAP", "1");
    expect(() =>
      applyManagedStartupCommandEnvironmentPlan(ambient, {
        exportEnvironment: { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" },
        unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"],
      }),
    ).toThrow(/both export and unset NEMOCLAW_MINIMAL_BOOTSTRAP/u);
    expect(ambient).toHaveProperty("NEMOCLAW_MINIMAL_BOOTSTRAP", "1");
  });

  it.each([
    "hermes",
    "langchain-deepagents-code",
  ] as const)("removes OpenClaw launch controls and cleanup obligations from %s children and runtime", (agent) => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(managedStartupE2eProfile(agent), {
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "invalid-for-this-agent",
    });
    const ambient = {
      ...Object.fromEntries(OPENCLAW_APPLICATION_RUNTIME_NAMES.map((name) => [name, "ambient"])),
      NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
      PRESERVED: "yes",
    };
    const child = applyManagedStartupCommandEnvironmentPlan(ambient, mapped.applicationRuntime);
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
      mapped.applicationRuntime,
    );

    expect(child).toEqual({ PRESERVED: "yes" });
    for (const name of [
      ...OPENCLAW_APPLICATION_RUNTIME_NAMES,
      "NEMOCLAW_DASHBOARD_BIND",
      "NEMOCLAW_MINIMAL_BOOTSTRAP",
    ]) {
      expect(script).toContain(`unset ${name}`);
      expect(script).not.toContain(`export ${name}=`);
    }
  });

  it("rejects a serialized runtime export that conflicts with an explicit unset", () => {
    expect(() =>
      serializeManagedStartupRuntimeEnvironment(
        { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" },
        false,
        {},
        { exportEnvironment: {}, unsetEnvironment: ["NEMOCLAW_MINIMAL_BOOTSTRAP"] },
      ),
    ).toThrow(/runtime environment cannot both export and unset NEMOCLAW_MINIMAL_BOOTSTRAP/u);
  });

  it.each([
    [
      { exportEnvironment: { "BAD-NAME": "value" }, unsetEnvironment: [] },
      /invalid application runtime environment key/u,
    ],
    [
      { exportEnvironment: { VALID_NAME: "line 1\nline 2" }, unsetEnvironment: [] },
      /must be single-line text/u,
    ],
    [
      { exportEnvironment: {}, unsetEnvironment: ["DUPLICATE", "DUPLICATE"] },
      /duplicate application runtime unset/u,
    ],
  ])("rejects a malformed application runtime plan before command mutation", (plan, message) => {
    const ambient = { PRESERVED: "yes" };
    expect(() => applyManagedStartupCommandEnvironmentPlan(ambient, plan)).toThrow(message);
    expect(ambient).toEqual({ PRESERVED: "yes" });
  });

  it.each(["openclaw", "hermes"] as const)("preserves launch-only proxy env for %s", (agent) => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(
      managedStartupE2eProfile(agent, false, false, true),
    );
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
    );
    for (const name of PROXY_ENV_NAMES) {
      expect(script).not.toMatch(new RegExp(`(?:export|unset) ${name}(?:=|$)`, "mu"));
    }
  });

  it("clears launch-only proxy env when DCode pins managed routing", () => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(
      managedStartupE2eProfile("langchain-deepagents-code", false, false, true),
    );
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
    );
    for (const name of PROXY_ENV_NAMES) {
      expect(script).toContain(`unset ${name}`);
    }
  });

  it("rejects multiline runtime values before producing a sourceable file", () => {
    expect(() =>
      serializeManagedStartupRuntimeEnvironment({ NEMOCLAW_MODEL: "bad\nvalue" }, false),
    ).toThrow(/single-line/u);
  });

  it("refuses a symlink instead of opening its target", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    fs.writeFileSync(target, "trusted\n");
    fs.symlinkSync(target, link);

    expect(() => readStableRegularFile(link, 1024)).toThrow(/unsafe or unreadable/u);
  });

  it("rejects descriptor metadata drift after a bounded read", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "material");
    fs.writeFileSync(target, "trusted\n", { mode: 0o600 });
    const realReadSync = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync")
      .mockImplementationOnce(((
        descriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const bytesRead = realReadSync(descriptor, buffer, offset, length, position);
        fs.chmodSync(target, 0o644);
        return bytesRead;
      }) as typeof fs.readSync)
      .mockImplementation(realReadSync as typeof fs.readSync);

    expect(() => readStableRegularFile(target, 1024)).toThrow(/changed while it was read/u);
  });

  it("normalizes mutable sandbox-owned Hermes config descriptors to mode 0640", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode: 0o600 });
    mockDescriptorOwnership(501n, 20n);

    normalizeHermesManagedConfigDescriptor(target, {
      uid: 501,
      gid: 20,
    });

    expect(fs.readFileSync(target, "utf8")).toBe("model: managed\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("preserves a root-owned shields-up Hermes descriptor without chmod", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, ".env");
    fs.writeFileSync(target, "OPENAI_API_KEY=managed\n", { mode: 0o444 });
    mockDescriptorOwnership(0n, 0n);
    const chmod = vi.spyOn(fs, "fchmodSync");

    normalizeHermesManagedConfigDescriptor(target, {
      uid: 501,
      gid: 20,
    });

    expect(chmod).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("OPENAI_API_KEY=managed\n");
  });

  it.each([0o440, 0o644, 0o660])("fails closed on unexpected mutable Hermes mode %s", (mode) => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode });
    fs.chmodSync(target, mode);
    mockDescriptorOwnership(501n, 20n);

    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/unexpected Hermes managed config descriptor/u);
    expect(fs.statSync(target).mode & 0o777).toBe(mode);
  });

  it("fails closed on an unexpected Hermes descriptor owner", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode: 0o600 });
    mockDescriptorOwnership(502n, 21n);

    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/unexpected Hermes managed config descriptor/u);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("detects a path replacement while normalizing through the trusted descriptor", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "config.yaml");
    const displaced = path.join(directory, "displaced.yaml");
    const replacement = path.join(directory, "replacement.yaml");
    fs.writeFileSync(target, "model: managed\n", { mode: 0o600 });
    fs.writeFileSync(replacement, "model: replaced\n", { mode: 0o640 });
    mockDescriptorOwnership(501n, 20n);
    const realFchmodSync = fs.fchmodSync.bind(fs);
    vi.spyOn(fs, "fchmodSync").mockImplementation((descriptor, mode) => {
      realFchmodSync(descriptor, mode);
      fs.renameSync(target, displaced);
      fs.renameSync(replacement, target);
    });

    expect(() =>
      normalizeHermesManagedConfigDescriptor(target, {
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/changed during normalization/u);
    expect(fs.readFileSync(target, "utf8")).toBe("model: replaced\n");
  });
});
