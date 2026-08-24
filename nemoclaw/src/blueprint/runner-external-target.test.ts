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

const { store, addFile } = createRunnerFsStore();
const stdoutCapture = createStdoutCapture();
const mockExeca = vi.fn();
const externalFileSizes = new Map<string, number>();
const externalFileReads: string[] = [];

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  const descriptors = new Map<number, { filePath: string; offset: number }>();
  let nextDescriptor = 100;
  return {
    ...original,
    mkdirSync: memory.mkdirSync,
    readFileSync: memory.readFileSync,
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
    lstatSync: (filePath: string) => ({
      isFile: () => externalFileSizes.has(filePath),
      isSymbolicLink: () => false,
      dev: 1,
      ino: 1,
    }),
    openSync: (filePath: string) => {
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, { filePath, offset: 0 });
      return descriptor;
    },
    fstatSync: (descriptor: number) => {
      const file = descriptors.get(descriptor)!;
      return {
        isFile: () => true,
        size: externalFileSizes.get(file.filePath)!,
        dev: 1,
        ino: 1,
      };
    },
    readSync: (
      descriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
      _position: number | null,
    ) => {
      const file = descriptors.get(descriptor)!;
      externalFileReads.push(file.filePath);
      const contents = Buffer.from(memory.readFileSync(file.filePath));
      const bytesRead = contents.copy(buffer, offset, file.offset, file.offset + length);
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

const EXTERNAL_CA_FILE = "/var/run/openshell-target/private-ca.pem";
const EXTERNAL_AUTHENTICATION_FILE = "/var/run/openshell-target/private-authentication";
const EXTERNAL_AUTHENTICATION_CONTENTS = "private-authentication-material";
const EXTERNAL_CA_PEM = rootCertificates[0];

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
  addExternalFile(EXTERNAL_CA_FILE, EXTERNAL_CA_PEM);
  addExternalFile(EXTERNAL_AUTHENTICATION_FILE, EXTERNAL_AUTHENTICATION_CONTENTS);
}

function addExternalFile(filePath: string, contents: string): void {
  addFile(filePath, contents);
  externalFileSizes.set(filePath, Buffer.byteLength(contents));
}

describe("Blueprint Runner external OpenShell target", () => {
  beforeEach(() => {
    store.clear();
    externalFileSizes.clear();
    externalFileReads.length = 0;
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
        authentication_source: "file",
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
    expect(output).not.toContain(EXTERNAL_AUTHENTICATION_FILE.toLowerCase());
    expect(output).not.toContain(EXTERNAL_AUTHENTICATION_CONTENTS.toLowerCase());
    expect(output).not.toContain("begin certificate");
    expect(output).not.toContain("ambient-gateway");
    expect(output).not.toContain("/private/ambient-gateway-management.json");
    expect(output).not.toContain("docker");
    expect(output).not.toContain("podman");
    expect(externalFileReads).not.toContain(EXTERNAL_AUTHENTICATION_FILE);
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

  it("preserves the actionable external endpoint validation error (#9872)", async () => {
    const blueprint = externalTargetBlueprint();
    blueprint.openshell_target = {
      ...(blueprint.openshell_target as Record<string, unknown>),
      endpoint: "https://:8443",
    };
    addFile("blueprint.yaml", YAML.stringify(blueprint));

    await expect(main(["plan"])).rejects.toThrow(
      "external OpenShell target endpoint must be a valid HTTPS origin",
    );

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(externalFileReads).toEqual([]);
  });

  it("rejects an oversized CA file before reading its contents (#9872)", async () => {
    addFile("blueprint.yaml", YAML.stringify(externalTargetBlueprint()));
    externalFileSizes.set(EXTERNAL_CA_FILE, 1024 * 1024 + 1);
    addExternalFile(EXTERNAL_AUTHENTICATION_FILE, EXTERNAL_AUTHENTICATION_CONTENTS);

    await expect(main(["plan"])).rejects.toThrow(/CA file is empty or exceeds its size limit/);

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockedValidateEndpoint).not.toHaveBeenCalled();
    expect(stdoutCapture.text()).not.toContain(EXTERNAL_CA_FILE);
  });
});
