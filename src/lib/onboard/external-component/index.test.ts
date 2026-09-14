// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExternalComponentContractError,
  loadExternalComponentDeclaration,
  parseExternalComponentDeclaration,
} from "./index";

const roots: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function expectReason(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected external component validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalComponentContractError);
    expect((error as ExternalComponentContractError).code).toBe(code);
  }
}

function validJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    componentId: "policy-governance",
    interceptorSocketPath: "/run/user/1000/component/interceptor.sock",
    activationSocketPath: "/run/user/1000/component/activation.sock",
    ...overrides,
  });
}

async function listen(socketPath: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  servers.push(server);
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
}

async function preparedFixture() {
  const ancestors = path
    .dirname(process.cwd())
    .split(path.sep)
    .map((_part, index, parts) => parts.slice(0, index + 1).join(path.sep) || path.sep);
  for (const ancestor of ancestors) {
    const stat = fs.lstatSync(ancestor);
    expect(
      stat.isDirectory() &&
        (stat.mode & 0o022) === 0 &&
        (stat.uid === 0 || stat.uid === process.geteuid?.()),
      `External component fixtures require a protected ancestor: ${ancestor}`,
    ).toBe(true);
  }
  const root = fs.mkdtempSync(path.join(path.dirname(process.cwd()), "nc-component-test-"));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const homeDirectory = path.join(root, "home");
  const configDirectory = path.join(homeDirectory, ".config", "nemoclaw");
  const runtimeDirectory = path.join(root, "runtime");
  fs.mkdirSync(configDirectory, { mode: 0o700, recursive: true });
  fs.mkdirSync(runtimeDirectory, { mode: 0o700, recursive: true });
  const interceptorSocketPath = path.join(runtimeDirectory, "interceptor.sock");
  const activationSocketPath = path.join(runtimeDirectory, "activation.sock");
  const interceptorServer = await listen(interceptorSocketPath);
  const activationServer = await listen(activationSocketPath);
  const declarationPath = path.join(configDirectory, "external-component.json");
  fs.writeFileSync(declarationPath, validJson({ interceptorSocketPath, activationSocketPath }), {
    mode: 0o600,
  });
  fs.chmodSync(declarationPath, 0o600);
  return {
    activationServer,
    activationSocketPath,
    declarationPath,
    homeDirectory,
    interceptorServer,
    interceptorSocketPath,
    root,
    runtimeDirectory,
  };
}

describe("external component declaration", () => {
  it("accepts the exact secret-free v1 fields (#11340)", () => {
    expect(parseExternalComponentDeclaration(validJson())).toEqual({
      schemaVersion: 1,
      componentId: "policy-governance",
      interceptorSocketPath: "/run/user/1000/component/interceptor.sock",
      activationSocketPath: "/run/user/1000/component/activation.sock",
    });
  });

  it.each([
    ["invalid JSON", "{", "declaration_invalid"],
    [
      "duplicate keys",
      '{"schemaVersion":1,"schemaVersion":1,"componentId":"component","interceptorSocketPath":"/run/component/interceptor.sock","activationSocketPath":"/run/component/activation.sock"}',
      "declaration_duplicate_key",
    ],
    ["unknown fields", validJson({ command: "run" }), "declaration_unknown_field"],
    ["unsupported schemas", validJson({ schemaVersion: 3 }), "schema_unsupported"],
    [
      "missing fields",
      JSON.stringify({ schemaVersion: 1, componentId: "component" }),
      "declaration_invalid",
    ],
    [
      "relative endpoints",
      validJson({ interceptorSocketPath: "interceptor.sock" }),
      "declaration_invalid",
    ],
    [
      "one shared endpoint",
      validJson({ activationSocketPath: "/run/user/1000/component/interceptor.sock" }),
      "declaration_invalid",
    ],
  ])("rejects %s (#11340)", (_title, source, code) => {
    expectReason(() => parseExternalComponentDeclaration(source), code);
  });

  it("accepts current-user files and sockets and revalidates their identity (#11340)", async () => {
    const fixture = await preparedFixture();

    const prepared = loadExternalComponentDeclaration({
      declarationPath: fixture.declarationPath,
      homeDirectory: fixture.homeDirectory,
      platform: "linux",
    });

    expect(prepared?.declaration.componentId).toBe("policy-governance");
    expect(() => prepared?.revalidateBeforeGateway()).not.toThrow();
    expect(() => prepared?.revalidateBeforeActivation()).not.toThrow();
  });

  it("rejects a declaration that is not valid UTF-8 (#11340)", async () => {
    const fixture = await preparedFixture();
    fs.writeFileSync(fixture.declarationPath, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), {
      mode: 0o600,
    });

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "declaration_invalid",
    );
  });

  it("leaves onboarding unchanged when no declaration exists (#11340)", async () => {
    const fixture = await preparedFixture();
    fs.unlinkSync(fixture.declarationPath);

    expect(
      loadExternalComponentDeclaration({
        declarationPath: fixture.declarationPath,
        homeDirectory: fixture.homeDirectory,
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("rejects unsupported platforms only when a declaration exists (#11340)", async () => {
    const fixture = await preparedFixture();

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "darwin",
        }),
      "platform_unsupported",
    );
  });

  it("rejects symbolic-link declarations (#11340)", async () => {
    const fixture = await preparedFixture();
    const target = path.join(fixture.homeDirectory, "declaration-target.json");
    fs.renameSync(fixture.declarationPath, target);
    fs.symlinkSync(target, fixture.declarationPath);

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "declaration_symlink",
    );
  });

  it("rejects multiply linked declarations (#11340)", async () => {
    const fixture = await preparedFixture();
    fs.linkSync(fixture.declarationPath, path.join(fixture.homeDirectory, "declaration-copy.json"));

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "declaration_ambiguous",
    );
  });

  it("rejects declaration ownership and mode changes (#11340)", async () => {
    const fixture = await preparedFixture();
    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
          uid: (process.geteuid?.() ?? 0) + 1,
        }),
      "declaration_owner",
    );

    fs.chmodSync(fixture.declarationPath, 0o644);
    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "declaration_mode",
    );
  });

  it("rejects unsafe socket types, modes, and parent directories (#11340)", async () => {
    const fixture = await preparedFixture();
    fs.chmodSync(fixture.activationSocketPath, 0o666);
    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "socket_mode",
    );

    fs.chmodSync(fixture.activationSocketPath, 0o600);
    fs.chmodSync(fixture.runtimeDirectory, 0o777);
    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "socket_parent_unsafe",
    );
  });

  it("rejects a symbolic-link socket parent as unsafe (#11340)", async () => {
    const fixture = await preparedFixture();
    const linkedRuntimeDirectory = path.join(fixture.root, "runtime-link");
    fs.symlinkSync(fixture.runtimeDirectory, linkedRuntimeDirectory);
    fs.writeFileSync(
      fixture.declarationPath,
      validJson({
        interceptorSocketPath: fixture.interceptorSocketPath,
        activationSocketPath: path.join(linkedRuntimeDirectory, "activation.sock"),
      }),
      { mode: 0o600 },
    );

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fixture.declarationPath,
          homeDirectory: fixture.homeDirectory,
          platform: "linux",
        }),
      "socket_parent_unsafe",
    );
  });

  it("rejects a socket not owned by the effective user (#11340)", async () => {
    const fixture = await preparedFixture();
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSync = vi.spyOn(fs, "lstatSync");
    lstatSync.mockImplementation((candidate) => {
      const stat = realLstatSync(candidate);
      return new Proxy(stat, {
        get: (target, property, receiver) =>
          property === "uid" && String(candidate) === fixture.activationSocketPath
            ? target.uid + 1
            : Reflect.get(target, property, receiver),
      });
    });

    try {
      expectReason(
        () =>
          loadExternalComponentDeclaration({
            declarationPath: fixture.declarationPath,
            homeDirectory: fixture.homeDirectory,
            platform: "linux",
          }),
        "socket_owner",
      );
    } finally {
      lstatSync.mockRestore();
    }
  });

  it("rejects non-socket and symbolic-link endpoints (#11340)", async () => {
    const fileFixture = await preparedFixture();
    await closeServer(fileFixture.activationServer);
    fs.rmSync(fileFixture.activationSocketPath, { force: true });
    fs.writeFileSync(fileFixture.activationSocketPath, "not a socket", { mode: 0o600 });

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: fileFixture.declarationPath,
          homeDirectory: fileFixture.homeDirectory,
          platform: "linux",
        }),
      "socket_type",
    );

    const linkFixture = await preparedFixture();
    await closeServer(linkFixture.activationServer);
    fs.rmSync(linkFixture.activationSocketPath, { force: true });
    fs.symlinkSync(linkFixture.interceptorSocketPath, linkFixture.activationSocketPath);

    expectReason(
      () =>
        loadExternalComponentDeclaration({
          declarationPath: linkFixture.declarationPath,
          homeDirectory: linkFixture.homeDirectory,
          platform: "linux",
        }),
      "socket_type",
    );
  });

  it("rejects declaration or endpoint replacement before use (#11340)", async () => {
    const fixture = await preparedFixture();
    const prepared = loadExternalComponentDeclaration({
      declarationPath: fixture.declarationPath,
      homeDirectory: fixture.homeDirectory,
      platform: "linux",
    });
    fs.writeFileSync(fixture.declarationPath, "{}", { mode: 0o600 });

    expectReason(() => prepared?.revalidateBeforeGateway(), "declaration_ambiguous");

    const endpointFixture = await preparedFixture();
    const endpointPrepared = loadExternalComponentDeclaration({
      declarationPath: endpointFixture.declarationPath,
      homeDirectory: endpointFixture.homeDirectory,
      platform: "linux",
    });
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSync = vi.spyOn(fs, "lstatSync");
    lstatSync.mockImplementation((candidate) => {
      const stat = realLstatSync(candidate);
      return new Proxy(stat, {
        get: (target, property, receiver) =>
          property === "ino" && String(candidate) === endpointFixture.activationSocketPath
            ? target.ino + 1
            : Reflect.get(target, property, receiver),
      });
    });

    try {
      expectReason(() => endpointPrepared?.revalidateBeforeActivation(), "socket_ambiguous");
    } finally {
      lstatSync.mockRestore();
    }
  });
});
