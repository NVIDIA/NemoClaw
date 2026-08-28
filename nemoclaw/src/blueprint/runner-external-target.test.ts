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
}));

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
    readFileSync: memory.readFileSync,
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
  };
});

vi.mock("../shared/openshell-external-target-boundary.cjs", () => ({
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
const { main } = await import("./runner.js");

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

describe("Blueprint Runner external OpenShell target", () => {
  beforeEach(() => {
    store.clear();
    stdoutCapture.reset();
    vi.clearAllMocks();
    externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan.mockReset();
    externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan.mockReturnValue(
      SANITIZED_TARGET_PLAN,
    );
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutCapture.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only the sanitized plan without subprocess or network calls (#9872)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient-gateway.invalid");
    vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", "/private/ambient-gateway-management.json");
    seedExternalTarget();

    await main(["plan", "--dry-run"]);

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

    await expect(main(["apply"])).rejects.toThrow(
      /External OpenShell target apply is not available/,
    );

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
    expect([...store.keys()].join("\n")).not.toContain("plan.json");
  });

  it("rejects an inference endpoint override before any effect (#9872)", async () => {
    seedExternalTarget();

    await expect(
      main(["plan", "--endpoint-url", "https://override.example.test/v1"]),
    ).rejects.toThrow(/--endpoint-url configures inference/);

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain("RUN_ID:");
  });

  it.each([
    ["components", { components: { sandbox: { name: "managed" } } }],
    ["profiles", { profiles: ["default"] }],
    ["min_openclaw_version", { min_openclaw_version: "2026.8.0" }],
  ])(
    "rejects the managed-only blueprint field %s before any effect (#9872)",
    async (field, value) => {
      addFile("blueprint.yaml", YAML.stringify({ ...externalTargetBlueprint(), ...value }));

      await expect(main(["plan"])).rejects.toThrow(
        `External OpenShell target planning does not accept '${field}'.`,
      );

      expect(mockExeca).not.toHaveBeenCalled();
      expect(mockedValidateEndpoint).not.toHaveBeenCalled();
      expect(stdoutCapture.text()).not.toContain("RUN_ID:");
      expect(
        externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicit inference profile before any effect (#9872)", async () => {
    seedExternalTarget();

    await expect(main(["plan", "--profile", "default"])).rejects.toThrow(
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

    await expect(main(["plan"])).rejects.toThrow(
      "external OpenShell target endpoint port must be between 1 and 65535",
    );

    expect(
      externalTargetBoundaryMocks.buildSanitizedExternalOpenShellTargetPlan,
    ).toHaveBeenCalledOnce();
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
  });
});
