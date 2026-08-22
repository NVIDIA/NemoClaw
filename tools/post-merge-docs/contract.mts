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
  const push = object(object(workflow.on)?.push) ?? {};
  const gate = object(jobs.gate) ?? {};
  const author = object(jobs.author) ?? {};
  const publish = object(jobs.publish) ?? {};
  const gateSteps = Array.isArray(gate.steps) ? gate.steps : [];
  const scanSteps = gateSteps.filter((step) => object(step)?.id === "scan");
  const scan = object(scanSteps[0]) ?? {};
  const authorSteps = Array.isArray(author.steps) ? author.steps : [];
  const configureSteps = (Array.isArray(author.steps) ? author.steps : []).filter(
    (step) => object(step)?.name === "Configure isolated inference",
  );
  const configure = object(configureSteps[0]) ?? {};
  const validationSteps = authorSteps.filter(
    (step) => object(step)?.name === "Validate the documentation candidate",
  );
  const validation = object(validationSteps[0]) ?? {};
  const reviewSteps = authorSteps.filter((step) => object(step)?.id === "review");
  const rejectionSteps = authorSteps.filter(
    (step) => object(step)?.name === "Upload the independent review report",
  );
  const rejection = object(rejectionSteps[0]) ?? {};
  const modelSecret = "${{ secrets.POST_MERGE_DOCS_API_KEY }}";
  const references = strings(workflow).filter((text) => /\$\{\{[^}]*\bsecrets\b/u.test(text));
  const valid =
    isDeepStrictEqual(workflow.permissions, {}) &&
    isDeepStrictEqual(push["paths-ignore"], ["docs/**", "fern/docs.yml", "fern/assets/**"]) &&
    Object.keys(jobs).sort().join(",") === "author,gate,publish" &&
    Object.values(jobs).every((job) => !Object.hasOwn(object(job) ?? {}, "secrets")) &&
    isDeepStrictEqual(gate.permissions, { "pull-requests": "read" }) &&
    isDeepStrictEqual(gate.outputs, { automate: "${{ steps.scan.outputs.automate }}" }) &&
    scanSteps.length === 1 &&
    typeof scan.run === "string" &&
    scan.run.includes('test("^automation/post-merge-docs-[0-9a-f]{12}$")') &&
    scan.run.includes('elif length == 0 or .[0].draft == true then "automation"') &&
    scan.run.includes('elif .[0].draft == false then "maintainer"') &&
    scan.run.includes('echo "automate=false" >> "$GITHUB_OUTPUT"') &&
    author.if ===
      "${{ github.repository == 'NVIDIA/NemoClaw' && needs.gate.outputs.automate == 'true' }}" &&
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
    validationSteps.length === 1 &&
    validation["working-directory"] === "author/repo" &&
    validation.run ===
      'before_status="$(git status --porcelain=v1 --untracked-files=all)"\n' +
        'before_diff="$(git diff --no-ext-diff --binary HEAD | sha256sum)"\n' +
        "npm ci --ignore-scripts --no-audit --no-fund\n" +
        "npm run docs\n" +
        '[[ "$(git status --porcelain=v1 --untracked-files=all)" == "$before_status" ]]\n' +
        '[[ "$(git diff --no-ext-diff --binary HEAD | sha256sum)" == "$before_diff" ]]\n' &&
    reviewSteps.length === 1 &&
    rejectionSteps.length === 1 &&
    rejection.if === "${{ failure() && steps.review.outcome == 'failure' }}" &&
    object(rejection.with)?.path === "${{ github.workspace }}/approved/review-report.txt" &&
    object(rejection.with)?.["if-no-files-found"] === "ignore" &&
    object(rejection.with)?.["retention-days"] === 3 &&
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

export function nextPatchReleaseTag(
  rangeStartTag: string,
  invalidMessage = "release range start tag cannot produce a release target",
): string {
  const match = /^v(0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/u.exec(rangeStartTag);
  if (!match) throw new Error(invalidMessage);
  return `v${BigInt(match[1]!)}.${BigInt(match[2]!)}.${BigInt(match[3]!) + 1n}`;
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
