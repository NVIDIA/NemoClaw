// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-whatsapp-qr.js",
);

const QUIET_ZONE_MARKER = "COMPACT_MARGIN_MODULES = 4";
const SCAN_FALLBACK_MARKER = "nemoclaw: qr scan fallback";
const COMPACT_RENDER_BRANCH =
  "if (opts.small === true) return renderCompactTerminalQr(qrCode.create(text).modules);";

function qrTerminalFixtureSource(opts: { renderBranch?: string; marginDecl?: string } = {}) {
  return [
    `const COMPACT_MARGIN_MODULES = ${opts.marginDecl ?? "1"};`,
    "function renderCompactTerminalQr(modules) {",
    "\treturn `compact:margin=${COMPACT_MARGIN_MODULES}:size=${modules.size}`;",
    "}",
    "const fakeQrCode = {",
    "\tcreate(text) { return { modules: { size: text.length } }; },",
    "\ttoString(text, options) { return Promise.resolve(`full:${options.type}:small=${options.small}:${text}`); },",
    "\ttoDataURL(text) { return Promise.resolve(`data:image/png;base64,STUB(${text})`); },",
    "};",
    "async function loadQrCodeRuntime() { return fakeQrCode; }",
    "function normalizeQrText(text) {",
    '\tif (typeof text !== "string") throw new TypeError("QR text must be a string.");',
    '\tif (text.length === 0) throw new Error("QR text must not be empty.");',
    "\treturn text;",
    "}",
    "async function renderQrTerminal(input, opts = {}) {",
    "\tconst text = normalizeQrText(input);",
    "\tconst qrCode = await loadQrCodeRuntime();",
    `\t${opts.renderBranch ?? COMPACT_RENDER_BRANCH}`,
    '\treturn await qrCode.toString(text, { small: false, type: "terminal" });',
    "}",
    "export { renderQrTerminal, renderCompactTerminalQr };",
    "",
  ].join("\n");
}

function makeFixture(opts: { source?: string; omitQrTerminal?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-whatsapp-qr-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "unrelated-runtime.js"), "export const noop = true;\n");
  const qrTerminalPath = path.join(dist, "qr-terminal-fixture.js");
  if (!opts.omitQrTerminal) {
    fs.writeFileSync(qrTerminalPath, opts.source ?? qrTerminalFixtureSource());
  }
  return { root, dist, qrTerminalPath };
}

function runPatch(dist: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [PATCH_SCRIPT, ...extraArgs, dist], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

async function importFresh(file: string) {
  return await import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`);
}

describe("OpenClaw WhatsApp pairing QR patch", () => {
  it("widens the compact quiet zone and appends a scannable image fallback", async () => {
    const fixture = makeFixture();
    try {
      const first = runPatch(fixture.dist);
      expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
      expect(first.stdout).toContain("patched OpenClaw WhatsApp pairing QR");

      const patched = fs.readFileSync(fixture.qrTerminalPath, "utf-8");
      expect(patched).toContain(QUIET_ZONE_MARKER);
      expect(patched).not.toContain("COMPACT_MARGIN_MODULES = 1;");
      expect(patched).toContain(SCAN_FALLBACK_MARKER);

      const mod = await importFresh(fixture.qrTerminalPath);
      const rendered = await mod.renderQrTerminal("PAIRING-PAYLOAD", { small: true });
      expect(rendered).toContain("compact:margin=4:");
      expect(rendered).toContain(
        "If this QR will not scan, open this image in a browser: data:image/png;base64,STUB(PAIRING-PAYLOAD)",
      );

      const fullSize = await mod.renderQrTerminal("PAIRING-PAYLOAD");
      expect(fullSize).toBe("full:terminal:small=false:PAIRING-PAYLOAD");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("is idempotent on a second run", () => {
    const fixture = makeFixture();
    try {
      expect(runPatch(fixture.dist).status).toBe(0);
      const afterFirst = fs.readFileSync(fixture.qrTerminalPath, "utf-8");

      const second = runPatch(fixture.dist);
      expect(second.status, `${second.stdout}${second.stderr}`).toBe(0);
      const afterSecond = fs.readFileSync(fixture.qrTerminalPath, "utf-8");

      expect(afterSecond).toBe(afterFirst);
      expect(afterSecond.split(SCAN_FALLBACK_MARKER).length - 1).toBe(1);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("degrades to the compact render when the image encoder is unavailable", async () => {
    const fixture = makeFixture();
    try {
      expect(runPatch(fixture.dist).status).toBe(0);
      const patched = fs
        .readFileSync(fixture.qrTerminalPath, "utf-8")
        .replace(
          "toDataURL(text) { return Promise.resolve(`data:image/png;base64,STUB(${text})`); },",
          "",
        );
      fs.writeFileSync(fixture.qrTerminalPath, patched);

      const mod = await importFresh(fixture.qrTerminalPath);
      const rendered = await mod.renderQrTerminal("PAIRING-PAYLOAD", { small: true });
      expect(rendered).toBe("compact:margin=4:size=15");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the compact render branch drifts", () => {
    const fixture = makeFixture({
      source: qrTerminalFixtureSource({
        renderBranch:
          "if (opts.small === true) return renderCompactTerminalQr(qrCode.create(text));",
      }),
    });
    try {
      const result = runPatch(fixture.dist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("compact QR render branch not recognized");
      expect(fs.readFileSync(fixture.qrTerminalPath, "utf-8")).not.toContain(QUIET_ZONE_MARKER);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the quiet-zone constant drifts", () => {
    const fixture = makeFixture({ source: qrTerminalFixtureSource({ marginDecl: "2" }) });
    try {
      const result = runPatch(fixture.dist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("compact QR quiet-zone constant not recognized");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the renderer file is absent", () => {
    const fixture = makeFixture({ omitQrTerminal: true });
    try {
      const result = runPatch(fixture.dist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "expected exactly one OpenClaw WhatsApp pairing QR renderer file, found 0",
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("audits patch state and exits non-zero on drift", () => {
    const patchable = makeFixture();
    try {
      const audit = runPatch(patchable.dist, ["--audit"]);
      expect(audit.status, `${audit.stdout}${audit.stderr}`).toBe(0);
      expect(audit.stdout).toContain("quiet-zone: would-apply");
      expect(audit.stdout).toContain("scan-fallback: would-apply");
    } finally {
      fs.rmSync(patchable.root, { recursive: true, force: true });
    }

    const drifted = makeFixture({ source: qrTerminalFixtureSource({ marginDecl: "2" }) });
    try {
      const audit = runPatch(drifted.dist, ["--audit"]);
      expect(audit.status).toBe(3);
      expect(audit.stdout).toContain("quiet-zone:");
    } finally {
      fs.rmSync(drifted.root, { recursive: true, force: true });
    }
  });
});
