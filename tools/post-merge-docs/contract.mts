// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return Object.values(object(value) ?? {}).flatMap(strings);
}
export function validatePostMergeDocsWorkflowBoundary(value: unknown): string[] {
  const workflow = object(value) ?? {};
  const jobs = object(workflow.jobs) ?? {};
  const gate = object(jobs.gate) ?? {};
  const author = object(jobs.author) ?? {};
  const publish = object(jobs.publish) ?? {};
  const configureSteps = (Array.isArray(author.steps) ? author.steps : []).filter(
    (step) => object(step)?.name === "Configure isolated inference",
  );
  const configure = object(configureSteps[0]) ?? {};
  const modelSecret = "${{ secrets.POST_MERGE_DOCS_API_KEY }}";
  const references = strings(workflow).filter((text) => /\$\{\{[^}]*\bsecrets\b/u.test(text));
  const valid =
    isDeepStrictEqual(workflow.permissions, {}) &&
    Object.keys(jobs).sort().join(",") === "author,gate,publish" &&
    Object.values(jobs).every((job) => !Object.hasOwn(object(job) ?? {}, "secrets")) &&
    isDeepStrictEqual(gate.permissions, { "pull-requests": "read" }) &&
    isDeepStrictEqual(author.permissions, { contents: "read" }) &&
    isDeepStrictEqual(publish.permissions, {
      actions: "read",
      contents: "write",
      "pull-requests": "write",
    }) &&
    references.length === 1 &&
    references[0] === modelSecret &&
    configureSteps.length === 1 &&
    isDeepStrictEqual(configure.env, { OPENAI_API_KEY: modelSecret }) &&
    configure.run ===
      'node --experimental-strip-types --no-warnings "$TRUSTED_CHECKOUT/tools/post-merge-docs/run.mts" configure' &&
    !strings(publish).some((text) => /(?:POST_MERGE_DOCS|OPENAI)_API_KEY/u.test(text));
  return valid ? [] : ["workflow must separate the model credential from repository writes"];
}

export function allowedDocumentationPath(file: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/u.test(file) &&
    Buffer.byteLength(file) <= 512 &&
    file !== "docs/_build" &&
    !file.startsWith("docs/_build/") &&
    /^(?:docs\/|fern\/(?:docs[.]yml$|assets\/))/u.test(file) &&
    !file.includes("//") &&
    !/(?:^|\/)(?:\.{1,2}|\.git|\.gitattributes|\.gitmodules|node_modules)(?:\/|$)/u.test(file) &&
    !file.endsWith("/")
  );
}

export function readBoundedFile(file: string, maximum: number, allowEmpty = false): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum || (!allowEmpty && !stat.size))
      throw new Error(`${file} must be a bounded regular file`);
    const content = fs.readFileSync(descriptor);
    if (content.length !== stat.size) throw new Error(`${file} changed while read`);
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}
