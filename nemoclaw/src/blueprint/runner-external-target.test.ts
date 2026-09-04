// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  createRunnerFsStore,
  createStdoutCapture,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
} from "./runner-mock-fixtures.js";

const { store, addFile } = createRunnerFsStore();
const stdoutCapture = createStdoutCapture();
const mockExeca = vi.fn();
const externalTargetBoundaryMocks = vi.hoisted(() => ({
  buildSanitizedExternalOpenShellTargetPlan: vi.fn(),
  withExternalOpenShellTargetCa: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));
const observeHealth = vi.fn();
const gatewayHealthObserver = { observeHealth };

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return {
    ...original,
    mkdirSync: memory.mkdirSync,
    readFileSync: fsMocks.readFileSync.mockImplementation(memory.readFileSync),
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
  };
});

vi.mock("../shared/openshell-external-target-boundary.cjs", () => ({
  EXTERNAL_OPENSHELL_RELEASE: "0.0.106",
  ...externalTargetBoundaryMocks,
  default: externalTargetBoundaryMocks,
}));

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return { ...actual, validateEndpointUrl: vi.fn() };
});

const { validateEndpointUrl } = await import("./ssrf.js");
const mockedValidateEndpoint = vi.mocked(validateEndpointUrl);
const { actionExternalOpenShellTargetPlan, actionExternalOpenShellTargetStatus, main } =
  await import("./runner.js");

const EXTERNAL_CA_FILE = "/var/run/openshell-target/private-ca.pem";
const EXTERNAL_AUTHENTICATION_FILE = "/var/run/openshell-target/private-authentication";
const SANITIZED_TARGET_PLAN = {
  endpoint: "https://openshell.example.test:8443",
  workspace: "default",
  expected_release: "0.0.106",
  lifecycle: "external",
  authentication_source: "file",
  ca_fingerprint: `sha256:${"a".repeat(64)}`,
} as const;

function externalTargetBlueprint(): Record<string, unknown> {
  return {
    version: "1.0.0",
    min_openshell_version: "0.0.106",
    max_openshell_version: "0.0.106",
    openshell_target: {
      endpoint: "https://openshell.example.test:8443",
      workspace: "default",
      expected_release: "0.0.106",
      lifecycle: "external",
      trust: { ca_file: EXTERNAL_CA_FILE },
      authentication: { credential_file: EXTERNAL_AUTHENTICATION_FILE },
    },
  };
}

function seedExternalTarget(): void {
  addFile("blueprint.yaml", YAML.stringify(externalTargetBlueprint()));
}

function runMain(argv: string[]): Promise<void> {
  return main(argv, { gatewayHealthObserver });
}

describe("Blueprint Runner external OpenShell target", () => {
  beforeEach(() => {
    store.clear();
    stdoutCapture.reset();
    vi.clearAllMocks();
    externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan.mockReset();
    externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan.mockReturnValue(
      SANITIZED_TARGET_PLAN,
    );
    externalTargetBoundaryMocks.withExternalOpenShellTargetCa.mockImplementation(
      async (_target, _compatibility, useTarget) =>
        useTarget(SANITIZED_TARGET_PLAN, Buffer.from("public-ca-certificate")),
    );
    observeHealth.mockResolvedValue({
      ok: true,
      value: { status: "healthy", release: "0.0.106" },
    });
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutCapture.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an external target and a complete OpenShell version range", async () => {
    expect(() => actionExternalOpenShellTargetPlan({})).toThrow(
      /does not declare an external OpenShell target/,
    );
    expect(() =>
      actionExternalOpenShellTargetPlan({ version: "1.0.0", openshell_target: {} }),
    ).toThrow(/requires blueprint min_openshell_version and max_openshell_version/);
    await expect(actionExternalOpenShellTargetStatus({}, gatewayHealthObserver)).rejects.toThrow(
      /does not declare an external OpenShell target/,
    );
    await expect(
      actionExternalOpenShellTargetStatus(
        { version: "1.0.0", openshell_target: {} },
        gatewayHealthObserver,
      ),
    ).rejects.toThrow(/requires blueprint min_openshell_version and max_openshell_version/);

    expect(
      externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
    ).not.toHaveBeenCalled();
    expect(externalTargetBoundaryMocks.withExternalOpenShellTargetCa).not.toHaveBeenCalled();
    expect(observeHealth).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, ["plan"]],
    ["invalid", "1.0", ["plan"]],
    ["missing", undefined, ["status", "--external-target"]],
    ["invalid", "1.0", ["status", "--external-target"]],
  ])(
    "rejects a %s blueprint version for %s before target reads or observation",
    async (_case, version, argv) => {
      const blueprint = externalTargetBlueprint();
      blueprint.version = version;
      addFile("blueprint.yaml", YAML.stringify(blueprint));

      const action = argv[0] === "plan" ? "planning" : "status";
      await expect(runMain(argv)).rejects.toThrow(
        `External OpenShell target ${action} requires blueprint version in X.Y.Z format.`,
      );

      expect(fsMocks.readFileSync).toHaveBeenCalledOnce();
      expect(fsMocks.readFileSync).toHaveBeenCalledWith("blueprint.yaml", "utf-8");
      expect(
        externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
      ).not.toHaveBeenCalled();
      expect(externalTargetBoundaryMocks.withExternalOpenShellTargetCa).not.toHaveBeenCalled();
      expect(observeHealth).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["planning", ["plan"]],
    ["status", ["status", "--external-target"]],
  ])(
    "rejects an unknown top-level field before external target %s reads or observation",
    async (_action, argv) => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({ ...externalTargetBlueprint(), unknown_top_level_field: true }),
      );

      await expect(runMain(argv)).rejects.toThrow(
        "blueprint.yaml must contain a YAML mapping with valid nested component shapes",
      );

      expect(fsMocks.readFileSync).toHaveBeenCalledOnce();
      expect(fsMocks.readFileSync).toHaveBeenCalledWith("blueprint.yaml", "utf-8");
      expect(
        externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
      ).not.toHaveBeenCalled();
      expect(externalTargetBoundaryMocks.withExternalOpenShellTargetCa).not.toHaveBeenCalled();
      expect(observeHealth).not.toHaveBeenCalled();
    },
  );

  it("emits only the sanitized plan without subprocess or network calls (#9872)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient-gateway.invalid");
    vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", "/private/ambient-gateway-management.json");
    seedExternalTarget();

    await runMain(["plan", "--dry-run"]);

    expect(stdoutCapture.jsonOutput()).toEqual({
      run_id: expect.stringMatching(/^nc-/),
      openshell_target: SANITIZED_TARGET_PLAN,
      dry_run: true,
    });
    expect(
      externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
    ).toHaveBeenCalledWith(externalTargetBlueprint().openshell_target as Record<string, unknown>, {
      minVersion: "0.0.106",
      maxVersion: "0.0.106",
    });
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    const output = stdoutCapture.text().toLowerCase();
    expect(output).not.toContain(EXTERNAL_CA_FILE.toLowerCase());
    expect(output).not.toContain(EXTERNAL_AUTHENTICATION_FILE.toLowerCase());
    expect(output).not.toContain("ambient-gateway");
    expect(output).not.toContain("/private/ambient-gateway-management.json");
    expect(output).not.toContain("docker");
    expect(output).not.toContain("podman");
  });

  it("rejects apply before any subprocess or run-state effect (#9872)", async () => {
    seedExternalTarget();

    await expect(runMain(["apply"])).rejects.toThrow(
      /External OpenShell target apply is not available/,
    );

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
    expect([...store.keys()].join("\n")).not.toContain("plan.json");
  });

  it("reports explicit public gateway health without ambient or authentication access (#9872)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient-gateway.invalid");
    vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", "/private/ambient-gateway-management.json");
    seedExternalTarget();

    await runMain(["status", "--external-target"]);

    expect(stdoutCapture.jsonOutput()).toEqual({
      run_id: expect.stringMatching(/^nc-/),
      openshell_target: SANITIZED_TARGET_PLAN,
      gateway: { status: "healthy", release: "0.0.106" },
      compatibility: "compatible",
    });
    expect(externalTargetBoundaryMocks.withExternalOpenShellTargetCa).toHaveBeenCalledWith(
      externalTargetBlueprint().openshell_target as Record<string, unknown>,
      { minVersion: "0.0.106", maxVersion: "0.0.106" },
      expect.any(Function),
    );
    expect(observeHealth).toHaveBeenCalledWith({
      target: SANITIZED_TARGET_PLAN,
      caBundle: Uint8Array.from(Buffer.from("public-ca-certificate")),
      timeoutMs: 5_000,
    });
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    const output = stdoutCapture.text();
    expect(output).not.toContain(EXTERNAL_CA_FILE);
    expect(output).not.toContain(EXTERNAL_AUTHENTICATION_FILE);
    expect(output).not.toContain("ambient-gateway");
  });

  it("fails closed when the root OpenShell observer is not injected (#9872)", async () => {
    seedExternalTarget();

    await expect(main(["status", "--external-target"])).rejects.toThrow(
      "The external OpenShell gateway observer is unavailable.",
    );

    expect(observeHealth).not.toHaveBeenCalled();
    expect(externalTargetBoundaryMocks.withExternalOpenShellTargetCa).not.toHaveBeenCalled();
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it.each([
    [
      "run receipt",
      ["status", "--external-target", "--run-id", "existing"],
      "--external-target and --run-id cannot be used together",
    ],
    [
      "managed profile",
      ["status", "--external-target", "--profile", "default"],
      "External target status does not accept managed-run options",
    ],
    [
      "another action",
      ["plan", "--external-target"],
      "--external-target is accepted only with status",
    ],
  ])(
    "rejects external status with %s options before the health call (#9872)",
    async (_name, argv, message) => {
      seedExternalTarget();

      await expect(runMain(argv)).rejects.toThrow(message);

      expect(observeHealth).not.toHaveBeenCalled();
      expect(mockExeca).not.toHaveBeenCalled();
    },
  );

  it("propagates only the fixed external health failure (#9872)", async () => {
    seedExternalTarget();
    observeHealth.mockResolvedValue({
      ok: false,
      error: {
        kind: "transport",
        message: "NemoClaw could not reach the external OpenShell target.",
      },
    });

    await expect(runMain(["status", "--external-target"])).rejects.toThrow(
      "NemoClaw could not reach the external OpenShell target.",
    );

    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("rejects an inference endpoint override before any effect (#9872)", async () => {
    seedExternalTarget();

    await expect(
      runMain(["plan", "--endpoint-url", "https://override.example.test/v1"]),
    ).rejects.toThrow(/--endpoint-url configures inference/);

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
  });

  it.each([
    ["components", "planning", ["plan"], { components: { sandbox: { name: "managed" } } }],
    [
      "components",
      "status",
      ["status", "--external-target"],
      { components: { sandbox: { name: "managed" } } },
    ],
    ["profiles", "planning", ["plan"], { profiles: ["default"] }],
    ["profiles", "status", ["status", "--external-target"], { profiles: ["default"] }],
    ["min_openclaw_version", "planning", ["plan"], { min_openclaw_version: "2026.8.0" }],
    [
      "min_openclaw_version",
      "status",
      ["status", "--external-target"],
      { min_openclaw_version: "2026.8.0" },
    ],
  ])(
    "rejects the managed-only blueprint field %s from external target %s before any effect (#9872)",
    async (field, action, argv, value) => {
      addFile("blueprint.yaml", YAML.stringify({ ...externalTargetBlueprint(), ...value }));

      await expect(runMain(argv)).rejects.toThrow(
        `External OpenShell target ${action} does not accept '${field}'.`,
      );

      expect(mockExeca).not.toHaveBeenCalled();
      expect(mockedValidateEndpoint).not.toHaveBeenCalled();
      expect(observeHealth).not.toHaveBeenCalled();
      expect(stdoutCapture.text()).not.toContain("RUN_ID:");
      expect(
        externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
      ).not.toHaveBeenCalled();
      expect(externalTargetBoundaryMocks.withExternalOpenShellTargetCa).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicit inference profile before any effect (#9872)", async () => {
    seedExternalTarget();

    await expect(runMain(["plan", "--profile", "default"])).rejects.toThrow(
      "--profile configures managed inference and is not accepted by external target-only planning.",
    );

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
    expect(
      externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
    ).not.toHaveBeenCalled();
  });

  it("forwards a port validation error without subprocess or endpoint-validation calls (#9872)", async () => {
    const blueprint = externalTargetBlueprint();
    blueprint.openshell_target = {
      ...(blueprint.openshell_target as Record<string, unknown>),
      endpoint: "https://openshell.example.test:0",
    };
    addFile("blueprint.yaml", YAML.stringify(blueprint));
    externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan.mockImplementationOnce(
      () => {
        throw new Error("external OpenShell target endpoint port must be between 1 and 65535");
      },
    );

    await expect(runMain(["plan"])).rejects.toThrow(
      "external OpenShell target endpoint port must be between 1 and 65535",
    );

    expect(
      externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
    ).toHaveBeenCalledOnce();
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
    expect(stdoutCapture.text()).not.toContain("PROGRESS:");
  });

  it.each([
    ["invalid", "external OpenShell target CA file must contain one certificate"],
    ["unreadable", "external OpenShell target CA file cannot be read"],
  ])("emits no run or progress output when the CA file is %s", async (_condition, message) => {
    seedExternalTarget();
    externalTargetBoundaryMocks.withExternalOpenShellTargetCa.mockRejectedValueOnce(
      new Error(message),
    );

    await expect(runMain(["status", "--external-target"])).rejects.toThrow(message);

    expect(observeHealth).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
    expect(stdoutCapture.text()).not.toContain("PROGRESS:");
  });
});
