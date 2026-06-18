#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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

"""List the 125 real anatomy classes in NV-Generate-CTMR's label_dict.

Reads `$NV_GENERATE_ROOT/configs/label_dict.json` and prints classes
grouped by body region. Useful before authoring an anatomy_list /
controllable_anatomy_size override: lets users see canonical class names
instead of guessing.

Examples:
    python skills/nv-generate-ct-rflow/scripts/list_anatomies.py
    python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --region chest
    python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --filter tumor
    python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --controllable
"""

from __future__ import annotations

import sys
from pathlib import Path

import typer

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
from _anatomy import (  # noqa: E402
    CONTROLLABLE_ORGANS,
    CONTROLLABLE_TUMORS,
    SUPPORTED_BODY_REGIONS,
    classes_by_region,
    load_label_dict,
    resolve_nv_generate_root,
)

app = typer.Typer(add_completion=False)


@app.command()
def main(
    region: str = typer.Option(
        None,
        "--region",
        "-r",
        help=f"Show only classes in this region. Choices: {list(SUPPORTED_BODY_REGIONS) + ['general', 'other']}",
    ),
    filter_substring: str = typer.Option(
        None,
        "--filter",
        "-f",
        help="Show only classes whose name contains this substring (case-insensitive).",
    ),
    controllable: bool = typer.Option(
        False,
        "--controllable",
        help="Show only the 10 anatomies that accept controllable_anatomy_size (5 organs + 5 tumors).",
    ),
) -> None:
    """Print the upstream's 132-class label_dict, grouped by region."""
    try:
        root = resolve_nv_generate_root()
        label_dict = load_label_dict(root)
    except (RuntimeError, FileNotFoundError) as e:
        typer.echo(f"error: {e}", err=True)
        raise typer.Exit(2)

    if controllable:
        typer.echo(
            "# Controllable anatomies (accept controllable_anatomy_size = [[name, scale], ...])"
        )
        typer.echo("#   scale: float in [0, 1], or -1 to leave size unconstrained")
        typer.echo()
        typer.echo("## Controllable organs")
        for name in CONTROLLABLE_ORGANS:
            idx = label_dict.get(name, "?")
            typer.echo(f"  [{idx:>3}]  {name}")
        typer.echo()
        typer.echo("## Controllable tumors (at most one per request)")
        for name in CONTROLLABLE_TUMORS:
            idx = label_dict.get(name, "?")
            typer.echo(f"  [{idx:>3}]  {name}")
        raise typer.Exit(0)

    grouped = classes_by_region(label_dict)

    if region is not None and region not in grouped:
        typer.echo(
            f"error: region {region!r} not recognized. " f"Choices: {list(grouped.keys())}",
            err=True,
        )
        raise typer.Exit(2)

    needle = filter_substring.lower() if filter_substring else None

    typer.echo(f"# NV-Generate-CTMR label_dict ({len(label_dict)} classes)")
    typer.echo(f"# Source: {root}/configs/label_dict.json")
    if needle:
        typer.echo(f"# Filter: substring {needle!r}")
    typer.echo()

    regions_to_show = [region] if region else list(grouped.keys())
    total_shown = 0
    for r in regions_to_show:
        entries = grouped.get(r, [])
        if needle:
            entries = [(n, i) for n, i in entries if needle in n.lower()]
        if not entries:
            continue
        typer.echo(f"## {r} ({len(entries)})")
        for name, idx in entries:
            typer.echo(f"  [{idx:>3}]  {name}")
        typer.echo()
        total_shown += len(entries)

    typer.echo(f"# {total_shown} class(es) shown")
    typer.echo(f"# Supported body_region values for synthesis: {list(SUPPORTED_BODY_REGIONS)}")


if __name__ == "__main__":
    app()
