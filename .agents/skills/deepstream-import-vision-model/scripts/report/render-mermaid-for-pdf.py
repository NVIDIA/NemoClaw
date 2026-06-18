#!/usr/bin/env python3

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Expand ```mermaid ... ``` blocks in a Markdown file into PNG images via mmdc,
producing a new .md suitable for pandoc -> PDF. Does not modify the source file.

Full PDF pipeline (see docs/md-to-pdf.sh and docs/build-pdf.sh):
  1. This script: Mermaid -> PNG under docs/mermaid_pdf/<stem>/, replace blocks with ![...](...) links.
  2. pandoc --from=gfm --listings --lua-filter=pandoc-wrap-tables.lua
     --include-in-header=latex-pdf-wrap.tex --pdf-engine=pdflatex

Use --listings (not --highlight-style): default highlighted Verbatim splits code into
unbreakable tokens and overflows the page. The Lua filter wraps pipe tables and long
path-like inline code; CodeBlock text is normalized for pdflatex (Unicode quotes, etc.).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

MERMAID_BLOCK = re.compile(
    r"^```mermaid\s*\n(.*?)^```\s*$",
    re.MULTILINE | re.DOTALL,
)


def render_one(
    mmdc: str,
    body: str,
    out_png: Path,
    width: int,
    scale: float,
    puppeteer_config: Path | None,
) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_png.with_suffix(".mmd")
    tmp.write_text(body.strip() + "\n", encoding="utf-8")
    cmd = [
        mmdc,
        "-i",
        str(tmp),
        "-o",
        str(out_png),
        "-e",
        "png",
        "-b",
        "white",
        "-w",
        str(width),
        "-s",
        str(scale),
        "-q",
    ]
    if puppeteer_config is not None:
        cmd.extend(["-p", str(puppeteer_config)])
    r = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        shell=False,
        timeout=120,
    )
    tmp.unlink(missing_ok=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr or r.stdout or "mmdc failed\n")
        raise RuntimeError(f"mmdc failed with code {r.returncode}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path, help="Input .md path")
    ap.add_argument("output", type=Path, help="Output .md path")
    ap.add_argument(
        "--img-dir",
        type=Path,
        default=None,
        help="Directory for PNGs (default: next to output, mermaid_pdf/)",
    )
    ap.add_argument("--mmdc", default="mmdc", help="Path to mmdc binary")
    ap.add_argument("--width", type=int, default=1100)
    ap.add_argument("--scale", type=float, default=1.5)
    ap.add_argument(
        "--puppeteer-config",
        type=Path,
        default=None,
        help="JSON for Puppeteer (default: mermaid-puppeteer.json next to this script)",
    )
    args = ap.parse_args()
    # Optional: MERMAID_PDF_WIDTH / MERMAID_PDF_SCALE (e.g. build-pdf.sh for design doc)
    if os.environ.get("MERMAID_PDF_WIDTH"):
        args.width = int(os.environ["MERMAID_PDF_WIDTH"])
    if os.environ.get("MERMAID_PDF_SCALE"):
        args.scale = float(os.environ["MERMAID_PDF_SCALE"])

    script_dir = Path(__file__).resolve().parent

    # Two vetted Puppeteer configs ship alongside this script:
    #   - mermaid-puppeteer.json       : Chromium sandbox enabled. Used for
    #                                    non-root execution (the secure
    #                                    default for laptops, CI runners that
    #                                    run as a non-root user, etc.).
    #   - mermaid-puppeteer-root.json  : --no-sandbox / --disable-setuid-sandbox.
    #                                    Used only when this script runs as
    #                                    uid 0, because Chromium refuses to
    #                                    start with the setuid sandbox enabled
    #                                    when running as root (common inside
    #                                    container build environments).
    # Both configs also pass --disable-dev-shm-usage, which is a stability
    # workaround for small /dev/shm in containers (not a security flag).
    #
    # Selection is driven by the effective uid, never by user input. Any
    # --puppeteer-config that doesn't resolve to one of these two shipped
    # files is rejected. This prevents an attacker-supplied config from
    # introducing extra dangerous flags such as --remote-debugging-port
    # (would expose a control channel to the headless browser) or
    # --load-extension (would let arbitrary JS run in Chromium).
    sandboxed_pc = script_dir / "mermaid-puppeteer.json"
    root_pc = script_dir / "mermaid-puppeteer-root.json"

    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    default_pc = root_pc if is_root else sandboxed_pc

    allowed = {p.resolve() for p in (sandboxed_pc, root_pc) if p.exists()}
    if args.puppeteer_config is not None:
        requested = args.puppeteer_config.resolve()
        if requested not in allowed:
            sys.stderr.write(
                "Refusing --puppeteer-config: only the shipped configs are "
                f"allowed ({sandboxed_pc.name}, {root_pc.name}). "
                f"Got: {requested}\n"
            )
            sys.exit(2)
        default_pc = args.puppeteer_config

    puppeteer_config = default_pc if default_pc.is_file() else None
    if puppeteer_config is not None:
        uid_str = str(os.geteuid()) if hasattr(os, "geteuid") else "n/a"
        sys.stderr.write(
            f"[render-mermaid-for-pdf] using puppeteer config: "
            f"{puppeteer_config.name} (uid={uid_str})\n"
        )

    # Validate source path exists and is a regular file
    if not args.source.is_file():
        sys.stderr.write(f"ERROR: source markdown not found: {args.source}\n")
        sys.exit(1)

    text = args.source.read_text(encoding="utf-8")
    img_dir = args.img_dir
    if img_dir is None:
        img_dir = args.output.parent / "mermaid_pdf"

    n = 0

    out_parent = args.output.parent.resolve()

    def repl(m: re.Match[str]) -> str:
        nonlocal n
        n += 1
        body = m.group(1)
        png_name = f"diagram_{n:02d}.png"
        out_png = img_dir / png_name
        render_one(
            args.mmdc,
            body,
            out_png,
            args.width,
            args.scale,
            puppeteer_config,
        )
        try:
            rel_to_md = out_png.resolve().relative_to(out_parent)
        except ValueError:
            # --img-dir is outside the output directory; fall back to os.path.relpath
            rel_to_md = Path(os.path.relpath(out_png.resolve(), out_parent))
        return f"\n![Mermaid diagram {n}]({rel_to_md.as_posix()})\n"

    new_text, count = MERMAID_BLOCK.subn(repl, text)
    args.output.write_text(new_text, encoding="utf-8")
    if count:
        print(f"Rendered {count} Mermaid diagram(s) into {img_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
