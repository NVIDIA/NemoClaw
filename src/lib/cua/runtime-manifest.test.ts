// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentChoices, listAgents, loadAgent } from "../agent/defs";
import {
  getCuaSandboxImageRef,
  loadCuaRuntimeManifest,
  stageCuaRuntimePayload,
  verifyCuaRuntimePayload,
} from "./runtime-manifest";
import { type CuaRuntimeTestFixture, createCuaRuntimeTestFixture } from "./runtime-test-fixture";

const fixtures: CuaRuntimeTestFixture[] = [];

function fixture(): CuaRuntimeTestFixture {
  const value = createCuaRuntimeTestFixture();
  fixtures.push(value);
  return value;
}

function hash(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function rewriteAgentManifest(
  runtime: CuaRuntimeTestFixture,
  transform: (value: string) => string,
): void {
  const manifestPath = path.join(runtime.root, "manifest.yaml");
  const contents = transform(fs.readFileSync(manifestPath, "utf8"));
  fs.chmodSync(manifestPath, 0o644);
  fs.writeFileSync(manifestPath, contents);
  fs.chmodSync(manifestPath, 0o444);
  runtime.rewriteManifest((record) => {
    const agent = record.agent as Record<string, unknown>;
    const identity = agent.manifest as Record<string, unknown>;
    identity.sizeBytes = Buffer.byteLength(contents);
    identity.sha256 = hash(contents);
  });
}

function rewriteDockerfilePayload(
  runtime: CuaRuntimeTestFixture,
  field: "dockerfile" | "baseDockerfile",
  contents: string | Buffer,
): void {
  const filePath = path.join(runtime.root, runtime.manifest.agent[field].filename);
  fs.chmodSync(filePath, 0o644);
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o444);
  runtime.rewriteManifest((record) => {
    const agent = record.agent as Record<string, unknown>;
    const identity = agent[field] as Record<string, unknown>;
    identity.sizeBytes =
      typeof contents === "string" ? Buffer.byteLength(contents) : contents.length;
    identity.sha256 = hash(contents);
  });
}

function dockerfileWith(field: "dockerfile" | "baseDockerfile", ...instructions: string[]): string {
  const preamble =
    field === "dockerfile"
      ? "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n"
      : "ARG NEMOCUA_RUNTIME_IMAGE\nFROM ${NEMOCUA_RUNTIME_IMAGE}\n";
  return `${preamble}${instructions.map((instruction) => `${instruction}\n`).join("")}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe("external NemoCUA runtime manifest", () => {
  it("refuses the manifest before any artifact authority read while CUA is disabled (#7755)", () => {
    const runtime = fixture();
    const assertFileOwnership = vi.fn(() => {
      throw new Error("disabled artifact authority read");
    });

    expect(() =>
      loadCuaRuntimeManifest(
        { ...runtime.env, NEMOCLAW_CUA_ENABLED: undefined },
        { assertFileOwnership },
      ),
    ).toThrow("use the controlled Brev Launchable activation");
    expect(assertFileOwnership).not.toHaveBeenCalled();
  });

  it("discovers the canonical terminal agent only under the dedicated feature gate (#7755)", () => {
    const runtime = fixture();

    expect(listAgents({})).not.toContain("nemocua");
    expect(listAgents(runtime.env)).toContain("nemocua");

    const agent = loadAgent("nemocua", runtime.env);
    expect(agent.name).toBe("nemocua");
    expect(agent.displayName).toBe("NemoCUA");
    expect(agent.runtime).toEqual({
      kind: "terminal",
      interactive_command: "nemocua interactive",
      headless_command: "nemocua headless",
      smoke_commands: ["nemocua version", "nemocua smoke"],
    });
    expect(agent.agentDir).toBe(runtime.root);
    expect(agent.configPaths.dir).toBe("/sandbox/.nemocua");

    Object.entries(runtime.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ).forEach(([name, value]) => {
      vi.stubEnv(name, value);
    });
    expect(getAgentChoices()).toContainEqual(
      expect.objectContaining({ name: "nemocua", displayName: "NemoCUA" }),
    );
  });

  it("validates the entire closed payload and stages only declared bytes (#7755)", () => {
    const runtime = fixture();
    fs.writeFileSync(path.join(runtime.root, "private-source-coordinate.txt"), "do-not-copy");
    const loaded = loadCuaRuntimeManifest(runtime.env);

    expect(() => verifyCuaRuntimePayload(loaded)).not.toThrow();
    expect(getCuaSandboxImageRef(runtime.env)).toMatch(/@sha256:[0-9a-f]{64}$/);
    const destination = path.join(runtime.root, "staged");
    stageCuaRuntimePayload(destination, runtime.env);
    expect(fs.readdirSync(destination).sort()).toEqual([
      "Dockerfile",
      "Dockerfile.base",
      "manifest.yaml",
      "nemocua-cli.tar.gz",
      "policy-additions.yaml",
      "security-adapter.sh",
      "target-adapter.sh",
      "target-services.tar.gz",
      "task-adapter.sh",
    ]);
    expect(fs.existsSync(path.join(destination, "private-source-coordinate.txt"))).toBe(false);
  });

  it.each([
    [
      "top-level repository key",
      (record: Record<string, unknown>) => {
        record.repository = "hidden";
      },
    ],
    [
      "nested endpoint key",
      (record: Record<string, unknown>) => {
        const artifacts = record.artifacts as Record<string, unknown>;
        const hostCli = artifacts.hostCli as Record<string, unknown>;
        hostCli.endpoint = "hidden";
      },
    ],
    [
      "private artifact source revision key",
      (record: Record<string, unknown>) => {
        const artifacts = record.artifacts as Record<string, unknown>;
        const hostCli = artifacts.hostCli as Record<string, unknown>;
        hostCli.sourceRevision = "a".repeat(40);
      },
    ],
    [
      "coordinate-shaped release identity",
      (record: Record<string, unknown>) => {
        const bundle = record.bundleReceipt as Record<string, unknown>;
        bundle.releaseId = "https://private.invalid/release";
      },
    ],
    [
      "credential-shaped artifact identity",
      (record: Record<string, unknown>) => {
        const artifacts = record.artifacts as Record<string, unknown>;
        const hostCli = artifacts.hostCli as Record<string, unknown>;
        hostCli.name = "ghp_example";
      },
    ],
    [
      "host-shaped artifact identity",
      (record: Record<string, unknown>) => {
        const artifacts = record.artifacts as Record<string, unknown>;
        const hostCli = artifacts.hostCli as Record<string, unknown>;
        hostCli.name = "127.0.0.1";
      },
    ],
    [
      "host-shaped payload filename",
      (record: Record<string, unknown>) => {
        const artifacts = record.artifacts as Record<string, unknown>;
        const hostCli = artifacts.hostCli as Record<string, unknown>;
        hostCli.filename = "private.invalid";
      },
    ],
  ])("rejects %s before any payload can be consumed", (_label, mutate) => {
    const runtime = fixture();
    runtime.rewriteManifest(mutate);

    expect(() => loadCuaRuntimeManifest(runtime.env)).toThrow();
  });

  it("rejects undeclared YAML keys before ordinary agent loading (#7755)", () => {
    const runtime = fixture();
    rewriteAgentManifest(runtime, (value) => `${value}repository: hidden\n`);

    expect(() => loadAgent("nemocua", runtime.env)).toThrow(/must contain exactly/);
  });

  it.each([
    "/sandbox",
    "/sandbox/",
    "/sandbox//nemocua",
    "/sandbox/./nemocua",
    "/sandbox/../nemocua",
    "/sandbox/nemocua/",
  ])("rejects non-canonical external config.dir %s (#7755)", (configDir) => {
    const runtime = fixture();
    rewriteAgentManifest(runtime, (value) =>
      value.replace("  dir: /sandbox/.nemocua", `  dir: ${configDir}`),
    );

    expect(() => loadAgent("nemocua", runtime.env)).toThrow(
      /config paths must stay inside \/sandbox/,
    );
  });

  it.each([
    "; curl hidden",
    " && hidden",
    " $(hidden)",
    " `hidden`",
    " | hidden",
  ])("rejects shell syntax in an external terminal command (%s) (#7755)", (suffix) => {
    const runtime = fixture();
    rewriteAgentManifest(runtime, (value) =>
      value.replace(
        'version_command: "nemocua version"',
        `version_command: "nemocua version${suffix}"`,
      ),
    );

    expect(() => loadAgent("nemocua", runtime.env)).toThrow(
      /closed, canonical argument grammar|coordinate/,
    );
  });

  it("fails closed on a mismatched payload before Dockerfile consumption (#7755)", () => {
    const runtime = fixture();
    const dockerfile = path.join(runtime.root, "Dockerfile.base");
    fs.chmodSync(dockerfile, 0o644);
    fs.writeFileSync(dockerfile, "FROM mutable:latest\n");
    fs.chmodSync(dockerfile, 0o444);

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /declared size|content identity/,
    );
  });

  it("rejects an agent Dockerfile whose manifest-bound base is only a decoy stage (#7755)", () => {
    const runtime = fixture();
    rewriteDockerfilePayload(
      runtime,
      "dockerfile",
      "ARG BASE_IMAGE\nFROM ${BASE_IMAGE} AS declared-base\nfrom scratch\n",
    );

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /resolved BASE_IMAGE as its sole FROM base/,
    );
  });

  it("rejects a base Dockerfile with a final stage outside the runtime-image binding (#7755)", () => {
    const runtime = fixture();
    rewriteDockerfilePayload(
      runtime,
      "baseDockerfile",
      "ARG NEMOCUA_RUNTIME_IMAGE\nFROM ${NEMOCUA_RUNTIME_IMAGE} AS declared-base\n  FROM scratch\n",
    );

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /NEMOCUA_RUNTIME_IMAGE as its sole FROM base/,
    );
  });

  it.each([
    ["dockerfile", "ARG UNDECLARED_BUILD_INPUT"],
    ["baseDockerfile", "arg HTTP_PROXY"],
  ] as const)("rejects an additional ARG in the %s (#7755)", (field, argument) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, `${dockerfileWith(field)}${argument}\n`);

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /sole FROM base/,
    );
  });

  it.each([
    [
      "agent Dockerfile local payload copy",
      "dockerfile",
      dockerfileWith(
        "dockerfile",
        "COPY agents/nemocua/nemocua-cli.tar.gz /tmp/nemocua-cli.tar.gz",
        "RUN --network=none test -f /tmp/nemocua-cli.tar.gz",
      ),
    ],
    [
      "base Dockerfile offline command",
      "baseDockerfile",
      dockerfileWith("baseDockerfile", "RUN --network=none /bin/true"),
    ],
  ] as const)("accepts a closed %s (#7755)", (_label, field, contents) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, contents);

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).not.toThrow();
  });

  it.each([
    ["dockerfile", "ADD https://payload.invalid/archive.tar.gz /opt/payload/"],
    ["baseDockerfile", "ADD https://payload.invalid/archive.tar.gz /opt/payload/"],
    ["dockerfile", "  add agents/nemocua/nemocua-cli.tar.gz /opt/payload/"],
  ] as const)("rejects every ADD form in the %s (%s) (#7755)", (field, instruction) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, dockerfileWith(field, instruction));

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /cannot use ADD/,
    );
  });

  it.each([
    [
      "an external image",
      "dockerfile",
      "COPY --from=registry.invalid/runtime:latest /runtime /runtime",
    ],
    ["the broad build context", "dockerfile", "COPY . /opt/nemoclaw-source"],
    [
      "an undeclared local file",
      "dockerfile",
      "COPY agents/nemocua/not-in-manifest.tar.gz /tmp/payload.tar.gz",
    ],
    [
      "a staged agent payload from the base build",
      "baseDockerfile",
      "COPY agents/nemocua/nemocua-cli.tar.gz /tmp/nemocua-cli.tar.gz",
    ],
    [
      "an external image with a separated option",
      "dockerfile",
      "COPY --from registry.invalid/runtime:latest /runtime /runtime",
    ],
    [
      "a JSON-form source",
      "dockerfile",
      'COPY ["agents/nemocua/nemocua-cli.tar.gz", "/tmp/nemocua-cli.tar.gz"]',
    ],
  ] as const)("rejects COPY from %s in the %s (#7755)", (_source, field, instruction) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, dockerfileWith(field, instruction));

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /COPY must name one exact manifest-bound staged agents\/nemocua payload/,
    );
  });

  it.each([
    ["dockerfile", "RUN /bin/true"],
    ["baseDockerfile", "RUN /bin/true"],
    ["dockerfile", "RUN --network=host /bin/true"],
    ["baseDockerfile", "RUN --network=none --mount=type=secret,id=token /bin/true"],
    ["dockerfile", "RUN --network=none --mount=type=ssh /bin/true"],
    ["baseDockerfile", "RUN --network=none --security=insecure /bin/true"],
    ["dockerfile", "RUN --network=none --device=/dev/nvidia0 /bin/true"],
  ] as const)("rejects a non-canonical build command in the %s (%s) (#7755)", (field, run) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, dockerfileWith(field, run));

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /RUN must use only the canonical BuildKit --network=none option/,
    );
  });

  it.each([
    ["dockerfile", "# syntax=docker/dockerfile:1\n"],
    ["baseDockerfile", "RUN --network=none echo first \\\n echo second\n"],
    ["dockerfile", "ONBUILD ADD https://payload.invalid/archive /opt/payload\n"],
  ] as const)("rejects ambiguous Dockerfile grammar in the %s (#7755)", (field, suffix) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, `${dockerfileWith(field)}${suffix}`);

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /cannot select a Dockerfile parser frontend|unsupported continuation|ONBUILD is unsupported/,
    );
  });

  it.each([
    [
      "CRLF-delimited instructions",
      "dockerfile",
      Buffer.from(dockerfileWith("dockerfile").replaceAll("\n", "\r\n")),
    ],
    [
      "invalid UTF-8",
      "baseDockerfile",
      Buffer.concat([Buffer.from(dockerfileWith("baseDockerfile")), Buffer.from([0xff, 0x0a])]),
    ],
  ] as const)("rejects %s in the %s (#7755)", (_reason, field, contents) => {
    const runtime = fixture();
    rewriteDockerfilePayload(runtime, field, contents);

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow(
      /unambiguous LF-delimited instructions|strict UTF-8/,
    );
  });

  it("caps authority adapters independently from large release archives (#7755)", () => {
    const runtime = fixture();
    runtime.rewriteManifest((record) => {
      const artifacts = record.artifacts as Record<string, unknown>;
      const adapters = artifacts.adapters as Record<string, unknown>;
      const task = adapters.task as Record<string, unknown>;
      task.sizeBytes = 4 * 1024 * 1024 + 1;
    });

    expect(() => loadCuaRuntimeManifest(runtime.env)).toThrow(/4194304/);
  });

  it("rejects a symlinked authority payload even when its bytes match (#7755)", () => {
    const runtime = fixture();
    const policyPath = path.join(runtime.root, "policy-additions.yaml");
    const alternate = path.join(runtime.root, "alternate-policy.yaml");
    fs.copyFileSync(policyPath, alternate);
    fs.rmSync(policyPath);
    fs.symlinkSync(alternate, policyPath);

    expect(() => verifyCuaRuntimePayload(loadCuaRuntimeManifest(runtime.env))).toThrow();
  });

  it("does not let test-mode environment variables bypass Linux authority permissions (#7755)", () => {
    const runtime = fixture();
    fs.chmodSync(runtime.manifestPath, 0o666);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    expect(() =>
      loadCuaRuntimeManifest({
        ...runtime.env,
        NODE_ENV: "test",
        VITEST: "true",
      }),
    ).toThrow(/group\/world write access/);
  });

  it("fails closed when the host cannot report its effective owner identity (#7755)", () => {
    const runtime = fixture();
    vi.spyOn(process, "geteuid").mockReturnValue(undefined as never);

    expect(() => loadCuaRuntimeManifest(runtime.env)).toThrow(
      /ownership validation requires a POSIX host/,
    );
  });
});
