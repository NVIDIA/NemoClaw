// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertDualStationSshBindingFiles,
  clearDualStationSshBinding,
  type DualStationSshBinding,
  dualStationDockerSshUri,
  dualStationPinnedSshArgs,
  dualStationSshBindingDirectory,
  encodeDualStationSshBindingHandoff,
  loadDualStationSshBinding,
  loadDualStationSshBindingHandoff,
  type QualifiedStationSshIdentity,
  stationKnownHostsDigest,
  strictStationSshTransportArgs,
  writeDualStationSshBinding,
} from "./vllm-station-ssh-binding";

const PEER_TARGET = "station@10.10.0.2";
const PEER_HOST = "10.10.0.2";
const PEER_PORT = 2222;
const ED25519_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIFirstQualifiedStationKey";
const RSA_KEY = "AAAAB3NzaC1yc2EAAAADAQABAAABAQCRevokedStationKey";
const KNOWN_HOSTS_LINES = [
  `[${PEER_HOST}]:${String(PEER_PORT)} ssh-ed25519 ${ED25519_KEY}`,
  `@revoked [${PEER_HOST}]:${String(PEER_PORT)} ssh-rsa ${RSA_KEY}`,
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileMode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o777;
}

describe("qualified dual-Station SSH binding", () => {
  let dockerCliFile: string;
  let root: string;
  let resumeStatePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-ssh-binding-"));
    fs.chmodSync(root, 0o700);
    dockerCliFile = path.join(root, "docker-cli");
    fs.writeFileSync(
      dockerCliFile,
      `#!/bin/bash
set -Eeuo pipefail
printf '%s\\0' "$@" > "${"${NEMOCLAW_TEST_DOCKER_RECORD:?}"}"
exit "${"${NEMOCLAW_TEST_DOCKER_EXIT:-0}"}"
`,
      { mode: 0o700 },
    );
    fs.chmodSync(dockerCliFile, 0o700);
    resumeStatePath = path.join(root, "station-dual-pair-resume.json");
  });

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  function identity(overrides: Partial<QualifiedStationSshIdentity> = {}) {
    const knownHostsLines = overrides.knownHostsLines ?? KNOWN_HOSTS_LINES;
    return {
      requestedTarget: PEER_TARGET,
      sshTarget: PEER_TARGET,
      resolvedHost: PEER_HOST,
      sshUser: "station",
      port: PEER_PORT,
      lookupHost: `[${PEER_HOST}]:${String(PEER_PORT)}`,
      hostKeyDigest: stationKnownHostsDigest(knownHostsLines.join("\n")),
      knownHostsLines,
      ...overrides,
    } satisfies QualifiedStationSshIdentity;
  }

  function writeBinding(
    overrides: Partial<QualifiedStationSshIdentity> = {},
  ): DualStationSshBinding {
    return writeDualStationSshBinding(resumeStatePath, identity(overrides), {
      dockerCliFile,
    });
  }

  it("matches the coordinator digest over sorted unique key identities", () => {
    const raw = [
      "# ignored comment",
      KNOWN_HOSTS_LINES[1],
      KNOWN_HOSTS_LINES[0],
      KNOWN_HOSTS_LINES[0],
      "",
    ].join("\n");
    const expected = sha256(
      [`@revoked|ssh-rsa|${RSA_KEY}`, `|ssh-ed25519|${ED25519_KEY}`].sort().join("\n"),
    );

    expect(stationKnownHostsDigest(raw)).toBe(expected);
    expect(() => stationKnownHostsDigest(`@revoked ${PEER_HOST} ssh-rsa ${RSA_KEY}`)).toThrow(
      "no trusted key",
    );
    expect(() =>
      stationKnownHostsDigest(
        [`@cert-authority ${PEER_HOST} ssh-ed25519 ${ED25519_KEY}`, KNOWN_HOSTS_LINES[0]].join(
          "\n",
        ),
      ),
    ).toThrow("marker is not allowed");
  });

  it("persists owner-only evidence and reloads one canonical handoff", () => {
    const binding = writeBinding();
    const runtimeDirectory = dualStationSshBindingDirectory(resumeStatePath);
    const versionDirectory = path.dirname(binding.bindingFile);
    const knownHosts = `${[...KNOWN_HOSTS_LINES].sort().join("\n")}\n`;

    expect(binding).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        peerTarget: PEER_TARGET,
        resolvedHost: PEER_HOST,
        sshUser: "station",
        port: PEER_PORT,
        lookupHost: `[${PEER_HOST}]:${String(PEER_PORT)}`,
        hostKeyDigest: stationKnownHostsDigest(knownHosts),
        bindingFile: path.join(versionDirectory, "binding.json"),
        dockerCliFile: fs.realpathSync(dockerCliFile),
        dockerShimFile: path.join(versionDirectory, "bin", "docker"),
        knownHostsFile: path.join(versionDirectory, "known_hosts"),
        sshWrapperDirectory: path.join(versionDirectory, "bin"),
        sshWrapperFile: path.join(versionDirectory, "bin", "ssh"),
      }),
    );
    expect(path.dirname(versionDirectory)).toBe(runtimeDirectory);
    expect(path.basename(versionDirectory)).toMatch(/^v2-[a-f0-9]{32}$/);
    expect(fs.readFileSync(binding.knownHostsFile, "utf8")).toBe(knownHosts);
    expect(fileMode(runtimeDirectory)).toBe(0o700);
    expect(fileMode(versionDirectory)).toBe(0o700);
    expect(fileMode(binding.sshWrapperDirectory)).toBe(0o700);
    expect(fileMode(binding.bindingFile)).toBe(0o600);
    expect(fileMode(binding.dockerShimFile)).toBe(0o700);
    expect(fileMode(binding.knownHostsFile)).toBe(0o600);
    expect(fileMode(binding.sshWrapperFile)).toBe(0o700);

    const token = encodeDualStationSshBindingHandoff(binding);
    expect(loadDualStationSshBindingHandoff(token, PEER_TARGET)).toEqual(binding);
    expect(
      loadDualStationSshBinding(binding.bindingFile, PEER_TARGET, binding.hostKeyDigest),
    ).toEqual(binding);
  });

  it("pins direct SSH and Docker-over-SSH to the qualified endpoint", () => {
    const binding = writeBinding();
    const args = dualStationPinnedSshArgs(binding);

    expect(args.slice(0, strictStationSshTransportArgs().length)).toEqual(
      strictStationSshTransportArgs(),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        `UserKnownHostsFile=${binding.knownHostsFile}`,
        "GlobalKnownHostsFile=/dev/null",
        `HostKeyAlias=${binding.lookupHost}`,
        `Hostname=${PEER_HOST}`,
        "User=station",
        `Port=${String(PEER_PORT)}`,
      ]),
    );
    expect(dualStationDockerSshUri(binding)).toBe(
      `ssh://station@${PEER_HOST}:${String(PEER_PORT)}`,
    );

    expect(spawnSync("/bin/bash", ["-n", binding.sshWrapperFile]).status).toBe(0);
    expect(spawnSync("/bin/bash", ["-n", binding.dockerShimFile]).status).toBe(0);

    const dockerRecord = path.join(root, "docker-args");
    const dockerResult = spawnSync(
      binding.dockerShimFile,
      ["context", "inspect", "value with spaces"],
      {
        env: {
          ...process.env,
          NEMOCLAW_TEST_DOCKER_EXIT: "37",
          NEMOCLAW_TEST_DOCKER_RECORD: dockerRecord,
        },
      },
    );
    expect(dockerResult.status).toBe(37);
    expect(fs.readFileSync(dockerRecord).toString("utf8").split("\0").slice(0, -1)).toEqual([
      "context",
      "inspect",
      "value with spaces",
    ]);

    fs.appendFileSync(binding.knownHostsFile, "# tampered\n");
    const sshResult = spawnSync(binding.sshWrapperFile, ["-V"], { encoding: "utf8" });
    expect(sshResult.status).toBe(255);
    expect(sshResult.stderr).toContain("refused a changed dual-Station SSH host-key pin");
  });

  it("omits only the default SSH port from the Docker URI", () => {
    const binding = writeDualStationSshBinding(
      resumeStatePath,
      identity({ port: 22, lookupHost: PEER_HOST }),
      { dockerCliFile },
    );

    expect(dualStationDockerSshUri(binding)).toBe(`ssh://station@${PEER_HOST}`);
  });

  it("keeps an earlier accepted host-key set in its immutable version", () => {
    const first = writeBinding();
    const replacementKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const replacementLines = [`[${PEER_HOST}]:${String(PEER_PORT)} ssh-ed25519 ${replacementKey}`];
    const second = writeDualStationSshBinding(
      resumeStatePath,
      identity({
        knownHostsLines: replacementLines,
        hostKeyDigest: stationKnownHostsDigest(replacementLines.join("\n")),
      }),
      { dockerCliFile },
    );

    expect(second.hostKeyDigest).not.toBe(first.hostKeyDigest);
    expect(path.dirname(second.bindingFile)).not.toBe(path.dirname(first.bindingFile));
    expect(() => assertDualStationSshBindingFiles(first)).not.toThrow();
    expect(() => assertDualStationSshBindingFiles(second)).not.toThrow();
    expect(fs.readFileSync(first.knownHostsFile, "utf8")).toContain(ED25519_KEY);
    expect(fs.readFileSync(second.knownHostsFile, "utf8")).toContain(replacementKey);
  });

  it.each([
    {
      name: "mismatched requested target",
      override: { requestedTarget: "station@10.10.0.3" },
    },
    { name: "non-canonical resolved host", override: { resolvedHost: "999.999.999.999" } },
    { name: "unsafe SSH user", override: { sshUser: "station root" } },
    { name: "mismatched explicit SSH user", override: { sshUser: "other-user" } },
    { name: "out-of-range port", override: { port: 65_536 } },
    { name: "mismatched lookup host", override: { lookupHost: PEER_HOST } },
    { name: "mismatched digest", override: { hostKeyDigest: "0".repeat(64) } },
    { name: "comment evidence", override: { knownHostsLines: ["# not evidence"] } },
    {
      name: "multiline evidence",
      override: { knownHostsLines: [`${KNOWN_HOSTS_LINES[0]}\n${KNOWN_HOSTS_LINES[1]}`] },
    },
  ])("rejects $name before persisting it", ({ override }) => {
    expect(() =>
      writeDualStationSshBinding(
        resumeStatePath,
        identity(override as Partial<QualifiedStationSshIdentity>),
        { dockerCliFile },
      ),
    ).toThrow();
    expect(fs.existsSync(dualStationSshBindingDirectory(resumeStatePath))).toBe(false);
  });

  it("rejects a state path that cannot be one Docker helper PATH entry", () => {
    const incompatiblePath = path.join(root, `pair${path.delimiter}resume.json`);

    expect(() =>
      writeDualStationSshBinding(incompatiblePath, identity(), { dockerCliFile }),
    ).toThrow("normalized absolute path");
  });

  it.each([
    ["binding file", (binding: DualStationSshBinding) => binding.bindingFile, 0o644],
    ["Docker CLI", (binding: DualStationSshBinding) => binding.dockerCliFile, 0o722],
    ["Docker shim", (binding: DualStationSshBinding) => binding.dockerShimFile, 0o755],
    ["known-hosts file", (binding: DualStationSshBinding) => binding.knownHostsFile, 0o644],
    ["wrapper file", (binding: DualStationSshBinding) => binding.sshWrapperFile, 0o755],
    ["wrapper directory", (binding: DualStationSshBinding) => binding.sshWrapperDirectory, 0o755],
    [
      "binding version",
      (binding: DualStationSshBinding) => path.dirname(binding.bindingFile),
      0o755,
    ],
    [
      "binding root",
      (binding: DualStationSshBinding) => path.dirname(path.dirname(binding.bindingFile)),
      0o755,
    ],
    ["binding parent", (_binding: DualStationSshBinding) => root, 0o755],
  ] as const)("rejects unsafe %s permissions", (_name, target, mode) => {
    const binding = writeBinding();
    fs.chmodSync(target(binding), mode);

    expect(() =>
      loadDualStationSshBinding(binding.bindingFile, PEER_TARGET, binding.hostKeyDigest),
    ).toThrow();
  });

  it.each([
    ["binding file", (binding: DualStationSshBinding) => binding.bindingFile],
    ["Docker shim", (binding: DualStationSshBinding) => binding.dockerShimFile],
    ["known-hosts file", (binding: DualStationSshBinding) => binding.knownHostsFile],
    ["wrapper file", (binding: DualStationSshBinding) => binding.sshWrapperFile],
  ] as const)("refuses a symbolic-link %s", (_name, selectedPath) => {
    const binding = writeBinding();
    const filePath = selectedPath(binding);
    const copyPath = path.join(root, `copy-${path.basename(filePath)}`);
    fs.copyFileSync(filePath, copyPath);
    fs.chmodSync(copyPath, fileMode(filePath));
    fs.unlinkSync(filePath);
    fs.symlinkSync(copyPath, filePath);

    expect(() =>
      loadDualStationSshBinding(binding.bindingFile, PEER_TARGET, binding.hostKeyDigest),
    ).toThrow();
  });

  it("rejects known-hosts and wrapper tampering before returning transport data", () => {
    const binding = writeBinding();
    fs.appendFileSync(binding.knownHostsFile, "# changed\n");

    expect(() => dualStationPinnedSshArgs(binding)).toThrow(
      "known-hosts binding changed after qualification",
    );
    expect(() => dualStationDockerSshUri(binding)).toThrow(
      "known-hosts binding changed after qualification",
    );

    const restored = writeBinding();
    fs.appendFileSync(restored.sshWrapperFile, "# changed\n");
    expect(() => dualStationPinnedSshArgs(restored)).toThrow("wrapper changed after qualification");

    const dockerTampered = writeBinding();
    fs.appendFileSync(dockerTampered.dockerShimFile, "# changed\n");
    expect(() => dualStationDockerSshUri(dockerTampered)).toThrow(
      "Docker shim changed after qualification",
    );
  });

  it.each([
    ["binding file", (binding: DualStationSshBinding) => binding.bindingFile, 16 * 1024 + 1],
    ["known-hosts file", (binding: DualStationSshBinding) => binding.knownHostsFile, 64 * 1024 + 1],
    ["wrapper file", (binding: DualStationSshBinding) => binding.sshWrapperFile, 16 * 1024 + 1],
    ["Docker shim", (binding: DualStationSshBinding) => binding.dockerShimFile, 16 * 1024 + 1],
  ] as const)("rejects an oversized %s", (_name, selectedPath, size) => {
    const binding = writeBinding();
    fs.writeFileSync(selectedPath(binding), "x".repeat(size));

    expect(() =>
      loadDualStationSshBinding(binding.bindingFile, PEER_TARGET, binding.hostKeyDigest),
    ).toThrow();
  });

  it.each([
    ["unexpected field", (value: Record<string, unknown>): void => void (value.extra = true)],
    [
      "unsupported schema",
      (value: Record<string, unknown>): void => void (value.schemaVersion = 1),
    ],
    [
      "string port",
      (value: Record<string, unknown>): void => void (value.port = String(PEER_PORT)),
    ],
    [
      "changed peer",
      (value: Record<string, unknown>): void => void (value.peerTarget = "station@10.10.0.3"),
    ],
  ] as const)("rejects a binding JSON %s", (_name, mutate) => {
    const binding = writeBinding();
    const value = JSON.parse(fs.readFileSync(binding.bindingFile, "utf8")) as Record<
      string,
      unknown
    >;
    mutate(value);
    fs.writeFileSync(binding.bindingFile, `${JSON.stringify(value)}\n`);

    expect(() =>
      loadDualStationSshBinding(binding.bindingFile, PEER_TARGET, binding.hostKeyDigest),
    ).toThrow();
  });

  it("rejects forged handoffs and in-memory endpoint fields", () => {
    const binding = writeBinding();
    const token = encodeDualStationSshBindingHandoff(binding);
    const extraFieldToken = Buffer.from(
      JSON.stringify({
        bindingFile: binding.bindingFile,
        hostKeyDigest: binding.hostKeyDigest,
        peerTarget: PEER_TARGET,
      }),
      "utf8",
    ).toString("base64url");

    expect(() => loadDualStationSshBindingHandoff(`${token}=`, PEER_TARGET)).toThrow(
      "NEMOCLAW_DGX_STATION_SSH_BINDING is invalid",
    );
    expect(() => loadDualStationSshBindingHandoff(extraFieldToken, PEER_TARGET)).toThrow(
      "unexpected fields",
    );
    expect(() => loadDualStationSshBindingHandoff(token, "station@10.10.0.3")).toThrow(
      "does not match the qualified peer identity",
    );
    expect(() =>
      dualStationPinnedSshArgs({
        ...binding,
        resolvedHost: "10.10.0.2 ProxyCommand=attacker",
      }),
    ).toThrow("identity is invalid");
  });

  it("clears only an owner-only regular binding tree", () => {
    writeBinding();
    const runtimeDirectory = dualStationSshBindingDirectory(resumeStatePath);
    clearDualStationSshBinding(resumeStatePath);
    clearDualStationSshBinding(resumeStatePath);
    expect(fs.existsSync(runtimeDirectory)).toBe(false);

    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    const marker = path.join(outside, "keep");
    fs.writeFileSync(marker, "keep", { mode: 0o600 });
    fs.symlinkSync(outside, runtimeDirectory);
    expect(() => clearDualStationSshBinding(resumeStatePath)).toThrow("unsafe to remove");
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  });
});
