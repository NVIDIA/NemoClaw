// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

const {
  getBlueprintMaxOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  versionGte,
} = require("../dist/lib/onboard") as {
  getBlueprintMaxOpenshellVersion: (rootDir?: string) => string | null;
  getBlueprintMinOpenshellVersion: (rootDir?: string) => string | null;
  getInstalledOpenshellVersion: (versionOutput?: string | null) => string | null;
  getStableGatewayImageRef: (versionOutput?: string | null) => string | null;
  versionGte: (left?: string | null, right?: string | null) => boolean;
};

const installModule = require("../dist/lib/onboard/openshell-install") as {
  parseOpenshellReleaseTag: (tag: unknown) => string | null;
  resolveOpenshellInstallVersion: (
    available: readonly string[],
    options: { max: string | null },
    helpers: { versionGte: (a: string, b: string) => boolean },
  ) => {
    kind: "pin" | "no-max" | "incompatible";
    version?: string;
    latest?: string | null;
    max?: string;
    message?: string;
    reason?: "latest" | "max-cap";
  };
};

const pinModule = require("../dist/lib/onboard/openshell-pin") as {
  resolveOpenshellInstallPin: (deps: {
    getBlueprintMaxOpenshellVersion: () => string | null;
    versionGte: (a: string, b: string) => boolean;
    listReleases?: () => string[] | null;
    log?: (m: string) => void;
  }) => { kind: "pin" | "no-max" | "incompatible"; version?: string; message?: string };
  computeOpenshellInstallEnv: (
    baseEnv: Record<string, string | undefined>,
    deps: {
      getBlueprintMinOpenshellVersion?: () => string | null;
      getBlueprintMaxOpenshellVersion: () => string | null;
      versionGte: (a: string, b: string) => boolean;
      listReleases?: () => string[] | null;
      log?: (m: string) => void;
    },
  ) => { env: Record<string, string | undefined> | null };
};

const helpers = { versionGte };

describe("OpenShell version helpers", () => {
  it("compares semver-like versions", () => {
    expect(versionGte("0.1.0", "0.1.0")).toBe(true);
    expect(versionGte("0.1.0", "0.0.20")).toBe(true);
    expect(versionGte("0.0.20", "0.1.0")).toBe(false);
    expect(versionGte("1.2.3", "1.2.4")).toBe(false);
    expect(versionGte("1.2.4", "1.2.3")).toBe(true);
    expect(versionGte("0.0.21", "0.0.20")).toBe(true);
    expect(versionGte("1.0", "1.0.0")).toBe(true);
    expect(versionGte("", "0.0.0")).toBe(true);
  });

  it("reads min_openshell_version from blueprint.yaml", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-min-version-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintDir, "blueprint.yaml"),
      [
        'version: "0.1.0"',
        'min_openshell_version: "0.1.0"',
        'min_openclaw_version: "2026.3.0"',
      ].join("\n"),
    );
    try {
      expect(getBlueprintMinOpenshellVersion(tmpDir)).toBe("0.1.0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for missing or unparseable min_openshell_version", () => {
    expect(getBlueprintMinOpenshellVersion(path.join(os.tmpdir(), `missing-${Date.now()}`))).toBe(
      null,
    );

    const noFieldDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-no-field-"));
    fs.mkdirSync(path.join(noFieldDir, "nemoclaw-blueprint"), { recursive: true });
    fs.writeFileSync(path.join(noFieldDir, "nemoclaw-blueprint", "blueprint.yaml"), 'version: "0.1.0"\n');
    try {
      expect(getBlueprintMinOpenshellVersion(noFieldDir)).toBe(null);
    } finally {
      fs.rmSync(noFieldDir, { recursive: true, force: true });
    }

    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-bad-yaml-"));
    fs.mkdirSync(path.join(badDir, "nemoclaw-blueprint"), { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "nemoclaw-blueprint", "blueprint.yaml"),
      "this is: : not valid: yaml: [",
    );
    try {
      expect(getBlueprintMinOpenshellVersion(badDir)).toBe(null);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }

    const wrongTypeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-wrong-type-"));
    fs.mkdirSync(path.join(wrongTypeDir, "nemoclaw-blueprint"), { recursive: true });
    fs.writeFileSync(
      path.join(wrongTypeDir, "nemoclaw-blueprint", "blueprint.yaml"),
      "min_openshell_version: 1.5\n",
    );
    try {
      expect(getBlueprintMinOpenshellVersion(wrongTypeDir)).toBe(null);
    } finally {
      fs.rmSync(wrongTypeDir, { recursive: true, force: true });
    }

    const badShapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-bad-shape-"));
    fs.mkdirSync(path.join(badShapeDir, "nemoclaw-blueprint"), { recursive: true });
    fs.writeFileSync(
      path.join(badShapeDir, "nemoclaw-blueprint", "blueprint.yaml"),
      'min_openshell_version: "latest"\n',
    );
    try {
      expect(getBlueprintMinOpenshellVersion(badShapeDir)).toBe(null);
    } finally {
      fs.rmSync(badShapeDir, { recursive: true, force: true });
    }
  });

  it("shipped blueprint.yaml exposes parseable min/max OpenShell versions", () => {
    const min = getBlueprintMinOpenshellVersion(repoRoot);
    const max = getBlueprintMaxOpenshellVersion(repoRoot);
    expect(min).not.toBe(null);
    expect(max).not.toBe(null);
    expect(/^[0-9]+\.[0-9]+\.[0-9]+/.test(min || "")).toBe(true);
    expect(/^[0-9]+\.[0-9]+\.[0-9]+/.test(max || "")).toBe(true);
    expect(versionGte(max, min)).toBe(true);
  });

  it("reads max_openshell_version from blueprint.yaml", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-max-version-"));
    const blueprintDir = path.join(tmpDir, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintDir, "blueprint.yaml"),
      [
        'version: "0.1.0"',
        'min_openshell_version: "0.0.32"',
        'max_openshell_version: "0.0.32"',
        'min_openclaw_version: "2026.3.0"',
      ].join("\n"),
    );
    try {
      expect(getBlueprintMaxOpenshellVersion(tmpDir)).toBe("0.0.32");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for missing or absent max_openshell_version", () => {
    expect(getBlueprintMaxOpenshellVersion(path.join(os.tmpdir(), `missing-${Date.now()}`))).toBe(
      null,
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-no-max-field-"));
    fs.mkdirSync(path.join(tmpDir, "nemoclaw-blueprint"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "nemoclaw-blueprint", "blueprint.yaml"), 'version: "0.1.0"\n');
    try {
      expect(getBlueprintMaxOpenshellVersion(tmpDir)).toBe(null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses installed OpenShell versions into stable gateway image refs", () => {
    expect(getInstalledOpenshellVersion("openshell 0.0.12")).toBe("0.0.12");
    expect(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("0.0.13");
    expect(getInstalledOpenshellVersion("bogus")).toBe(null);
    expect(getStableGatewayImageRef("openshell 0.0.12")).toBe(
      "ghcr.io/nvidia/openshell/cluster:0.0.12",
    );
    expect(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe(
      "ghcr.io/nvidia/openshell/cluster:0.0.13",
    );
    expect(getStableGatewayImageRef("bogus")).toBe(null);
  });
});

describe("resolveOpenshellInstallVersion", () => {
  it("picks the highest available release ≤ max when latest exceeds max", () => {
    const result = installModule.resolveOpenshellInstallVersion(
      ["v0.0.34", "0.0.35", "v0.0.38"],
      { max: "0.0.36" },
      helpers,
    );
    expect(result.kind).toBe("pin");
    expect(result.version).toBe("0.0.35");
    expect(result.reason).toBe("max-cap");
    expect(result.latest).toBe("0.0.38");
  });

  it("picks latest unchanged when latest is ≤ max", () => {
    const result = installModule.resolveOpenshellInstallVersion(
      ["v0.0.34", "0.0.35", "v0.0.36"],
      { max: "0.0.39" },
      helpers,
    );
    expect(result.kind).toBe("pin");
    expect(result.version).toBe("0.0.36");
    expect(result.reason).toBe("latest");
    expect(result.latest).toBe("0.0.36");
  });

  it("returns incompatible when no release ≤ max exists", () => {
    const result = installModule.resolveOpenshellInstallVersion(
      ["v0.0.38", "0.0.39"],
      { max: "0.0.36" },
      helpers,
    );
    expect(result.kind).toBe("incompatible");
    expect(result.latest).toBe("0.0.39");
    expect(result.max).toBe("0.0.36");
    expect(result.message).toContain("0.0.39");
    expect(result.message).toContain("0.0.36");
  });

  it("falls back to legacy fetch behavior when max is missing or malformed", () => {
    expect(
      installModule.resolveOpenshellInstallVersion(["v0.0.38", "0.0.39"], { max: null }, helpers)
        .kind,
    ).toBe("no-max");
    for (const max of ["", "-1.0.0", "not-a-version", "v"] as const) {
      expect(installModule.resolveOpenshellInstallVersion(["v0.0.38"], { max }, helpers).kind).toBe(
        "no-max",
      );
    }
  });

  it("silently drops malformed entries from the available list", () => {
    const result = installModule.resolveOpenshellInstallVersion(
      ["", "v0.0.35", "-1.0.0", "not-a-version", "v0.0.34"],
      { max: "0.0.36" },
      helpers,
    );
    expect(result.kind).toBe("pin");
    expect(result.version).toBe("0.0.35");
  });

  it("parseOpenshellReleaseTag strips leading v and rejects malformed input", () => {
    expect(installModule.parseOpenshellReleaseTag("v0.0.39")).toBe("0.0.39");
    expect(installModule.parseOpenshellReleaseTag("0.0.39")).toBe("0.0.39");
    expect(installModule.parseOpenshellReleaseTag("")).toBe(null);
    expect(installModule.parseOpenshellReleaseTag("   ")).toBe(null);
    expect(installModule.parseOpenshellReleaseTag("-1.0.0")).toBe(null);
    expect(installModule.parseOpenshellReleaseTag("0.0")).toBe(null);
    expect(installModule.parseOpenshellReleaseTag(42)).toBe(null);
    expect(installModule.parseOpenshellReleaseTag(null)).toBe(null);
  });

  it("matches the DGX Spark repro: latest=0.0.38 max=0.0.36 picks 0.0.36", () => {
    const result = installModule.resolveOpenshellInstallVersion(
      ["v0.0.36", "v0.0.37", "v0.0.38"],
      { max: "0.0.36" },
      helpers,
    );
    expect(result.kind).toBe("pin");
    expect(result.version).toBe("0.0.36");
    expect(result.reason).toBe("max-cap");
  });
});

describe("resolveOpenshellInstallPin", () => {
  it("returns no-max when max is absent or release discovery fails", () => {
    expect(
      pinModule.resolveOpenshellInstallPin({
        getBlueprintMaxOpenshellVersion: () => null,
        versionGte,
        listReleases: () => ["v0.0.38"],
      }).kind,
    ).toBe("no-max");
    expect(
      pinModule.resolveOpenshellInstallPin({
        getBlueprintMaxOpenshellVersion: () => "0.0.36",
        versionGte,
        listReleases: () => null,
      }).kind,
    ).toBe("no-max");
    expect(
      pinModule.resolveOpenshellInstallPin({
        getBlueprintMaxOpenshellVersion: () => "0.0.36",
        versionGte,
        listReleases: () => [],
      }).kind,
    ).toBe("no-max");
  });

  it("pins to highest ≤ max when releases exceed the cap", () => {
    const logged: string[] = [];
    const result = pinModule.resolveOpenshellInstallPin({
      getBlueprintMaxOpenshellVersion: () => "0.0.36",
      versionGte,
      listReleases: () => ["v0.0.36", "v0.0.37", "v0.0.38"],
      log: (message) => logged.push(message),
    });
    expect(result.kind).toBe("pin");
    expect(result.version).toBe("0.0.36");
    expect(logged.join("\n")).toContain("0.0.36");
    expect(logged.join("\n")).toContain("0.0.38");
  });

  it("surfaces incompatible when no published release ≤ max exists", () => {
    const result = pinModule.resolveOpenshellInstallPin({
      getBlueprintMaxOpenshellVersion: () => "0.0.36",
      versionGte,
      listReleases: () => ["v0.0.38", "v0.0.39"],
    });
    expect(result.kind).toBe("incompatible");
    expect(result.message ?? "").toContain("0.0.36");
    expect(result.message ?? "").toContain("0.0.39");
  });
});

describe("computeOpenshellInstallEnv", () => {
  it("overlays MIN/MAX/PIN env vars from blueprint when latest exceeds max", () => {
    const result = pinModule.computeOpenshellInstallEnv(
      { EXISTING: "preserved" },
      {
        getBlueprintMinOpenshellVersion: () => "0.0.39",
        getBlueprintMaxOpenshellVersion: () => "0.0.39",
        versionGte,
        listReleases: () => ["v0.0.38", "v0.0.39", "v0.0.42"],
      },
    );
    expect(result.env).not.toBe(null);
    expect(result.env?.EXISTING).toBe("preserved");
    expect(result.env?.NEMOCLAW_OPENSHELL_MIN_VERSION).toBe("0.0.39");
    expect(result.env?.NEMOCLAW_OPENSHELL_MAX_VERSION).toBe("0.0.39");
    expect(result.env?.NEMOCLAW_OPENSHELL_PIN_VERSION).toBe("0.0.39");
  });

  it("overlays MIN/MAX but no PIN when release discovery fails", () => {
    const result = pinModule.computeOpenshellInstallEnv(
      {},
      {
        getBlueprintMinOpenshellVersion: () => "0.0.39",
        getBlueprintMaxOpenshellVersion: () => "0.0.39",
        versionGte,
        listReleases: () => null,
      },
    );
    expect(result.env).not.toBe(null);
    expect(result.env?.NEMOCLAW_OPENSHELL_MIN_VERSION).toBe("0.0.39");
    expect(result.env?.NEMOCLAW_OPENSHELL_MAX_VERSION).toBe("0.0.39");
    expect(result.env?.NEMOCLAW_OPENSHELL_PIN_VERSION).toBeUndefined();
  });

  it("returns the base env unchanged when blueprint exposes no min/max", () => {
    const baseEnv = { ONLY_THIS: "value" };
    const result = pinModule.computeOpenshellInstallEnv(baseEnv, {
      getBlueprintMinOpenshellVersion: () => null,
      getBlueprintMaxOpenshellVersion: () => null,
      versionGte,
      listReleases: () => ["v0.0.38"],
    });
    expect(result.env).toBe(baseEnv);
  });

  it("aborts when no release ≤ max exists", () => {
    const result = pinModule.computeOpenshellInstallEnv(
      {},
      {
        getBlueprintMaxOpenshellVersion: () => "0.0.36",
        versionGte,
        listReleases: () => ["v0.0.38", "v0.0.39"],
      },
    );
    expect(result.env).toBe(null);
  });
});
