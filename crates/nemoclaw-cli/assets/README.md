<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Terminal Logo

`nvidia-eye.png.base64` is the repository's [NVIDIA symbol](../../../fern/assets/NVIDIA_symbol.svg), rasterized for the startup header.
Source revision: `478825aa65bbb625809ff808414d5418a0b0824e`.
On 2026-09-23, removed editor metadata from the conversion input and rendered an aspect-preserving transparent PNG within 80 × 53 pixels using librsvg 2.58.0; the artwork is unchanged.
Base64 encoding lets the CLI embed one Kitty graphics payload without runtime image dependencies.

Regenerate from the repository root with Python 3 and `rsvg-convert`:

```sh
python3 - <<'PY'
import base64
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

root = ET.parse('fern/assets/NVIDIA_symbol.svg').getroot()
root.remove(root.find('{http://www.w3.org/2000/svg}metadata'))
png = subprocess.check_output(
    ['rsvg-convert', '-w', '80', '-h', '53', '-a'], input=ET.tostring(root)
)
encoded = base64.b64encode(png).decode()
assert len(encoded) <= 4096, 'Kitty payload needs chunking'
Path('crates/nemoclaw-cli/assets/nvidia-eye.png.base64').write_text(encoded + '\n')
PY
```
