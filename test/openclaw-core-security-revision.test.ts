// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CORE_SECURITY_PINS,
  patchOpenClawCoreDependencies,
  verifyOpenClawCoreDependencies,
} from "../scripts/openclaw-core-security-revision.mts";

const tempDirs: string[] = [];

const layouts = {
  "2026.5.18": {
    shrinkwrap: false,
    replacements: {
      "@earendil-works/pi-agent-core": ["0.75.1", "pi-agent-core"],
      "@earendil-works/pi-ai": ["0.75.1", "pi-ai"],
      "@earendil-works/pi-coding-agent": ["0.75.1", "pi-coding-agent"],
      "@earendil-works/pi-tui": ["0.75.1", "pi-tui"],
      "body-parser": ["2.2.2", "body-parser"],
      "brace-expansion": ["5.0.6", "brace-expansion"],
      hono: ["4.12.22", "hono"],
      "linkify-it": ["5.0.0", "linkify-it"],
      "markdown-it": ["14.1.1", "markdown-it"],
      protobufjs: ["7.6.1", "protobufjs-7"],
      undici: ["8.3.0", "undici"],
      ws: ["8.20.1", "ws"],
    },
    rootDirect: {
      "@earendil-works/pi-agent-core": "0.75.1",
      "@earendil-works/pi-ai": "0.75.1",
      "@earendil-works/pi-coding-agent": "0.75.1",
      "@earendil-works/pi-tui": "0.75.1",
      "markdown-it": "14.1.1",
      undici: "8.3.0",
      ws: "8.20.1",
    },
  },
  "2026.5.22": {
    shrinkwrap: true,
    replacements: {
      "@earendil-works/pi-agent-core": ["0.75.4", "pi-agent-core", "0.75.4"],
      "@earendil-works/pi-ai": ["0.75.4", "pi-ai", "0.75.4"],
      "@earendil-works/pi-coding-agent": ["0.75.4", "pi-coding-agent", "0.75.4"],
      "@earendil-works/pi-tui": ["0.75.4", "pi-tui", "0.75.4"],
      "body-parser": ["2.2.2", "body-parser", "2.2.2"],
      "brace-expansion": ["5.0.6", "brace-expansion", "5.0.6"],
      hono: ["4.12.18", "hono", "4.12.18"],
      "linkify-it": ["5.0.0", "linkify-it", "5.0.0"],
      "markdown-it": ["14.1.1", "markdown-it", "14.1.1"],
      protobufjs: ["8.4.0", "protobufjs-8", "8.4.0"],
      qs: ["6.14.2", "qs", "6.14.2"],
      undici: ["8.3.0", "undici", "8.3.0"],
      ws: ["8.20.1", "ws", "8.20.1"],
    },
    rootDirect: {
      "@earendil-works/pi-agent-core": "0.75.4",
      "@earendil-works/pi-ai": "0.75.4",
      "@earendil-works/pi-coding-agent": "0.75.4",
      "@earendil-works/pi-tui": "0.75.4",
      "markdown-it": "14.1.1",
      undici: "8.3.0",
      ws: "8.20.1",
    },
  },
  "2026.5.27": {
    shrinkwrap: true,
    replacements: {
      "@earendil-works/pi-agent-core": ["0.75.5", "pi-agent-core", "0.75.5"],
      "@earendil-works/pi-ai": ["0.75.5", "pi-ai", "0.75.5"],
      "@earendil-works/pi-coding-agent": ["0.75.5", "pi-coding-agent", "0.75.5"],
      "@earendil-works/pi-tui": ["0.75.5", "pi-tui", "0.75.5"],
      "body-parser": ["2.2.2", "body-parser", "2.2.2"],
      "brace-expansion": ["5.0.6", "brace-expansion", "5.0.6"],
      hono: ["4.12.18", "hono", "4.12.18"],
      "linkify-it": ["5.0.0", "linkify-it", "5.0.0"],
      "markdown-it": ["14.1.1", "markdown-it", "14.1.1"],
      protobufjs: ["8.4.0", "protobufjs-8", "8.4.0"],
      undici: ["8.3.0", "undici", "8.3.0"],
    },
    rootDirect: {
      "@earendil-works/pi-agent-core": "0.75.5",
      "@earendil-works/pi-ai": "0.75.5",
      "@earendil-works/pi-coding-agent": "0.75.5",
      "@earendil-works/pi-tui": "0.75.5",
      "markdown-it": "14.1.1",
      undici: "8.3.0",
    },
  },
  "2026.6.10": {
    shrinkwrap: true,
    replacements: {
      "body-parser": ["2.3.0", "body-parser", "2.2.2"],
      "brace-expansion": ["5.0.7", "brace-expansion", "5.0.6"],
      hono: ["4.12.30", "hono", "4.12.25"],
      protobufjs: ["7.6.5", "protobufjs-7", "7.6.3"],
      qs: ["6.15.3", "qs", "6.15.2"],
    },
    rootDirect: {},
  },
} as const;

function writePackage(root: string, name: string, version: string, dependencies = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version, dependencies }),
  );
  fs.writeFileSync(path.join(root, "payload.js"), `${name}@${version}\n`);
}

function fixture(openClawVersion: keyof typeof layouts) {
  const layout = layouts[openClawVersion];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-core-revision-"));
  tempDirs.push(root);
  const openClawRoot = path.join(root, "openclaw");
  const replacementRoot = path.join(root, "replacements");
  const rootDependencies = { ...layout.rootDirect };
  writePackage(openClawRoot, "openclaw", openClawVersion, rootDependencies);

  for (const [name, [observed]] of Object.entries(layout.replacements)) {
    writePackage(path.join(openClawRoot, "node_modules", name), name, observed);
  }
  const usedPins = new Set([
    ...Object.values(layout.replacements).map(([, pin]) => pin),
    "content-type",
  ]);
  for (const pinKey of usedPins) {
    const pin = CORE_SECURITY_PINS[pinKey];
    const packageDependencies =
      pinKey === "body-parser"
        ? { "content-type": "^2.0.0" }
        : pinKey === "pi-coding-agent"
          ? { undici: "8.3.0" }
          : pinKey === "markdown-it"
            ? { "linkify-it": "^5.0.2" }
            : {};
    writePackage(path.join(replacementRoot, pinKey), pin.name, pin.version, packageDependencies);
  }

  if (layout.shrinkwrap) {
    const packages: Record<string, unknown> = {
      "": { dependencies: { ...rootDependencies } },
    };
    for (const [name, replacement] of Object.entries(layout.replacements)) {
      packages[`node_modules/${name}`] = {
        version: replacement[2],
        resolved: "https://registry.npmjs.org/old.tgz",
        integrity: "old-integrity",
        dependencies: {},
      };
    }
    fs.writeFileSync(
      path.join(openClawRoot, "npm-shrinkwrap.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
  }
  return { openClawRoot, replacementRoot };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("historical OpenClaw core dependency security revisions (#7272)", () => {
  it("stages every reviewed artifact and enforces a zero-advisory build gate", () => {
    const dockerfile = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "Dockerfile.openclaw-tar-security-revision"),
      "utf8",
    );
    for (const pin of Object.values(CORE_SECURITY_PINS)) {
      expect(dockerfile).toContain(`"${pin.name}@${pin.version}"`);
      expect(dockerfile).toContain(`"${pin.integrity}"`);
      expect(dockerfile).toContain(`"${pin.tarball}"`);
    }
    expect(dockerfile).toContain("npm audit --omit=dev --ignore-scripts --audit-level=low");
    expect(dockerfile).toContain("audit.metadata?.vulnerabilities?.total !== 0");
  });

  it.each(
    Object.keys(layouts) as (keyof typeof layouts)[],
  )("patches and verifies the reviewed %s graph", (openClawVersion) => {
    const target = fixture(openClawVersion);
    patchOpenClawCoreDependencies({
      ...target,
      expectedOpenClawVersion: openClawVersion,
    });
    expect(() =>
      verifyOpenClawCoreDependencies({
        openClawRoot: target.openClawRoot,
        expectedOpenClawVersion: openClawVersion,
      }),
    ).not.toThrow();
    expect(
      fs.existsSync(
        path.join(
          target.openClawRoot,
          "node_modules",
          "body-parser",
          "node_modules",
          "content-type",
          "package.json",
        ),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(target.openClawRoot, "npm-shrinkwrap.json"))).toBe(
      layouts[openClawVersion].shrinkwrap,
    );
  });

  it("fails closed before replacing a drifted historical package", () => {
    const target = fixture("2026.5.22");
    writePackage(path.join(target.openClawRoot, "node_modules", "undici"), "undici", "8.3.1");
    expect(() =>
      patchOpenClawCoreDependencies({
        ...target,
        expectedOpenClawVersion: "2026.5.22",
      }),
    ).toThrow("installed undici state does not match the review");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(target.openClawRoot, "node_modules", "body-parser", "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2.2.2");
  });

  it("rejects unsafe members in a reviewed replacement package", () => {
    const target = fixture("2026.5.27");
    fs.symlinkSync("package.json", path.join(target.replacementRoot, "markdown-it", "unsafe-link"));
    expect(() =>
      patchOpenClawCoreDependencies({
        ...target,
        expectedOpenClawVersion: "2026.5.27",
      }),
    ).toThrow("unsafe member");
  });
});
