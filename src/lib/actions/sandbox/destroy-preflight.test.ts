// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { queryDockerSandboxNameClaims } from "../../onboard/openshell-docker-sandbox-containers";
import {
  renderDestroySandboxContainerIdentityRefusal,
  resolveDestroySandboxContainerIdentity,
} from "./destroy-preflight";

const OWNED_ID = "a".repeat(64);
const FOREIGN_ID = "b".repeat(64);
const EXPECTED_INSPECT_FORMAT =
  '[{{json .Id}},{{json .Name}},{{json (index .Config.Labels "openshell.ai/managed-by")}},' +
  '{{json (index .Config.Labels "openshell.ai/sandbox-workspace")}}]';

function inspectLine(id: string, name: string, managedBy: string, workspace: string): string {
  return JSON.stringify([id, `/${name}`, managedBy, workspace]);
}

function dockerRunForContainers(lines: string[]) {
  const ids = lines.map((line) => (JSON.parse(line) as string[])[0]).join("\n");
  return vi.fn((args: readonly string[]) => ({
    status: 0,
    stdout: args[0] === "ps" ? `${ids}\n` : `${lines.join("\n")}\n`,
    stderr: "",
  }));
}

describe("docker sandbox-name claim query (#8999)", () => {
  it("enumerates label claims without the managed-by filter and pins both argvs", () => {
    const dockerRun = dockerRunForContainers([
      inspectLine(OWNED_ID, "openshell-alpha", "openshell", "default"),
      inspectLine(FOREIGN_ID, "alpha-foreign", "", "foreign"),
    ]);
    const claims = queryDockerSandboxNameClaims("alpha", { dockerRun });
    expect(claims).toEqual({
      ok: true,
      rows: [
        { id: OWNED_ID, name: "openshell-alpha", managedBy: "openshell", workspace: "default" },
        { id: FOREIGN_ID, name: "alpha-foreign", managedBy: "", workspace: "foreign" },
      ],
    });
    expect(dockerRun).toHaveBeenNthCalledWith(
      1,
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/sandbox-name=alpha",
        "--format",
        "{{.ID}}",
      ],
      { ignoreError: true, suppressOutput: true, timeout: 30_000 },
    );
    expect(dockerRun).toHaveBeenNthCalledWith(
      2,
      ["inspect", "--type", "container", "--format", EXPECTED_INSPECT_FORMAT, OWNED_ID, FOREIGN_ID],
      { ignoreError: true, suppressOutput: true, timeout: 30_000 },
    );
  });

  it("reports zero claims as ok with no inspect call", () => {
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    expect(queryDockerSandboxNameClaims("alpha", { dockerRun })).toEqual({ ok: true, rows: [] });
    expect(dockerRun).toHaveBeenCalledTimes(1);
  });

  it("distinguishes Docker failures and malformed answers from zero claims", () => {
    const psFails = vi.fn(() => ({ status: 1, stdout: "", stderr: "daemon down" }));
    expect(queryDockerSandboxNameClaims("alpha", { dockerRun: psFails })).toMatchObject({
      ok: false,
      error: expect.stringContaining("daemon down"),
    });
    const malformedId = vi.fn(() => ({ status: 0, stdout: "not-an-id\n", stderr: "" }));
    expect(queryDockerSandboxNameClaims("alpha", { dockerRun: malformedId })).toMatchObject({
      ok: false,
      error: expect.stringContaining("malformed container identity"),
    });
    const inspectFails = vi.fn((args: readonly string[]) => ({
      status: args[0] === "ps" ? 0 : 1,
      stdout: args[0] === "ps" ? `${OWNED_ID}\n` : "",
      stderr: args[0] === "ps" ? "" : "no such object",
    }));
    expect(queryDockerSandboxNameClaims("alpha", { dockerRun: inspectFails })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no such object"),
    });
    const partialInspect = vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout:
        args[0] === "ps"
          ? `${OWNED_ID}\n${FOREIGN_ID}\n`
          : `${inspectLine(OWNED_ID, "openshell-alpha", "openshell", "default")}\n`,
      stderr: "",
    }));
    expect(queryDockerSandboxNameClaims("alpha", { dockerRun: partialInspect })).toMatchObject({
      ok: false,
      error: expect.stringContaining("every container"),
    });
    const nulByte = vi.fn(() => ({ status: 0, stdout: "\0", stderr: "" }));
    expect(queryDockerSandboxNameClaims("alpha", { dockerRun: nulByte })).toMatchObject({
      ok: false,
      error: expect.stringContaining("oversized or malformed"),
    });
  });
});

describe("destroy container identity resolution (#8999)", () => {
  it("flags the issue repro: a foreign container that copies only the name label", () => {
    const queryClaims = vi.fn(() => ({
      ok: true as const,
      rows: [
        { id: OWNED_ID, name: "openshell-alpha", managedBy: "openshell", workspace: "default" },
        { id: FOREIGN_ID, name: "alpha-foreign", managedBy: "", workspace: "foreign" },
      ],
    }));
    expect(resolveDestroySandboxContainerIdentity("alpha", "docker", { queryClaims })).toEqual({
      outcome: "ambiguous",
      rows: [
        { id: OWNED_ID, name: "openshell-alpha", managedBy: "openshell", workspace: "default" },
        { id: FOREIGN_ID, name: "alpha-foreign", managedBy: "", workspace: "foreign" },
      ],
    });
  });

  it("accepts a single managed container and skips non-Docker drivers", () => {
    const singleClaim = vi.fn(() => ({
      ok: true as const,
      rows: [
        { id: OWNED_ID, name: "openshell-alpha", managedBy: "openshell", workspace: "default" },
      ],
    }));
    expect(
      resolveDestroySandboxContainerIdentity("alpha", "docker", { queryClaims: singleClaim }),
    ).toEqual({ outcome: "unambiguous" });
    const neverQueried = vi.fn(() => ({ ok: true as const, rows: [] }));
    expect(
      resolveDestroySandboxContainerIdentity("alpha", "kubernetes", { queryClaims: neverQueried }),
    ).toEqual({ outcome: "skipped" });
    expect(neverQueried).not.toHaveBeenCalled();
    expect(
      resolveDestroySandboxContainerIdentity("alpha", undefined, { queryClaims: neverQueried }),
    ).toEqual({ outcome: "unambiguous" });
  });

  it("reports unavailable with the Docker error instead of guessing", () => {
    const queryClaims = vi.fn(() => ({ ok: false as const, rows: [] as [], error: "boom" }));
    expect(resolveDestroySandboxContainerIdentity("alpha", "docker", { queryClaims })).toEqual({
      outcome: "unavailable",
      error: "boom",
    });
  });
});

describe("destroy container identity refusal rendering (#8999)", () => {
  it("lists each claim, states preservation, remediation, and the --force policy", () => {
    const lines = renderDestroySandboxContainerIdentityRefusal("alpha", [
      { id: OWNED_ID, name: "openshell-alpha", managedBy: "openshell", workspace: "default" },
      { id: FOREIGN_ID, name: "alpha-foreign", managedBy: "", workspace: "foreign" },
    ]);
    const text = lines.join("\n");
    expect(text).toContain("Refusing to destroy sandbox 'alpha'");
    expect(text).toContain("openshell.ai/sandbox-name=alpha");
    expect(text).toContain(OWNED_ID.slice(0, 12));
    expect(text).toContain(FOREIGN_ID.slice(0, 12));
    expect(text).toContain("NemoClaw did not change any container, image, or local sandbox state.");
    expect(text).toContain("docker inspect");
    expect(text).toContain("docker rm -f");
    expect(text).toContain("rerun destroy");
    expect(text).toContain("'destroy --force' skips this check");
  });

  it("JSON-quotes label values so an embedded quote cannot forge a field", () => {
    const lines = renderDestroySandboxContainerIdentityRefusal("alpha", [
      {
        id: FOREIGN_ID,
        name: "alpha-foreign",
        managedBy: "openshell' openshell.ai/sandbox-workspace='default",
        workspace: "foo' bar\"baz",
      },
    ]);
    const text = lines.join("\n");
    expect(text).toContain(
      "openshell.ai/managed-by=\"openshell' openshell.ai/sandbox-workspace='default\"",
    );
    expect(text).toContain('openshell.ai/sandbox-workspace="foo\' bar\\"baz"');
    expect(text).not.toContain("openshell.ai/sandbox-workspace='default'");
  });

  it("drops control characters from attacker-controlled names and label values", () => {
    const lines = renderDestroySandboxContainerIdentityRefusal("alpha", [
      {
        id: FOREIGN_ID,
        name: "evil\u001b[2K\rname",
        managedBy: "openshell",
        workspace: "x\nSafe: rerun with --force",
      },
    ]);
    const text = lines.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("evil?[2K?name");
    expect(text).toContain("x?Safe: rerun with --force");
  });
});
