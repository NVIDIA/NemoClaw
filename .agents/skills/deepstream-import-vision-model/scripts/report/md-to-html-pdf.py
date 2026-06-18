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
Convert a GFM-style Markdown benchmark report to a styled HTML file and then
to PDF via wkhtmltopdf.

Images referenced as ![alt](file.png) are resolved relative to the markdown
file's directory and embedded as base64 data URIs so the HTML is self-contained.

Usage:
    python3 md-to-html-pdf.py <report.md> <style.css> <output_dir> [model_name]

    model_name (optional): if provided, PDF is named benchmark_report_{model_name}.pdf
                           if omitted, derived from output_dir parent folder name

Produces:
    <output_dir>/benchmark_report.html
    <output_dir>/benchmark_report_{model_name}.pdf
"""
import sys
import os
import re
import base64
import subprocess
import markdown

def embed_images(html: str, base_dir: str) -> str:
    """Replace <img src="file.png"> with base64-embedded data URIs."""
    def replacer(match):
        prefix = match.group(1)
        src = match.group(2)
        suffix = match.group(3)
        # Skip URLs and absolute paths
        if re.match(r'^(https?|data|ftp)://', src) or os.path.isabs(src):
            return match.group(0)
        img_path = os.path.realpath(os.path.join(base_dir, src))
        base_real = os.path.realpath(base_dir)
        # Reject path traversal outside base_dir
        if not img_path.startswith(base_real + os.sep) and img_path != base_real:
            return match.group(0)
        if os.path.isfile(img_path):
            ext = os.path.splitext(src)[1].lstrip('.').lower()
            mime = {'png': 'image/png', 'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg', 'svg': 'image/svg+xml',
                    'gif': 'image/gif'}.get(ext, 'image/png')
            with open(img_path, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode()
            return f'{prefix}data:{mime};base64,{b64}{suffix}'
        return match.group(0)
    return re.sub(r'(<img\s[^>]*src=["\'])([^"\']+)(["\'])', replacer, html)

def main():
    if len(sys.argv) not in (4, 5):
        print(f"Usage: {sys.argv[0]} <report.md> <style.css> <output_dir> [model_name]")
        sys.exit(1)

    md_path = sys.argv[1]
    css_path = sys.argv[2]
    out_dir = sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)

    # Derive model name: explicit arg > parent-of-output_dir > "model"
    if len(sys.argv) == 5:
        model_name = sys.argv[4]
    else:
        # output_dir is typically models/{model_name}/reports/ — walk up two levels
        abs_out = os.path.abspath(out_dir)
        model_name = os.path.basename(os.path.dirname(abs_out)) or "model"

    base_dir = os.path.dirname(os.path.abspath(md_path))

    with open(md_path) as f:
        md_text = f.read()

    # Strip YAML frontmatter
    md_text = re.sub(r'^---\n.*?\n---\n', '', md_text, count=1, flags=re.DOTALL)

    with open(css_path) as f:
        css = f.read()

    # Convert markdown to HTML
    html_body = markdown.markdown(md_text, extensions=['tables', 'fenced_code'])

    # Wrap in full HTML document
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DeepStream Benchmark Report — {model_name}</title>
<style>
{css}
@media print {{
  body {{ max-width: 100%; padding: 10px; }}
  img {{ max-width: 100%; page-break-inside: avoid; }}
  table {{ page-break-inside: avoid; }}
  h2 {{ page-break-after: avoid; }}
}}
</style>
</head>
<body>
{html_body}
</body>
</html>"""

    # Embed images as base64
    html = embed_images(html, base_dir)

    html_out = os.path.join(out_dir, 'benchmark_report.html')
    pdf_out = os.path.join(out_dir, f'benchmark_report_{model_name}.pdf')

    with open(html_out, 'w') as f:
        f.write(html)
    print(f"  HTML: {html_out}")

    # Convert to PDF.
    # Intentionally NOT passing --enable-local-file-access: all images have already
    # been converted to base64 data: URIs by embed_images(), and the CSS is inlined
    # in <style>...</style>, so no file:// fetching is needed. Keeping it disabled
    # blocks a CSS/HTML-injection exfil vector if the upstream Markdown ever carries
    # untrusted content (e.g. an HF model card).
    result = subprocess.run(
        [
            'wkhtmltopdf',
            '--page-size', 'A4',
            '--margin-top', '15mm',
            '--margin-bottom', '15mm',
            '--margin-left', '15mm',
            '--margin-right', '15mm',
            '--image-quality', '100',
            '--no-outline',
            html_out, pdf_out,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        shell=False,
        timeout=300,
    )

    if result.returncode == 0:
        print(f"  PDF:  {pdf_out}")
    else:
        print(f"  PDF generation failed: {result.stderr[:500]}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
