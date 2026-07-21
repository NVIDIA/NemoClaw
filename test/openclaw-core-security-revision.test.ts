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
      "@mariozechner/clipboard": ["0.3.6", "clipboard"],
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
      "@mariozechner/clipboard": ["0.3.6", "clipboard", "0.3.6"],
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
      "@mariozechner/clipboard": ["0.3.6", "clipboard", "0.3.6"],
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

function writePackage(
  root: string,
  name: string,
  version: string,
  dependencies = {},
  metadata: Record<string, unknown> = {},
) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version, dependencies, ...metadata }),
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
    const installedDependencies =
      name === "protobufjs" && openClawVersion === "2026.5.18"
        ? { "@protobufjs/inquire": "^1.1.2" }
        : {};
    const installedMetadata =
      name === "@earendil-works/pi-tui" && openClawVersion === "2026.5.18"
        ? { optionalDependencies: { koffi: "^2.9.0" } }
        : name === "@earendil-works/pi-tui" && openClawVersion === "2026.5.22"
          ? { optionalDependencies: { koffi: "2.16.2" } }
          : {};
    writePackage(
      path.join(openClawRoot, "node_modules", name),
      name,
      observed,
      installedDependencies,
      installedMetadata,
    );
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
        : pinKey === "pi-ai"
          ? {
              "@anthropic-ai/sdk": "0.91.1",
              "@aws-sdk/client-bedrock-runtime": "3.1048.0",
              "@google/genai": "1.52.0",
              "@smithy/node-http-handler": "4.7.3",
              openai: "6.26.0",
            }
          : pinKey === "pi-coding-agent"
            ? { undici: "8.3.0" }
            : pinKey === "markdown-it"
              ? { "linkify-it": "^5.0.2" }
              : {};
    writePackage(
      path.join(replacementRoot, pinKey),
      pin.name,
      pin.version,
      packageDependencies,
      pinKey === "pi-coding-agent"
        ? { optionalDependencies: { "@mariozechner/clipboard": "0.3.9" } }
        : {},
    );
  }
  const compatibilityVersions = {
    "2026.5.18": {
      "@anthropic-ai/sdk": "0.91.1",
      "@aws-sdk/client-bedrock-runtime": "3.1053.0",
      "@google/genai": "2.3.0",
      "@smithy/node-http-handler": "4.7.4",
      openai: "6.38.0",
    },
    "2026.5.22": {
      "@anthropic-ai/sdk": "0.97.1",
      "@aws-sdk/client-bedrock-runtime": "3.1051.0",
      "@google/genai": "2.5.0",
      "@smithy/node-http-handler": "4.7.3",
      openai: "6.38.0",
    },
    "2026.5.27": {
      "@anthropic-ai/sdk": "0.98.0",
      "@aws-sdk/client-bedrock-runtime": "3.1053.0",
      "@google/genai": "2.6.0",
      "@smithy/node-http-handler": "4.7.4",
      openai: "6.39.0",
    },
    "2026.6.10": {},
  } as const;
  for (const [name, version] of Object.entries(compatibilityVersions[openClawVersion])) {
    writePackage(path.join(openClawRoot, "node_modules", name), name, version);
  }
  if (openClawVersion === "2026.5.18") {
    writePackage(
      path.join(openClawRoot, "node_modules", "@protobufjs/inquire"),
      "@protobufjs/inquire",
      "1.1.2",
    );
    writePackage(path.join(openClawRoot, "node_modules", "koffi"), "koffi", "2.16.2");
  } else if (openClawVersion === "2026.5.22") {
    writePackage(path.join(openClawRoot, "node_modules", "koffi"), "koffi", "2.16.2");
  }

  const packages: Record<string, unknown> = {
    "": { dependencies: { ...rootDependencies } },
  };
  for (const [name, replacement] of Object.entries(layout.replacements)) {
    packages[`node_modules/${name}`] = {
      version: replacement[2],
      resolved: "https://registry.npmjs.org/old.tgz",
      integrity: "old-integrity",
      dependencies: {},
      ...(name === "@earendil-works/pi-coding-agent"
        ? { optionalDependencies: { "@mariozechner/clipboard": "0.3.6" } }
        : {}),
      ...(name === "@earendil-works/pi-tui" && openClawVersion === "2026.5.22"
        ? {
            optionalDependencies: { koffi: "2.16.2" },
            peerDependencies: { "stale-peer": "1.0.0" },
          }
        : {}),
    };
  }
  if (openClawVersion === "2026.5.18") {
    packages["node_modules/@protobufjs/inquire"] = { version: "1.1.2" };
    packages["node_modules/koffi"] = { version: "2.16.2" };
  } else if (openClawVersion === "2026.5.22") {
    packages["node_modules/koffi"] = { version: "2.16.2" };
  }
  layout.shrinkwrap
    ? fs.writeFileSync(
        path.join(openClawRoot, "npm-shrinkwrap.json"),
        JSON.stringify({ lockfileVersion: 3, packages }),
      )
    : undefined;
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
    expect(dockerfile).toContain("npm ls --omit=dev --all");
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

  it("synchronizes every lock dependency field with the replacement manifest", () => {
    const target = fixture("2026.5.22");
    patchOpenClawCoreDependencies({
      ...target,
      expectedOpenClawVersion: "2026.5.22",
    });
    const packages = JSON.parse(
      fs.readFileSync(path.join(target.openClawRoot, "npm-shrinkwrap.json"), "utf8"),
    ).packages;
    expect(packages["node_modules/@earendil-works/pi-coding-agent"].optionalDependencies).toEqual({
      "@mariozechner/clipboard": "0.3.9",
    });
    expect(packages["node_modules/@earendil-works/pi-tui"].optionalDependencies).toBeUndefined();
    expect(packages["node_modules/@earendil-works/pi-tui"].peerDependencies).toBeUndefined();
    expect(packages["node_modules/@mariozechner/clipboard"].version).toBe("0.3.9");
    expect(packages["node_modules/@earendil-works/pi-ai"].dependencies).toMatchObject({
      "@anthropic-ai/sdk": "0.97.1",
      "@aws-sdk/client-bedrock-runtime": "3.1051.0",
      "@google/genai": "2.5.0",
      openai: "6.38.0",
    });
    expect(packages["node_modules/koffi"]).toBeUndefined();
  });

  it("removes helpers owned only by superseded oldest-layout packages", () => {
    const target = fixture("2026.5.18");
    patchOpenClawCoreDependencies({
      ...target,
      expectedOpenClawVersion: "2026.5.18",
    });
    expect(
      fs.existsSync(path.join(target.openClawRoot, "node_modules", "@protobufjs/inquire")),
    ).toBe(false);
    expect(fs.existsSync(path.join(target.openClawRoot, "node_modules", "koffi"))).toBe(false);
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

  it("rejects an installed package reached through an intermediate symlink", () => {
    const target = fixture("2026.5.27");
    const scope = path.join(target.openClawRoot, "node_modules", "@mariozechner");
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-core-external-"));
    tempDirs.push(external);
    fs.renameSync(scope, path.join(external, "scope"));
    fs.symlinkSync(path.join(external, "scope"), scope);
    expect(() =>
      patchOpenClawCoreDependencies({
        ...target,
        expectedOpenClawVersion: "2026.5.27",
      }),
    ).toThrow("must remain inside the OpenClaw node_modules tree");
    expect(
      JSON.parse(fs.readFileSync(path.join(external, "scope", "clipboard", "package.json"), "utf8"))
        .version,
    ).toBe("0.3.6");
  });
});
