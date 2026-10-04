// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function extractShellFunctionFromSource(src: string, name: string): string {
  const header = `${name}() {`;
  const start = src.indexOf(header);
  if (start === -1) {
    throw new Error(`Expected ${name} in shell source`);
  }
  const bodyStart = start + header.length;
  const lines = src.slice(bodyStart).split(/(?<=\n)/);
  let offset = 0;
  let heredocEnd: string | undefined;
  for (const line of lines) {
    const bareLine = line.replace(/\r?\n$/, "");
    if (heredocEnd) {
      offset += line.length;
      if (bareLine === heredocEnd) {
        heredocEnd = undefined;
      }
      continue;
    }
    const heredoc = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredoc) {
      heredocEnd = heredoc[1];
    }
    if (bareLine === "}") {
      return `${name}() {${src.slice(bodyStart, bodyStart + offset)}\n}`;
    }
    offset += line.length;
  }
  throw new Error(`Expected closing brace for ${name} in shell source`);
}
