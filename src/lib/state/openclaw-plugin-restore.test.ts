// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS } from "./openclaw-managed-extensions";
import {
  buildFreshOpenClawPluginIndexSqliteReadCommand,
  hasCompleteOpenClawImagePluginProvenance,
  parseFreshOpenClawPluginExtensionDirs,
  parseOpenClawImagePluginInstalls,
  planOpenClawPluginRestore,
} from "./openclaw-plugin-restore";

const OPENCLAW_DIR = "/sandbox/.openclaw";

function install(installPath: string): Record<string, unknown> {
  return { source: "npm", installPath };
}

function pathInstall(installPath: string, sourcePath: string): Record<string, unknown> {
  return { source: "path", sourcePath, installPath };
}

function writeOpenClawConfig(root: string, loadPaths: string[] = []): void {
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({ plugins: { load: { paths: loadPaths } } }),
  );
}

const CREATE_PLUGIN_INDEX_SQLITE_PY = [
  "import json, sqlite3, sys",
  "conn = sqlite3.connect(sys.argv[1])",
  "conn.execute('CREATE TABLE installed_plugin_index (index_key TEXT PRIMARY KEY, install_records_json TEXT)')",
  "records = json.loads(sys.argv[2])",
  "if records is not None: conn.execute('INSERT INTO installed_plugin_index VALUES (?, ?)', ('installed-plugin-index', json.dumps(records)))",
  "conn.commit()",
  "conn.close()",
].join("\n");

function createPluginIndexDatabase(dbPath: string, records: unknown): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execFileSync("python3", ["-c", CREATE_PLUGIN_INDEX_SQLITE_PY, dbPath, JSON.stringify(records)]);
}

describe("buildFreshOpenClawPluginIndexSqliteReadCommand", () => {
  it("reads canonical install records from the OpenClaw SQLite index", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      const dbPath = path.join(root, "state", "openclaw.sqlite");
      const records = { weather: install(`${OPENCLAW_DIR}/extensions/weather`) };
      createPluginIndexDatabase(dbPath, records);
      writeOpenClawConfig(root);

      const stdout = execFileSync(
        "bash",
        ["-c", buildFreshOpenClawPluginIndexSqliteReadCommand(root)],
        { encoding: "utf8" },
      );
      expect(JSON.parse(stdout)).toEqual({ version: 1, installRecords: records, loadPaths: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the SQLite database has no installed-plugin-index row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      createPluginIndexDatabase(path.join(root, "state", "openclaw.sqlite"), null);
      writeOpenClawConfig(root);
      expect(() =>
        execFileSync("bash", ["-c", buildFreshOpenClawPluginIndexSqliteReadCommand(root)]),
      ).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exit status 2 only when the canonical SQLite database is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      const result = spawnSync("bash", [
        "-c",
        buildFreshOpenClawPluginIndexSqliteReadCommand(root),
      ]);
      expect(result.status).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a broken SQLite database symlink instead of using legacy fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      const dbPath = path.join(root, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.symlinkSync(path.join(root, "missing.sqlite"), dbPath);
      const result = spawnSync("bash", [
        "-c",
        buildFreshOpenClawPluginIndexSqliteReadCommand(root),
      ]);
      expect(result.status).toBe(10);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked OpenClaw config used for load-path ownership", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-index-"));
    try {
      createPluginIndexDatabase(path.join(root, "state", "openclaw.sqlite"), {});
      fs.symlinkSync(path.join(root, "missing-openclaw.json"), path.join(root, "openclaw.json"));
      const result = spawnSync("bash", [
        "-c",
        buildFreshOpenClawPluginIndexSqliteReadCommand(root),
      ]);
      expect(result.status).toBe(10);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseFreshOpenClawPluginExtensionDirs", () => {
  it("returns sorted validated directories for direct extension installs", () => {
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        {
          version: 1,
          installRecords: {
            weather: install(`${OPENCLAW_DIR}/extensions/weather`),
            nemoclaw: install(`${OPENCLAW_DIR}/extensions/nemoclaw`),
          },
          loadPaths: [],
        },
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: ["nemoclaw", "weather"],
      pluginInstalls: [
        { id: "nemoclaw", installPath: `${OPENCLAW_DIR}/extensions/nemoclaw`, loadPaths: [] },
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
      ],
    });
  });

  it("ignores npm installs outside extensions and accepts scoped IDs with encoded directories", () => {
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        {
          version: 1,
          installRecords: {
            "@scope/weather": install(`${OPENCLAW_DIR}/extensions/scope__weather`),
            diagnostics: install(`${OPENCLAW_DIR}/npm/node_modules/diagnostics`),
            "foo+bar": install(`${OPENCLAW_DIR}/extensions/foo+bar`),
          },
          loadPaths: [],
        },
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: ["foo+bar", "scope__weather"],
      pluginInstalls: expect.arrayContaining([
        {
          id: "@scope/weather",
          installPath: `${OPENCLAW_DIR}/extensions/scope__weather`,
          loadPaths: [],
        },
        {
          id: "diagnostics",
          installPath: `${OPENCLAW_DIR}/npm/node_modules/diagnostics`,
          loadPaths: [],
        },
        { id: "foo+bar", installPath: `${OPENCLAW_DIR}/extensions/foo+bar`, loadPaths: [] },
      ]),
    });
  });

  it.each([
    ["a traversal ID", { "../weather": install(`${OPENCLAW_DIR}/extensions/../weather`) }],
    [
      "an ID containing whitespace",
      { "my plugin": install(`${OPENCLAW_DIR}/extensions/my-plugin`) },
    ],
    ["a nested install path", { weather: install(`${OPENCLAW_DIR}/extensions/nested/weather`) }],
    ["a noncanonical install path", { weather: install(`${OPENCLAW_DIR}/extensions/../weather`) }],
    ["an oversized install path", { weather: install(`/${"a".repeat(4096)}`) }],
    [
      "an excessively deep install path",
      { weather: install(`/${Array.from({ length: 65 }, () => "a").join("/")}`) },
    ],
    ["a glob extension directory", { weather: install(`${OPENCLAW_DIR}/extensions/*`) }],
    ["non-object metadata", { weather: "invalid" }],
  ])("rejects %s", (_label, installs) => {
    const result = parseFreshOpenClawPluginExtensionDirs(
      { version: 1, installRecords: installs, loadPaths: [] },
      OPENCLAW_DIR,
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/unsafe|invalid/),
      }),
    );
  });

  it("rejects an unbounded install set before constructing restore commands", () => {
    const installs = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => {
        const id = `plugin-${index}`;
        return [id, install(`${OPENCLAW_DIR}/extensions/${id}`)];
      }),
    );
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        { version: 1, installRecords: installs, loadPaths: [] },
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: false,
      error: "fresh OpenClaw registry has too many plugin installs (129)",
    });
  });

  it("accepts the 64-component install-path boundary", () => {
    const installPath = `/${Array.from({ length: 64 }, () => "a").join("/")}`;
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        { version: 1, installRecords: { weather: install(installPath) }, loadPaths: [] },
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: [],
      pluginInstalls: [{ id: "weather", installPath, loadPaths: [] }],
    });
  });

  it("captures only configured load paths owned by linked path installs", () => {
    const linkedPath = "/opt/weather-linked";
    expect(
      parseFreshOpenClawPluginExtensionDirs(
        {
          version: 1,
          installRecords: {
            linked: pathInstall(linkedPath, linkedPath),
            copied: pathInstall(`${OPENCLAW_DIR}/extensions/copied`, "/opt/copied"),
          },
          loadPaths: [linkedPath, linkedPath, "./user-owned", "~/user-owned"],
        },
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: ["copied"],
      pluginInstalls: [
        { id: "copied", installPath: `${OPENCLAW_DIR}/extensions/copied`, loadPaths: [] },
        { id: "linked", installPath: linkedPath, loadPaths: [linkedPath] },
      ],
    });
  });

  it.each([
    ["missing load paths", { version: 1, installRecords: {} }],
    [
      "control character in configured load path",
      { version: 1, installRecords: {}, loadPaths: ["~/plug\u0000in"] },
    ],
    [
      "unsupported install source",
      {
        version: 1,
        installRecords: {
          weather: { source: "unknown", installPath: `${OPENCLAW_DIR}/extensions/weather` },
        },
        loadPaths: [],
      },
    ],
    [
      "relative path-install source",
      {
        version: 1,
        installRecords: {
          weather: pathInstall(`${OPENCLAW_DIR}/extensions/weather`, "relative/weather"),
        },
        loadPaths: [],
      },
    ],
  ])("rejects %s", (_label, index) => {
    expect(parseFreshOpenClawPluginExtensionDirs(index, OPENCLAW_DIR)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});

describe("parseOpenClawImagePluginInstalls", () => {
  it("preserves known-empty provenance and validates populated records", () => {
    expect(parseOpenClawImagePluginInstalls([], OPENCLAW_DIR)).toEqual({
      ok: true,
      extensionDirs: [],
      pluginInstalls: [],
    });
    expect(
      parseOpenClawImagePluginInstalls(
        [
          { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
          {
            id: "npm-tool",
            installPath: `${OPENCLAW_DIR}/npm/node_modules/npm-tool`,
            loadPaths: [],
          },
        ],
        OPENCLAW_DIR,
      ),
    ).toEqual({
      ok: true,
      extensionDirs: ["weather"],
      pluginInstalls: [
        {
          id: "npm-tool",
          installPath: `${OPENCLAW_DIR}/npm/node_modules/npm-tool`,
          loadPaths: [],
        },
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
      ],
    });
  });

  it.each([
    [
      "unsafe ID",
      [{ id: "../weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] }],
    ],
    [
      "prototype-pollution ID",
      [{ id: "__proto__", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] }],
    ],
    [
      "constructor prototype-pollution ID",
      [{ id: "constructor", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] }],
    ],
    [
      "prototype key ID",
      [{ id: "prototype", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] }],
    ],
    [
      "control character in path",
      [{ id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weath\u0000er`, loadPaths: [] }],
    ],
    [
      "missing explicit load paths",
      [{ id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` }],
    ],
    [
      "duplicate ID",
      [
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/forecast`, loadPaths: [] },
      ],
    ],
    [
      "duplicate install path",
      [
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
        { id: "forecast", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
      ],
    ],
    ["relative path", [{ id: "weather", installPath: "extensions/weather", loadPaths: [] }]],
  ])("rejects %s", (_label, provenance) => {
    expect(parseOpenClawImagePluginInstalls(provenance, OPENCLAW_DIR)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("distinguishes complete empty provenance from missing legacy provenance", () => {
    expect(hasCompleteOpenClawImagePluginProvenance([], OPENCLAW_DIR)).toBe(true);
    expect(hasCompleteOpenClawImagePluginProvenance(undefined, OPENCLAW_DIR)).toBe(false);
    expect(
      hasCompleteOpenClawImagePluginProvenance(
        [{ id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather` }],
        OPENCLAW_DIR,
      ),
    ).toBe(false);
  });
});

describe("planOpenClawPluginRestore", () => {
  it("preserves fresh plugins while excluding removed previous plugins from the archive", () => {
    const result = planOpenClawPluginRestore({
      agentType: "openclaw",
      dir: OPENCLAW_DIR,
      localDirs: ["extensions"],
      freshImagePluginInstalls: [
        { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
      ],
      previousImagePluginInstalls: [
        { id: "forecast", installPath: `${OPENCLAW_DIR}/extensions/forecast`, loadPaths: [] },
      ],
    });

    const preservedExtensionDirs = [
      ...new Set([...OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS, "weather"]),
    ].sort();
    expect(result).toEqual({
      ok: true,
      freshExtensionDirs: ["weather"],
      previousExtensionDirs: ["forecast"],
      preservedExtensionDirs,
      archiveExcludedExtensionDirs: [...preservedExtensionDirs, "forecast"].sort(),
      requiredFreshExtensionDirs: ["weather"],
    });
  });

  it("treats a same-ID fresh plugin as an upgrade and excludes the previous image directory", () => {
    const result = planOpenClawPluginRestore({
      agentType: "openclaw",
      dir: OPENCLAW_DIR,
      localDirs: ["extensions"],
      freshImagePluginInstalls: [
        {
          id: "weather",
          installPath: `${OPENCLAW_DIR}/extensions/weather-v2`,
          loadPaths: [],
        },
      ],
      previousImagePluginInstalls: [
        {
          id: "weather",
          installPath: `${OPENCLAW_DIR}/extensions/weather-v1`,
          loadPaths: [],
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        freshExtensionDirs: ["weather-v2"],
        previousExtensionDirs: ["weather-v1"],
        requiredFreshExtensionDirs: ["weather-v2"],
        archiveExcludedExtensionDirs: expect.arrayContaining(["weather-v1", "weather-v2"]),
      }),
    );
  });

  it("returns an empty extension plan when the backup does not contain extensions", () => {
    expect(
      planOpenClawPluginRestore({
        agentType: "openclaw",
        dir: OPENCLAW_DIR,
        localDirs: ["workspace"],
        freshImagePluginInstalls: [
          { id: "weather", installPath: `${OPENCLAW_DIR}/extensions/weather`, loadPaths: [] },
        ],
      }),
    ).toEqual({
      ok: true,
      freshExtensionDirs: [],
      previousExtensionDirs: [],
      preservedExtensionDirs: [],
      archiveExcludedExtensionDirs: [],
      requiredFreshExtensionDirs: [],
    });
  });

  it("fails closed on invalid previous plugin provenance", () => {
    expect(
      planOpenClawPluginRestore({
        agentType: "openclaw",
        dir: OPENCLAW_DIR,
        localDirs: ["extensions"],
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [
          { id: "weather", installPath: "extensions/weather", loadPaths: [] },
        ],
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });
});
