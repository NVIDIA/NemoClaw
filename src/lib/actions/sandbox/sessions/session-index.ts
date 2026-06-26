// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SessionIndexEntry {
  key: string;
  sessionId: string;
}

// Tolerant parsing of `openclaw sessions list --json`.
//
//   - Invalid state addressed: the upstream OpenClaw CLI has historically
//     emitted the session index either as a plain JSON array, wrapped in
//     `{sessions:[...]}` / `{entries:[...]}` / `{items:[...]}`, with
//     `sessionId` or `id` as the file-name field, and prefixed with Node
//     experimental-feature warnings. Each shape variant is enough to break a
//     strict parser and abort the export.
//   - Source boundary: NemoClaw must accept the upstream-of-the-day shape
//     read-only. The upstream-pinned contract is captured in
//     `agents/openclaw/manifest.yaml -> expected_version`; this code does not
//     hard-code the literal so the manifest stays the single source of
//     truth.
//   - Source-fix constraint: tightening the parser to one shape would
//     regress against any in-the-wild OpenClaw build that still emits a
//     legacy shape, and NemoClaw cannot rev the upstream CLI from this side.
//   - Regression-test coverage: `session-index.test.ts > parseSessionIndex`
//     covers each accepted shape plus the log-noise prefix; CLI-level
//     coverage in `test/sandbox-sessions-export-cli.test.ts` exercises the
//     array and wrapped-object forms via the stub openshell.
//   - Removal condition: once OpenClaw documents a single stable JSON
//     contract for `sessions list --json` in its release notes, this
//     parser can collapse to the strict shape and the alias map can drop.
export function parseSessionIndex(output: string): SessionIndexEntry[] | null {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r?\n/);
  const candidates = balancedJsonCandidates(trimmed);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (candidate && (candidate.startsWith("[") || candidate.startsWith("{"))) {
      candidates.push(candidate);
    }
  }
  candidates.push(trimmed);
  for (const candidate of candidates) {
    const entries = tryExtractIndex(candidate);
    if (entries) return entries;
  }
  // Non-empty output, but no JSON-shaped candidate parsed into a recognised
  // session index. Distinguish this from the empty-string case so callers
  // can surface a parse error instead of silently treating it as "no
  // sessions" — the latter would mask an upstream contract drift.
  return null;
}

export function balancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const lineStartJson = /^(\s*)([\[{])/gm;
  let match: RegExpExecArray | null;
  while ((match = lineStartJson.exec(text)) !== null) {
    const candidate = balancedJsonFrom(text, match.index + match[1].length);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function balancedJsonFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    if (stack.pop() !== char) return null;
    if (stack.length === 0) return text.slice(start, index + 1);
  }
  return null;
}

function tryExtractIndex(text: string): SessionIndexEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const array = pickIndexArray(parsed);
  if (!array) return null;
  // Legitimate empty index — upstream said no sessions.
  if (array.length === 0) return [];
  const entries: SessionIndexEntry[] = [];
  for (const entry of array) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key : null;
    const sessionId =
      typeof obj.sessionId === "string"
        ? obj.sessionId
        : typeof obj.id === "string"
          ? obj.id
          : null;
    if (key && sessionId) entries.push({ key, sessionId });
  }
  // Non-empty upstream array yielded zero recognised entries — schema drift.
  // Return null so the caller surfaces a parse error instead of silently
  // treating it as "no sessions".
  if (entries.length === 0) return null;
  return entries;
}

function pickIndexArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sessions)) return obj.sessions;
    if (Array.isArray(obj.entries)) return obj.entries;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return null;
}
