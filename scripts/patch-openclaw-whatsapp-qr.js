#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const path = require("node:path");

const AUDIT_FLAG = "--audit";
const EXIT_APPLY_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_AUDIT_FAILURE = 3;

const args = process.argv.slice(2);
const auditMode = args.includes(AUDIT_FLAG);
const positional = args.filter((value) => value !== AUDIT_FLAG);
const distDir = positional[0];

if (!distDir || positional.length > 1) {
  console.error("Usage: patch-openclaw-whatsapp-qr.js [--audit] <openclaw-dist-dir>");
  process.exit(EXIT_USAGE);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_APPLY_FAILURE);
}

function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(dir, entry.name));
}

let distEntries;
function getDistEntries() {
  if (!distEntries) {
    distEntries = listJsFiles(distDir).map((file) => ({
      file,
      source: fs.readFileSync(file, "utf8"),
    }));
  }
  return distEntries;
}

function patchCompactQuietZone(source, file) {
  if (source.includes("COMPACT_MARGIN_MODULES = 4")) {
    return { nextSource: source, status: "already-applied" };
  }
  const nextSource = source.replace(
    /const COMPACT_MARGIN_MODULES = 1;/,
    () => "const COMPACT_MARGIN_MODULES = 4;",
  );
  if (nextSource === source) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw compact QR quiet-zone constant not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

function patchCompactScanFallback(source, file) {
  if (source.includes("nemoclaw: qr scan fallback")) {
    return { nextSource: source, status: "already-applied" };
  }
  const target =
    "if (opts.small === true) return renderCompactTerminalQr(qrCode.create(text).modules);";
  if (!source.includes(target)) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw compact QR render branch not recognized in ${file}`,
    };
  }
  const replacement =
    "if (opts.small === true) { const compactQr = renderCompactTerminalQr(qrCode.create(text).modules); " +
    "try { const scanFallbackDataUrl = await qrCode.toDataURL(text); /* nemoclaw: qr scan fallback */ " +
    "return `${compactQr}\\nIf this QR will not scan, open this image in a browser: ${scanFallbackDataUrl}`; } " +
    "catch { return compactQr; } }";
  const nextSource = source.replace(target, () => replacement);
  return { nextSource, status: "would-apply" };
}

const FILES = [
  {
    id: "whatsapp-qr",
    label: "WhatsApp pairing QR renderer",
    selector(source) {
      return (
        source.includes("renderCompactTerminalQr") &&
        source.includes("COMPACT_MARGIN_MODULES") &&
        source.includes("async function renderQrTerminal")
      );
    },
    recognizers: [
      {
        id: "quiet-zone",
        marker: "COMPACT_MARGIN_MODULES = 4",
        postVerifyError: "compact QR quiet-zone patch did not apply",
        patch: patchCompactQuietZone,
      },
      {
        id: "scan-fallback",
        marker: "nemoclaw: qr scan fallback",
        postVerifyError: "compact QR scan-fallback patch did not apply",
        patch: patchCompactScanFallback,
      },
    ],
  },
];

function resolveFile(fileSpec, { dryRun }) {
  const entries = getDistEntries();
  const candidates = entries
    .filter((entry) => fileSpec.selector(entry.source))
    .map((entry) => entry.file);
  if (candidates.length !== 1) {
    const error = `expected exactly one OpenClaw ${fileSpec.label} file, found ${candidates.length}`;
    if (!dryRun) fail(error);
    return { file: null, error };
  }
  return { file: candidates[0] };
}

function processFile(fileSpec, file, { dryRun }) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;
  const recognizerResults = [];

  for (const recognizer of fileSpec.recognizers) {
    const result = recognizer.patch(source, file);
    recognizerResults.push({ id: recognizer.id, status: result.status, error: result.error });
    if (result.status === "no-match") {
      if (!dryRun) fail(result.error);
      continue;
    }
    if (result.status === "would-apply") {
      source = result.nextSource;
    }
  }

  if (!dryRun && source !== original) {
    fs.writeFileSync(file, source);
  }

  if (!dryRun) {
    const written = fs.readFileSync(file, "utf8");
    for (const recognizer of fileSpec.recognizers) {
      if (!written.includes(recognizer.marker)) {
        fail(recognizer.postVerifyError);
      }
    }
  }

  return recognizerResults;
}

function runApplyMode() {
  const summary = [];
  for (const fileSpec of FILES) {
    const { file } = resolveFile(fileSpec, { dryRun: false });
    processFile(fileSpec, file, { dryRun: false });
    summary.push(path.basename(file));
  }
  console.log(`INFO: patched OpenClaw WhatsApp pairing QR in ${summary.join(", ")}`);
}

function statusBadge(status) {
  switch (status) {
    case "applied":
    case "already-applied":
    case "would-apply":
      return "[OK]  ";
    case "no-match":
    case "selector-failed":
      return "[MISS]";
    default:
      return "[?]   ";
  }
}

function runAuditMode() {
  console.log(`patch-openclaw-whatsapp-qr audit: ${distDir}`);
  let totalRecognizers = 0;
  let okRecognizers = 0;
  let missingRecognizers = 0;
  let selectorFailures = 0;

  for (const fileSpec of FILES) {
    const { file, error: selectorError } = resolveFile(fileSpec, { dryRun: true });
    if (!file) {
      selectorFailures += 1;
      console.log("");
      console.log(`${fileSpec.label}: NOT FOUND`);
      console.log(`  ${statusBadge("selector-failed")} ${selectorError}`);
      for (const recognizer of fileSpec.recognizers) {
        totalRecognizers += 1;
        missingRecognizers += 1;
        console.log(`  ${statusBadge("no-match")} ${recognizer.id}: file unresolved`);
      }
      continue;
    }
    const results = processFile(fileSpec, file, { dryRun: true });
    console.log("");
    console.log(`${fileSpec.label}: ${path.basename(file)}`);
    for (const result of results) {
      totalRecognizers += 1;
      const badge = statusBadge(result.status);
      if (result.status === "no-match") {
        missingRecognizers += 1;
        console.log(`  ${badge} ${result.id}: ${result.error}`);
      } else {
        okRecognizers += 1;
        console.log(`  ${badge} ${result.id}: ${result.status}`);
      }
    }
  }

  console.log("");
  console.log(
    `Summary: ${totalRecognizers} recognizers · ${okRecognizers} OK · ${missingRecognizers} missing` +
      (selectorFailures > 0 ? ` · ${selectorFailures} file(s) NOT FOUND` : ""),
  );

  if (missingRecognizers > 0 || selectorFailures > 0) {
    process.exit(EXIT_AUDIT_FAILURE);
  }
}

if (auditMode) {
  runAuditMode();
} else {
  runApplyMode();
}
