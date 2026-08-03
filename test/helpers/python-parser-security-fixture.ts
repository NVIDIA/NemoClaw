// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FIXED_PARSER_SHA256 =
  "4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7";

export function htmlParserSecurityProbe(parserPath: string): string {
  return `import sys; from pathlib import Path; import html.parser; Path(html.parser.__file__).resolve() == Path('${parserPath}').resolve() or sys.exit('html.parser loaded from an unexpected path'); from html.parser import HTMLParser; p=HTMLParser(); [p.feed('') for _ in range(20000)]; p._pending == [] or sys.exit('empty feeds accumulated pending entries'); p.feed('<!--'); [p.feed('a' * 64) for _ in range(20000)]; p.feed('-->'); p.close(); p.rawdata == '' or sys.exit('incremental parsing retained raw data')`;
}

const PYEXPAT_PROBE =
  "import pyexpat; assert pyexpat.EXPAT_VERSION == 'expat_2.8.2', pyexpat.EXPAT_VERSION";
const LIBSSH2_PROBE =
  "import ctypes, sys; lib=ctypes.CDLL('libssh2.so.1'); lib.libssh2_version.restype=ctypes.c_char_p; lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')";
const FIXED_PARSER_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "security",
  "python3.13-html-parser-fixed.txt",
);

export function stageFixedParser(tmp: string): {
  fixedParser: string;
  pythonShim: string;
} {
  const parserBytes = fs.readFileSync(FIXED_PARSER_FIXTURE);
  const parserHash = createHash("sha256").update(parserBytes).digest("hex");
  if (parserHash !== FIXED_PARSER_SHA256) {
    throw new Error(`Fixed parser fixture hash mismatch: ${parserHash}`);
  }

  const fixedParser = path.join(tmp, "python3.13", "html", "parser.py");
  const pythonShim = path.join(tmp, "usr-bin", "python3");
  fs.mkdirSync(path.dirname(fixedParser), { recursive: true });
  fs.mkdirSync(path.dirname(pythonShim), { recursive: true });
  fs.writeFileSync(fixedParser, parserBytes);
  fs.writeFileSync(
    pythonShim,
    [
      "#!/usr/bin/env python3",
      "import html",
      "import importlib.util",
      "from importlib.machinery import SourceFileLoader",
      "import sys",
      `parser_path = ${JSON.stringify(fixedParser)}`,
      `html_probe = ${JSON.stringify(htmlParserSecurityProbe(fixedParser))}`,
      `accepted_noop_probes = {${JSON.stringify(PYEXPAT_PROBE)}, ${JSON.stringify(LIBSSH2_PROBE)}}`,
      "if len(sys.argv) != 3 or sys.argv[1] != '-c':",
      "    raise SystemExit(64)",
      "code = sys.argv[2]",
      "if code in accepted_noop_probes:",
      "    raise SystemExit(0)",
      "if code != html_probe:",
      "    raise SystemExit(64)",
      "loader = SourceFileLoader('html.parser', parser_path)",
      "spec = importlib.util.spec_from_loader(loader.name, loader)",
      "if spec is None:",
      "    raise SystemExit(65)",
      "module = importlib.util.module_from_spec(spec)",
      "sys.modules[loader.name] = module",
      "loader.exec_module(module)",
      "html.parser = module",
      "exec(code, {})",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { fixedParser, pythonShim };
}

export function useRealPatchedParser(functionDefinitions: string[], pythonShim: string): string[] {
  return [
    ...functionDefinitions.filter((definition) => !definition.startsWith("python3() {")),
    `python3() { ${JSON.stringify(pythonShim)} "$@"; }`,
  ];
}
