// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { patchOpenClawWorkerArchiveModule } from "../../../scripts/lib/patch-openclaw-worker-proxy.mts";
import { OPENCLAW_WORKER_ARCHIVE_SOURCE } from "../../fixtures/openclaw-worker-proxy";
import { describe, expect, it } from "vitest";

import {
  MARKER,
  patchOpenClawSecondaryAgentMainSessionDelete,
  patchSecondaryAgentMainSessionDeleteText,
  patchSecondaryAgentMainSessionDeleteWorkerText,
  WORKER_MARKER,
} from "../../../scripts/lib/patch-openclaw-secondary-main-session-delete.mts";

function fixture(): string {
  return [
    "function rejectsDelete(canonicalKey, protectedGlobalAgentId) {",
    "\tconst target = { canonicalKey };",
    "\tconst cfg = {};",
    "\tconst parseAgentSessionKey = (key) => { const match = /^agent:([^:]+):/.exec(key); return match ? { agentId: match[1] } : undefined; };",
    "\tconst normalizeAgentId = (value) => String(value).toLowerCase();",
    "\tconst isAgentMainSessionKey = (_cfg, key) => /^agent:[^:]+:main$/.test(key);",
    "\tconst isSelectedNonDefaultGlobal = false;",
    'const isMainSession = target.canonicalKey !== "global" && isAgentMainSessionKey(cfg, target.canonicalKey);',
    'if ((target.canonicalKey === "global" || isMainSession) && !isSelectedNonDefaultGlobal) {',
    "\t\treturn true;",
    "\t}",
    "\treturn false;",
    "}",
    "rejectsDelete;",
  ].join("\n");
}

describe("OpenClaw secondary-agent main-session delete compatibility patch", () => {
  it("keeps the primary main protected and permits secondary-agent main deletion", () => {
    const result = patchSecondaryAgentMainSessionDeleteText(fixture(), "fixture.js");
    const rejectsDelete = vm.runInNewContext(result.text) as (
      canonicalKey: string,
      protectedGlobalAgentId: string,
    ) => boolean;

    expect(result.status).toBe("patched");
    expect(result.text).toContain(MARKER);
    expect(rejectsDelete("agent:main:main", "main")).toBe(true);
    expect(rejectsDelete("agent:work:main", "main")).toBe(false);
    expect(rejectsDelete("agent:work:scratch", "main")).toBe(false);
    expect(rejectsDelete("global", "main")).toBe(true);
  });

  it("is idempotent and fails closed when the reviewed guard drifts", () => {
    const once = patchSecondaryAgentMainSessionDeleteText(fixture(), "fixture.js");
    const twice = patchSecondaryAgentMainSessionDeleteText(once.text, "fixture.js");
    expect(twice).toEqual({ patched: false, status: "already-patched", text: once.text });

    expect(() =>
      patchSecondaryAgentMainSessionDeleteText(
        fixture().replace("&& !isSelectedNonDefaultGlobal", "&& false"),
        "fixture.js",
      ),
    ).toThrow(/reviewed delete guard count: expected 1, found 0/);
  });

  it("patches the worker-bundled copy loaded by the managed gateway", () => {
    const worker =
      "Si=pr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,pr.canonicalKey);if((pr.canonicalKey===`global`||Si)&&!mi){";
    const once = patchSecondaryAgentMainSessionDeleteWorkerText(worker, "worker.mjs");
    expect(once.status).toBe("patched");
    expect(once.text).toContain(WORKER_MARKER);
    expect(once.text).toContain("!mi&&!nemoclawSelectedNonDefaultMain");
    expect(patchSecondaryAgentMainSessionDeleteWorkerText(once.text, "worker.mjs").status).toBe(
      "already-patched",
    );
  });

  it("patches exactly one reviewed 2026.9.1 sessions.delete runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-delete-patch-"));
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    fs.mkdirSync(path.join(dist, "worker"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
    fs.writeFileSync(
      path.join(dist, "sessions-delete-fixture.js"),
      `${fixture()}\nconst diagnostic = "Cannot delete the main session (";\n`,
    );
    fs.writeFileSync(
      path.join(dist, "worker", "worker.mjs"),
      "Si=pr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,pr.canonicalKey);if((pr.canonicalKey===`global`||Si)&&!mi){",
    );
    try {
      expect(patchOpenClawSecondaryAgentMainSessionDelete(dist)).toMatchObject({
        status: "patched",
        version: "2026.9.1",
      });
      expect(patchOpenClawSecondaryAgentMainSessionDelete(dist)).toMatchObject({
        status: "already-patched",
        version: "2026.9.1",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const fixture105 = (name: string) =>
  fs.readFileSync(new URL(`./fixtures/${name}.js.txt`, import.meta.url), "utf8");

describe("OpenClaw 2026.10.5 session deletion", () => {
  it("leaves the main module unchanged when its worker archive is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-delete-archive-"));
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.10.5" }));
    const modulePath = path.join(dist, "sessions-delete-fixture.mjs");
    const source = fixture105("secondary-main-session-10.5");
    fs.writeFileSync(modulePath, source);
    try {
      expect(() => patchOpenClawSecondaryAgentMainSessionDelete(dist)).toThrow(
        /Unreviewed worker archive layout/,
      );
      expect(fs.readFileSync(modulePath, "utf8")).toBe(source);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["main", "embedded", "split"])(
    "preserves primary protection in the %s module",
    (layout) => {
      const body = fixture105(
        layout === "main"
          ? "secondary-main-session-10.5"
          : `secondary-main-session-worker-${layout}-10.5`,
      );
      const scaffold = `function rejectsDelete(canonicalKey, protectedGlobalAgentId, selectedGlobal = false) {
      const target = { canonicalKey }, cfg = {}, isSelectedNonDefaultGlobal = selectedGlobal;
      const parseAgentSessionKey = (key) => { const match = /^agent:([^:]+):/.exec(key); return match ? { agentId: match[1] } : undefined; };
      const normalizeAgentId = (value) => value.toLowerCase();
      const isAgentMainSessionKey = (_cfg, key) => /^agent:[^:]+:main$/.test(key);
      const invalidSessionRequest = () => true;
      const xr=target, Ln=cfg, Hr=protectedGlobalAgentId, Si=selectedGlobal;
      const x=target, m=cfg, O=protectedGlobalAgentId, M=selectedGlobal;
      const s=parseAgentSessionKey, a=normalizeAgentId, ue=isAgentMainSessionKey, te=invalidSessionRequest;
      ${layout === "main" ? body : "let " + body}
      return false;
    }`;
      const source =
        layout === "embedded"
          ? OPENCLAW_WORKER_ARCHIVE_SOURCE + ";" + scaffold.replace("rejectsDelete", "actualDelete")
          : scaffold;
      // The embedded proxy fixture carries its own passive delete expression.
      const input =
        layout === "embedded"
          ? source.replace(/function sessionDeletion\(\)\{[^\n]*\}/, "")
          : source;
      const patched =
        layout === "main"
          ? patchSecondaryAgentMainSessionDeleteText(input, "sessions-delete.mjs").text
          : patchOpenClawWorkerArchiveModule(
              input,
              layout === "split" ? "worker-chunk-DjEXxQHh.mjs" : "sqlite-store.worker.mjs",
            ).text;
      const functionName = layout === "embedded" ? "actualDelete" : "rejectsDelete";
      const evaluate = (text: string) =>
        vm.runInNewContext(`${text};${functionName}`, {}) as (
          key: string,
          owner: string,
          selected?: boolean,
        ) => boolean;
      expect(evaluate(input)("agent:work:main", "main")).toBe(true);
      const rejects = evaluate(patched);
      expect(rejects("agent:main:main", "main")).toBe(true);
      expect(rejects("agent:MAIN:main", "main")).toBe(true);
      expect(rejects("agent:work:main", "main")).toBe(false);
      expect(rejects("agent:work:scratch", "main")).toBe(false);
      expect(rejects("global", "main")).toBe(true);
      expect(rejects("global", "main", true)).toBe(false);
      const module = layout === "split" ? "worker-chunk-DjEXxQHh.mjs" : "sqlite-store.worker.mjs";
      const patch = (text: string) =>
        layout === "main"
          ? patchSecondaryAgentMainSessionDeleteText(text, "sessions-delete.mjs")
          : patchOpenClawWorkerArchiveModule(text, module);
      const drifted =
        layout === "main"
          ? input.replace("&& !isSelectedNonDefaultGlobal", "&& false")
          : input + input;
      expect(patch(patched).text).toBe(patched);
      expect(() => patch(drifted)).toThrow(layout === "main" ? undefined : /Unreviewed/);
    },
  );
});
