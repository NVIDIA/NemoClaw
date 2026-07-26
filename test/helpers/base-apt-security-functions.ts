// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const runLines: string[] = [];
  for (const line of dockerfile.slice(runIndex, end).split("\n")) {
    runLines.push(line);
    if (!line.trimEnd().endsWith("\\")) {
      break;
    }
  }
  const lastLine = runLines[runLines.length - 1]?.trimEnd() ?? "";
  if (lastLine.endsWith("\\")) {
    throw new Error(`Expected complete RUN instruction before ${endMarker}`);
  }
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

export function runLoggedDockerShell(command: string, tmp: string, functionDefs: string[]) {
  const logPath = path.join(tmp, "calls.log");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    ...functionDefs,
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

type DebianArchitecture = "amd64" | "arm64";

export const BASE_APT_SECURITY_HASHES: Record<
  DebianArchitecture,
  { libexpat: string; libonig: string; libjq: string; jq: string; vimTiny: string }
> = {
  amd64: {
    libexpat: "37d24b40a745107941f823d1f22c38f197f01981f7f0783777fe0026af016463",
    libonig: "3abee130696244050500bcc7870e3b4cb82ddd87149ece3fd55010c3d4e1d18c",
    libjq: "9a5bf964cef39ed8f0f162e20d856e31961d28a57772b5313989b42a8be7e941",
    jq: "b973a5d304f666845e8ccefab492e3850d4bc2e7aa2a1e7450862095125f2cc0",
    vimTiny: "0e6e231d6d2430a92cf76f8a78506090418fa37758c33b31ed50dfbfc76e22ed",
  },
  arm64: {
    libexpat: "df928e3a8e4da79408d4b18e8cd80a03dffa90130d0698e50041aab5e14f9397",
    libonig: "137e708575c0622d347815d19cb471a107546b16e9602805ee27afad7bba107f",
    libjq: "eae4a828df2eb53d728f88109d9f9549e0983a90b573cf0c7fa1e4bbc7533a7e",
    jq: "c25086443abd04d1457cbb322a0837f9ba986f82b28f44670467c8dc9be1f696",
    vimTiny: "be30f7e9de0b872bec0128ccd890452c0e0e29d99017d16c0f3aa74164f6700d",
  },
};

export function baseAptSecurityFunctions(architecture: DebianArchitecture): string[] {
  const hashes = BASE_APT_SECURITY_HASHES[architecture];
  return [
    [
      "dpkg() {",
      '  if [[ "$#" -eq 1 && "$1" == "--print-architecture" ]]; then',
      `    printf "${architecture}\\n"`,
      '  elif [[ "$#" -eq 1 && "$1" == "--audit" ]]; then',
      "    return 0",
      '  elif [[ "$#" -eq 7 && "$1" == "-i" && "${2##*/}" == "libexpat1.deb" && "${3##*/}" == "libonig5.deb" && "${4##*/}" == "libjq1.deb" && "${5##*/}" == "jq.deb" && "${6##*/}" == "vim-common.deb" && "${7##*/}" == "vim-tiny.deb" ]]; then',
      '    printf "dpkg-install\\n" >> "$call_log"',
      '    [[ -f "$2" && -f "$3" && -f "$4" && -f "$5" && -f "$6" && -f "$7" ]]',
      "  else",
      "    return 64",
      "  fi",
      "}",
    ].join("\n"),
    [
      "dpkg-query() {",
      '  [[ "$#" -eq 3 && "$1" == "-W" && "$2" == \'-f=${Version}\' ]] || return 64',
      '  case "$3" in',
      '    libexpat1) printf "2.8.2-1" ;;',
      '    libonig5) printf "6.9.9-1+b1" ;;',
      '    libjq1|jq) printf "1.8.2-1" ;;',
      '    perl) printf "5.40.1-6" ;;',
      '    vim-common|vim-tiny) printf "2:9.2.0782-1" ;;',
      "    *) return 64 ;;",
      "  esac",
      "}",
    ].join("\n"),
    [
      "curl() {",
      '  [[ "$#" -eq 16 && "$1" == "--proto" && "$2" == "=https" && "$3" == "--tlsv1.2" && "$4" == "-fsSL" ]] || return 64',
      '  [[ "$5" == "--retry" && "$6" == "5" && "$7" == "--retry-all-errors" && "$8" == "--retry-delay" && "$9" == "2" ]] || return 64',
      '  [[ "${10}" == "--connect-timeout" && "${11}" == "15" && "${12}" == "--max-time" && "${13}" == "120" && "${14}" == "-o" ]] || return 64',
      '  case "${16}" in',
      `    */e/expat/libexpat1_2.8.2-1_${architecture}.deb) [[ "\${15##*/}" == "libexpat1.deb" ]] ;;`,
      `    */libo/libonig/libonig5_6.9.9-1+b1_${architecture}.deb) [[ "\${15##*/}" == "libonig5.deb" ]] ;;`,
      `    */j/jq/libjq1_1.8.2-1_${architecture}.deb) [[ "\${15##*/}" == "libjq1.deb" ]] ;;`,
      `    */j/jq/jq_1.8.2-1_${architecture}.deb) [[ "\${15##*/}" == "jq.deb" ]] ;;`,
      '    */v/vim/vim-common_9.2.0782-1_all.deb) [[ "${15##*/}" == "vim-common.deb" ]] ;;',
      `    */v/vim/vim-tiny_9.2.0782-1_${architecture}.deb) [[ "\${15##*/}" == "vim-tiny.deb" ]] ;;`,
      "    *) return 64 ;;",
      "  esac",
      '  printf "download %s\\n" "${16}" >> "$call_log"',
      '  printf "%s\\n" "${16}" > "${15}"',
      "}",
    ].join("\n"),
    [
      "sha256sum() {",
      '  [[ "$#" -eq 2 && "$1" == "-c" && "$2" == "-" ]] || return 64',
      "  local line path count=0",
      "  while IFS= read -r line; do",
      '    path="${line#*  }"',
      '    [[ -f "$path" ]] || return 1',
      '    case "$line" in',
      `      "${hashes.libexpat}  "*/libexpat1.deb) ;;`,
      `      "${hashes.libonig}  "*/libonig5.deb) ;;`,
      `      "${hashes.libjq}  "*/libjq1.deb) ;;`,
      `      "${hashes.jq}  "*/jq.deb) ;;`,
      '      "6b063038246492c4a20e0a212c896dde4d5aa9f59d6fb43ff33d10080bc53a39  "*/vim-common.deb) ;;',
      `      "${hashes.vimTiny}  "*/vim-tiny.deb) ;;`,
      "      *) return 1 ;;",
      "    esac",
      "    (( count += 1 ))",
      "  done",
      '  [[ "$count" -eq 6 ]]',
      "}",
    ].join("\n"),
    [
      "jq() {",
      '  if [[ "$#" -eq 1 && "$1" == "--version" ]]; then',
      '    printf "jq-1.8.2\\n"',
      '  elif [[ "$#" -eq 2 && "$1" == "-e" && "$2" == \'.sandbox == "healthy"\' ]]; then',
      "    local input",
      "    IFS= read -r input",
      '    [[ "$input" == \'{"sandbox":"healthy"}\' ]]',
      "  else",
      "    return 64",
      "  fi",
      "}",
    ].join("\n"),
    [
      "ldd() {",
      '  [[ "$#" -eq 1 && "$1" == "/usr/bin/jq" ]] || return 64',
      '  printf "libonig.so.5 => /lib/libonig.so.5\\n"',
      "}",
    ].join("\n"),
    [
      "python3() {",
      '  [[ "$#" -eq 2 && "$1" == "-c" && "$2" == "import pyexpat; assert pyexpat.EXPAT_VERSION == \'expat_2.8.2\', pyexpat.EXPAT_VERSION" ]]',
      "}",
    ].join("\n"),
    [
      "vim.tiny() {",
      '  [[ "$#" -eq 1 && "$1" == "--version" ]] || return 64',
      '  printf "VIM - Vi IMproved 9.2 (2024 Jan 2)\\n"',
      "}",
    ].join("\n"),
  ];
}

export const BASE_APT_SECURITY_FUNCTIONS = baseAptSecurityFunctions("arm64");
