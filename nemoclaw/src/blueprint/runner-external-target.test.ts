// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import type fs from "node:fs";
import { rootCertificates } from "node:tls";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  createRunnerFsStore,
  createStdoutCapture,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
} from "./runner-mock-fixtures.js";
import { minimalBlueprint } from "./runner-test-fixtures.js";

const { store, addFile } = createRunnerFsStore();
const stdoutCapture = createStdoutCapture();
const mockExeca = vi.fn();
const fsReadCalls: number[] = [];

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  const descriptors = new Map<number, { contents: Buffer; offset: number }>();
  let nextDescriptor = 100;
  return {
    ...original,
    mkdirSync: memory.mkdirSync,
    readFileSync: memory.readFileSync,
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
    openSync: (filePath: string) => {
      const contents = Buffer.from(memory.readFileSync(filePath));
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, { contents, offset: 0 });
      return descriptor;
    },
    fstatSync: (descriptor: number) => {
      const file = descriptors.get(descriptor)!;
      return { isFile: () => true, size: file.contents.length };
    },
    readSync: (
      descriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
      _position: number | null,
    ) => {
      const file = descriptors.get(descriptor)!;
      fsReadCalls.push(descriptor);
      const bytesRead = file.contents.copy(buffer, offset, file.offset, file.offset + length);
      file.offset += bytesRead;
      return bytesRead;
    },
    closeSync: (descriptor: number) => {
      descriptors.delete(descriptor);
    },
  };
});

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

const EXTERNAL_CA_FILE = "/run/secrets/openshell/private-ca.pem";
const EXTERNAL_TOKEN_FILE = "/run/secrets/openshell/private-oidc-token";
const EXTERNAL_TOKEN = "header.private-credential.signature";
const EXTERNAL_CA_PEM = rootCertificates[0];

function externalTargetBlueprint(): Record<string, unknown> {
  return {
    ...minimalBlueprint(),
    min_openshell_version: "0.0.106",
    max_openshell_version: "0.0.106",
    openshell_target: {
      endpoint: "https://openshell.example.test:8443",
      workspace: "default",
      expected_release: "0.0.106",
      lifecycle: "external",
      trust: { ca_file: EXTERNAL_CA_FILE },
      authentication: { kind: "oidc", token_file: EXTERNAL_TOKEN_FILE },
    },
  };
}

function seedExternalTarget(): void {
  addFile("blueprint.yaml", YAML.stringify(externalTargetBlueprint()));
  addFile(EXTERNAL_CA_FILE, EXTERNAL_CA_PEM);
  addFile(EXTERNAL_TOKEN_FILE, EXTERNAL_TOKEN);
}

describe("Blueprint Runner external OpenShell target", () => {
  beforeEach(() => {
    store.clear();
    fsReadCalls.length = 0;
    stdoutCapture.reset();
    vi.clearAllMocks();
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
      openshell_target: {
        endpoint: "https://openshell.example.test:8443",
        workspace: "default",
        expected_release: "0.0.106",
        lifecycle: "external",
        authentication_kind: "oidc",
        ca_fingerprint: `sha256:${createHash("sha256")
          .update(new X509Certificate(EXTERNAL_CA_PEM).raw)
          .digest("hex")}`,
      },
      dry_run: true,
    });
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    const output = stdoutCapture.text().toLowerCase();
    expect(output).not.toContain(EXTERNAL_CA_FILE.toLowerCase());
    expect(output).not.toContain(EXTERNAL_TOKEN_FILE.toLowerCase());
    expect(output).not.toContain(EXTERNAL_TOKEN.toLowerCase());
    expect(output).not.toContain("begin certificate");
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

  it("rejects an oversized CA file before reading its contents (#9872)", async () => {
    addFile("blueprint.yaml", YAML.stringify(externalTargetBlueprint()));
    addFile(EXTERNAL_CA_FILE, "x".repeat(1024 * 1024 + 1));
    addFile(EXTERNAL_TOKEN_FILE, EXTERNAL_TOKEN);

    await expect(main(["plan"])).rejects.toThrow(/CA file is empty or exceeds its size limit/);

    expect(fsReadCalls).toHaveLength(0);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain(EXTERNAL_CA_FILE);
  });
});
