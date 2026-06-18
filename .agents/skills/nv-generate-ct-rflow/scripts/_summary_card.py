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

"""Render a `summary.html` visual sample card for an nv_generate_ct_rflow run.

Emits, alongside the image/label NIfTI pairs:
  - <output_dir>/summary.html      — single page, all samples
  - <output_dir>/_card/sample_<id>_slices.png  — mid-slice triptych per sample

The card is opt-out (the caller can skip via `--no-summary-card`). It
imports matplotlib lazily so the wrapper does not pay the import cost
when card rendering is skipped.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def render_card(
    output_dir: Path,
    payload: dict[str, Any],
) -> Path | None:
    """Build summary.html for the payload's samples. Returns the path, or
    None on failure (rendering must never block the run)."""
    try:
        import matplotlib  # noqa: PLC0415

        matplotlib.use("Agg", force=True)
        import matplotlib.pyplot as plt  # noqa: PLC0415
        import nibabel as nib  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
    except Exception as e:
        return _emit_card_fallback(output_dir, payload, f"matplotlib/nibabel unavailable: {e}")

    samples = (payload.get("output") or {}).get("samples") or []
    if not samples:
        return _emit_card_fallback(output_dir, payload, "no samples to render")

    card_dir = output_dir / "_card"
    card_dir.mkdir(parents=True, exist_ok=True)

    label_palette = _categorical_palette()

    cards: list[dict[str, Any]] = []
    for i, s in enumerate(samples):
        img_path = Path(s.get("image_path") or "")
        lbl_path = Path(s.get("label_path") or "") if s.get("label_path") else None
        if not img_path.is_file():
            continue
        try:
            img = nib.load(str(img_path))
            img_arr = np.asarray(img.get_fdata(), dtype=np.float32)
            mask_arr = None
            if lbl_path is not None and lbl_path.is_file():
                mask_arr = np.asarray(nib.load(str(lbl_path)).get_fdata()).astype(np.int64)
        except Exception as e:
            cards.append(
                {
                    "title": f"sample {i}",
                    "png_rel": None,
                    "error": f"could not read NIfTI: {e}",
                    "summary": s,
                }
            )
            continue

        png_path = card_dir / f"sample_{i}_slices.png"
        _render_triptych(img_arr, mask_arr, label_palette, png_path, plt)
        cards.append(
            {
                "title": f"sample {i}",
                "png_rel": str(png_path.relative_to(output_dir)),
                "summary": s,
            }
        )

    html_path = output_dir / "summary.html"
    html_path.write_text(_render_html(payload, cards))
    return html_path


def _render_triptych(img_arr, mask_arr, palette, png_path: Path, plt) -> None:
    """Mid-slice axial / coronal / sagittal with label overlay if present."""
    import numpy as np  # noqa: PLC0415

    shape = img_arr.shape
    mid = [s // 2 for s in shape]
    # Display window: typical soft-tissue CT window (HU [-200, 250]) gives a
    # good general look without over-saturating bone. The verifier confirms
    # HU range plausibility separately.
    vmin, vmax = -float("200.0"), float("250.0")

    fig, axes = plt.subplots(1, int("3"), figsize=(int("12"), int("4")), dpi=int("100"))
    planes = [
        (
            "axial (Z mid)",
            img_arr[:, :, mid[2]].T,
            mask_arr[:, :, mid[2]].T if mask_arr is not None else None,
        ),
        (
            "coronal (Y mid)",
            img_arr[:, mid[1], :].T,
            mask_arr[:, mid[1], :].T if mask_arr is not None else None,
        ),
        (
            "sagittal (X mid)",
            img_arr[mid[0], :, :].T,
            mask_arr[mid[0], :, :].T if mask_arr is not None else None,
        ),
    ]
    for ax, (title, img_slice, mask_slice) in zip(axes, planes):
        ax.imshow(np.flipud(img_slice), cmap="gray", vmin=vmin, vmax=vmax, origin="upper")
        if mask_slice is not None:
            overlay = np.where(mask_slice > 0, mask_slice, np.nan)
            ax.imshow(
                np.flipud(overlay),
                cmap=palette,
                alpha=float("0.45"),
                vmin=1,
                vmax=int("132"),
                origin="upper",
            )
        ax.set_title(title, fontsize=int("10"))
        ax.axis("off")
    plt.tight_layout()
    plt.savefig(png_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def _categorical_palette():
    """132-class palette built from matplotlib qualitative colormaps so
    adjacent label IDs are visually distinguishable."""
    from matplotlib import colormaps  # noqa: PLC0415
    from matplotlib.colors import ListedColormap  # noqa: PLC0415

    tab20 = colormaps.get_cmap("tab20")(range(int("20")))
    tab20b = colormaps.get_cmap("tab20b")(range(int("20")))
    tab20c = colormaps.get_cmap("tab20c")(range(int("20")))
    set3 = colormaps.get_cmap("Set3")(range(int("12")))
    accent = colormaps.get_cmap("Accent")(range(int("8")))
    paired = colormaps.get_cmap("Paired")(range(int("12")))
    palette = list(tab20) + list(tab20b) + list(tab20c) + list(set3) + list(accent) + list(paired)
    # Pad to 132+ entries
    while len(palette) < int("140"):
        palette.extend(palette[: int("140") - len(palette)])
    return ListedColormap(palette[: int("140")])


def _render_html(payload: dict[str, Any], cards: list[dict[str, Any]]) -> str:
    inp = payload.get("input", {}) or {}
    out = payload.get("output", {}) or {}
    inv = payload.get("invocation", {}) or {}
    rt = payload.get("runtime", {}) or {}

    requested_anatomy = inp.get("anatomy_list_requested") or []
    union_ids = out.get("union_label_ids_present", []) or []

    rows = [
        ("model", payload.get("model", "?")),
        ("version", inp.get("version", "?")),
        ("body_region requested", _fmt(inp.get("body_region_requested"))),
        ("anatomy_list requested", _fmt(requested_anatomy)),
        ("output_size requested", _fmt(inp.get("output_size_requested"))),
        ("spacing requested", _fmt(inp.get("spacing_requested"))),
        ("random_seed", inp.get("random_seed", "?")),
        ("num_output_samples", out.get("num_samples", "?")),
        ("subprocess_seconds", rt.get("subprocess_seconds", "?")),
        ("exit_code", inv.get("exit_code", "?")),
        ("all_pairs_readable", out.get("all_pairs_readable", "?")),
        ("all_geometry_consistent", out.get("all_geometry_consistent", "?")),
        ("any_foreground_present", out.get("any_foreground_present", "?")),
        ("all_images_hu_like", out.get("all_images_hu_like", "?")),
        ("union_label_ids_present", _fmt(union_ids)),
    ]

    summary_table = "\n".join(
        f'    <tr><td class="k">{k}</td><td class="v">{_esc(str(v))}</td></tr>' for k, v in rows
    )

    card_blocks = []
    for c in cards:
        title = _esc(c["title"])
        png_rel = c.get("png_rel")
        err = c.get("error")
        sample_summary = c.get("summary") or {}
        ids = sample_summary.get("label_ids_present", []) or []
        shape = sample_summary.get("image_shape", []) or []
        hu_min = sample_summary.get("image_hu_min", "?")
        hu_max = sample_summary.get("image_hu_max", "?")
        if png_rel:
            img_tag = f'<img src="{_esc(png_rel)}" alt="{title}" />'
        else:
            img_tag = f'<div class="error">render failed: {_esc(err or "?")}</div>'
        card_blocks.append(f"""
  <div class="card">
    <h3>{title}</h3>
    {img_tag}
    <div class="meta">
      <span><b>shape:</b> {_esc(_fmt(shape))}</span>
      <span><b>HU range:</b> [{_esc(str(hu_min))}, {_esc(str(hu_max))}]</span>
      <span><b>label ids present:</b> {_esc(_fmt(ids))}</span>
    </div>
  </div>""")

    cards_html = "\n".join(card_blocks)

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>nv_generate_ct_rflow run summary</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 1.5em auto; padding: 0 1em; color: #222; }}
  h1 {{ font-size: 1.4em; margin-bottom: 0.2em; }}
  .sub {{ color: #666; font-size: 0.95em; }}
  table.summary {{ border-collapse: collapse; margin: 1em 0; }}
  table.summary td {{ padding: 4px 12px; border-bottom: 1px solid #eee; vertical-align: top; }}
  td.k {{ color: #555; }}
  td.v {{ font-family: ui-monospace, Menlo, Consolas, monospace; }}
  .card {{ border: 1px solid #ddd; border-radius: 6px; padding: 1em; margin: 1em 0; }}
  .card img {{ max-width: 100%; height: auto; display: block; }}
  .meta {{ font-size: 0.9em; color: #444; margin-top: 0.6em; display: flex; gap: 1.5em; flex-wrap: wrap; }}
  .meta b {{ color: #222; }}
  .error {{ color: #b00; }}
  .disclaimer {{ background: #fffbe6; border-left: 4px solid #f5c518; padding: 0.6em 1em; font-size: 0.92em; margin-top: 1.5em; }}
</style></head>
<body>
  <h1>nv_generate_ct_rflow — run summary</h1>
  <div class="sub">Generated by skills/nv-generate-ct-rflow. Mid-slice axial / coronal / sagittal triptych per sample, with label overlay at α=0.45.</div>
  <table class="summary">
{summary_table}
  </table>
{cards_html}
  <div class="disclaimer">
    <b>Engineering verification only.</b> These are synthetic volumes
    produced by a diffusion model. They are <i>not</i> clinically
    meaningful and <i>not</i> suitable as training data for production
    deployment without independent quality review.
  </div>
</body></html>
"""


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _fmt(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(str(x) for x in v) + "]"
    return str(v)


def _emit_card_fallback(output_dir: Path, payload: dict[str, Any], reason: str) -> Path | None:
    """Drop a minimal summary.html that records the reason rendering failed."""
    html_path = output_dir / "summary.html"
    body = f"<html><body><h1>summary.html could not be rendered</h1><p>{_esc(reason)}</p></body></html>"
    try:
        html_path.write_text(body)
        return html_path
    except Exception:
        return None


if __name__ == "__main__":
    raise SystemExit(
        "_summary_card is imported by run_rflow_ct.py; run that wrapper " "entrypoint instead."
    )
