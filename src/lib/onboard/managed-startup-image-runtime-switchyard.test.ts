// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HermesSwitchyardRouting,
  serializeHermesSwitchyardRelayToml,
  serializeHermesSwitchyardRuntimeBindings,
} from "../hermes-switchyard-routing";
import {
  installHermesRelayPluginsConfiguration,
  verifyHermesRelayPluginsConfiguration,
} from "./managed-startup/image-runtime";

const HERMES_SWITCHYARD_ROUTING = {
  algorithm: "llm_classifier",
  baseThreshold: 0.5,
  targets: (["judge", "weak", "strong"] as const).map((role) => ({
    role,
    baseUrl: `https://${role}.models.test/v1`,
    model: `${role}-model`,
    protocol: "openai_chat" as const,
    headerEnv: [
      {
        headerName: "authorization",
        envKey: `SWITCHYARD_${role.toUpperCase()}_AUTHORIZATION`,
      },
    ],
  })),
} as const satisfies HermesSwitchyardRouting;

describe("managed startup Hermes Switchyard runtime artifacts", () => {
  const temporaryDirectories: string[] = [];

  function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(
      path.join(process.env.TMPDIR!, "nemoclaw-switchyard-runtime-"),
    );
    temporaryDirectories.push(directory);
    return directory;
  }

  function mockRootOwnedRelayInstallPaths(
    shareDirectory: string,
    target: string,
    runtimeBindings: string,
  ): void {
    const realLstatSync = fs.lstatSync.bind(fs);
    const rootOwned = (stat: fs.Stats): fs.Stats =>
      new Proxy(stat, {
        get(inner, property) {
          const value = property === "uid" || property === "gid" ? 0 : Reflect.get(inner, property);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    vi.spyOn(fs, "lstatSync").mockImplementation(((
      file: fs.PathLike,
      options?: { bigint?: boolean },
    ) => {
      const stat = options?.bigint ? realLstatSync(file, { bigint: true }) : realLstatSync(file);
      const rootPath =
        file.toString() === shareDirectory ||
        file.toString() === target ||
        file.toString() === runtimeBindings;
      return rootPath && options?.bigint !== true ? rootOwned(stat as fs.Stats) : stat;
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "fchownSync").mockImplementation(() => undefined);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses, profile-binds, and promotes Hermes Relay TOML as root-owned state (#8886)", () => {
    const directory = temporaryDirectory();
    const shareDirectory = path.join(directory, "share");
    const source = path.join(directory, "relay-plugins.toml");
    const target = path.join(shareDirectory, "hermes-relay-plugins.toml");
    const runtimeBindings = path.join(shareDirectory, "hermes-switchyard-bindings.json");
    const serialized = serializeHermesSwitchyardRelayToml(HERMES_SWITCHYARD_ROUTING);
    fs.mkdirSync(shareDirectory);
    fs.writeFileSync(source, serialized, { mode: 0o600 });
    mockRootOwnedRelayInstallPaths(shareDirectory, target, runtimeBindings);

    installHermesRelayPluginsConfiguration(
      HERMES_SWITCHYARD_ROUTING,
      source,
      target,
      runtimeBindings,
    );

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(serialized);
    expect(fs.statSync(target).mode & 0o777).toBe(0o444);
    expect(fs.readFileSync(runtimeBindings, "utf8")).toBe(
      serializeHermesSwitchyardRuntimeBindings(HERMES_SWITCHYARD_ROUTING),
    );
    expect(fs.statSync(runtimeBindings).mode & 0o777).toBe(0o444);
  });

  it("rejects generated Hermes Relay TOML that differs from the profile (#8886)", () => {
    const directory = temporaryDirectory();
    const shareDirectory = path.join(directory, "share");
    const source = path.join(directory, "relay-plugins.toml");
    const target = path.join(shareDirectory, "hermes-relay-plugins.toml");
    const runtimeBindings = path.join(shareDirectory, "hermes-switchyard-bindings.json");
    const altered = serializeHermesSwitchyardRelayToml(HERMES_SWITCHYARD_ROUTING).replace(
      'model = "weak-model"',
      'model = "unattested-model"',
    );
    fs.mkdirSync(shareDirectory);
    fs.writeFileSync(source, altered, { mode: 0o600 });
    mockRootOwnedRelayInstallPaths(shareDirectory, target, runtimeBindings);

    expect(() =>
      installHermesRelayPluginsConfiguration(
        HERMES_SWITCHYARD_ROUTING,
        source,
        target,
        runtimeBindings,
      ),
    ).toThrow(/does not match the managed startup profile/u);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("removes stale installed Relay TOML when Hermes routing is disabled (#8886)", () => {
    const directory = temporaryDirectory();
    const shareDirectory = path.join(directory, "share");
    const source = path.join(directory, "relay-plugins.toml");
    const target = path.join(shareDirectory, "hermes-relay-plugins.toml");
    const runtimeBindings = path.join(shareDirectory, "hermes-switchyard-bindings.json");
    fs.mkdirSync(shareDirectory);
    fs.writeFileSync(target, "stale\n", { mode: 0o444 });
    fs.writeFileSync(runtimeBindings, "stale\n", { mode: 0o444 });
    mockRootOwnedRelayInstallPaths(shareDirectory, target, runtimeBindings);

    installHermesRelayPluginsConfiguration(undefined, source, target, runtimeBindings);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(runtimeBindings)).toBe(false);
  });

  it("detects committed Relay TOML metadata drift (#8886)", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "hermes-relay-plugins.toml");
    const runtimeBindings = path.join(directory, "hermes-switchyard-bindings.json");
    fs.writeFileSync(target, serializeHermesSwitchyardRelayToml(HERMES_SWITCHYARD_ROUTING), {
      mode: 0o600,
    });
    fs.writeFileSync(
      runtimeBindings,
      serializeHermesSwitchyardRuntimeBindings(HERMES_SWITCHYARD_ROUTING),
      { mode: 0o600 },
    );
    const realFstatSync = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number, options?: object) => {
      const stat = realFstatSync(descriptor, options as never);
      return new Proxy(stat, {
        get(inner, property) {
          const value =
            property === "uid" || property === "gid"
              ? options
                ? 0n
                : 0
              : Reflect.get(inner, property);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    }) as typeof fs.fstatSync);

    expect(() =>
      verifyHermesRelayPluginsConfiguration(HERMES_SWITCHYARD_ROUTING, target, runtimeBindings),
    ).toThrow(/committed Hermes Relay TOML drifted/u);
  });
});
