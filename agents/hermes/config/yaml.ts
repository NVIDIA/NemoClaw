// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Minimal YAML serializer for flat/nested objects — no external dependency. */
export function toYaml(obj: Record<string, unknown>, indent: number = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      out += `${pad}${key}: null\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        out += `${pad}${key}: []\n`;
      } else {
        out += `${pad}${key}:\n`;
        // Indent block-sequence items one level under the key. A top-level
        // array whose `-` sits at the key's own indent (e.g. `custom_providers`
        // followed by sibling keys) cannot be round-tripped by the messaging
        // build applier's YAML mini-parser, which only ends a sequence on a
        // dedent. This matches the applier's own serializer; both forms are
        // valid YAML for Hermes' real parser.
        const itemPad = "  ".repeat(indent + 1);
        for (const item of value) {
          if (typeof item === "object" && item !== null) {
            out += `${itemPad}-\n`;
            out += toYaml(item as Record<string, unknown>, indent + 2);
          } else if (typeof item === "string") {
            out += `${itemPad}- ${yamlString(item)}\n`;
          } else if (typeof item === "number" || typeof item === "boolean") {
            out += `${itemPad}- ${item}\n`;
          }
        }
      }
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        out += `${pad}${key}: {}\n`;
      } else {
        out += `${pad}${key}:\n`;
        out += toYaml(value as Record<string, unknown>, indent + 1);
      }
    } else if (typeof value === "string") {
      out += `${pad}${key}: ${yamlString(value)}\n`;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out += `${pad}${key}: ${value}\n`;
    }
  }
  return out;
}

function yamlString(s: string): string {
  if (s === "") {
    return JSON.stringify(s);
  }
  if (/[:{}\[\],&*?|>!%@`#'"]/.test(s) || s.includes("\n") || s.trim() !== s) {
    return JSON.stringify(s);
  }
  return s;
}
