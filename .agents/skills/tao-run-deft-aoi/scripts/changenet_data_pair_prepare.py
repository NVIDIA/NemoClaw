# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate dataset CSV from paired image directories for TAO ChangeNet.

Supports two modes:
  1. Minimal 3-column CSV (input_path, golden_path, label) with absolute paths.
  2. NV_PCB_Siamese 14-column CSV: copies images into the images_dir tree with
     proper naming so the TAO dataloader can resolve them via:
       images_dir / input_path / object_name + "_" + light + image_ext
"""

import argparse
import os
import shutil
from pathlib import Path

from PIL import Image


HEADER_14 = (
    "input_path,golden_path,label,object_name,"
    "project,boardname,comp_type_2,mpass_mfail,"
    "is_valid,comp_name,part_type,number_of_pins,"
    "description,comp_type_1"
)


def parse_label_from_filename(filename: str) -> str | None:
    """Extract label from filename pattern like 'PCB+bridge_00000.png'."""
    stem = Path(filename).stem
    parts = stem.split("+", 1)
    if len(parts) < 2:
        return None
    label_part = parts[1].rsplit("_", 1)[0]
    return label_part if label_part else None


def normalize_label(label: str) -> str:
    """Preserve 'PASS' verbatim; lowercase + strip every other label.

    ChangeNet's classify dataloader does case-sensitive equality against the
    literal string 'PASS' to detect class 0. Lowercasing it puts every row
    into class 1, after which the fpratio_sampling weighted sampler fails at
    training start with 'RuntimeError: invalid multinomial distribution
    (sum of probabilities <= 0)'. See tao-run-deft-aoi SKILL.md
    'Pipeline → step 6' for the original incident.
    """
    if label == "PASS":
        return label
    return label.lower().strip()


def convert_to_jpg(src: str, dst: str) -> None:
    """Convert an image to JPEG format."""
    img = Image.open(src).convert("RGB")
    img.save(dst, "JPEG", quality=95)


def generate_csv(
    input_dir: str,
    golden_dir: str,
    output_csv: str,
    label: str | None = None,
    default_label: str = "NG",
) -> None:
    """Original minimal 3-column CSV mode."""
    inputs = sorted(os.listdir(input_dir))
    goldens = set(os.listdir(golden_dir))

    rows = []
    for fname in inputs:
        if fname not in goldens:
            print(f"WARN: no golden match for {fname}, skipping")
            continue

        row_label = normalize_label(
            label or parse_label_from_filename(fname) or default_label
        )
        rows.append(
            (
                os.path.join(input_dir, fname),
                os.path.join(golden_dir, fname),
                row_label,
            )
        )

    with open(output_csv, "w") as f:
        f.write("input_path,golden_path,label\n")
        for input_path, golden_path, lbl in rows:
            f.write(f"{input_path},{golden_path},{lbl}\n")

    print(f"Written {len(rows)} rows to {output_csv}")


def generate_csv_siamese(
    input_dir: str,
    golden_dir: str,
    output_csv: str,
    images_dir: str,
    subdirname: str,
    light: str = "SolderLight",
    image_ext: str = ".jpg",
    label: str | None = None,
    default_label: str = "NG",
) -> None:
    """NV_PCB_Siamese 14-column CSV mode.

    Copies SDG images into images_dir with the naming convention expected by
    the TAO ChangeNet classification dataloader:
        images_dir / <subdirname>_ng / <object_name>_<light>.jpg
        images_dir / <subdirname>_ok / <object_name>_<light>.jpg

    Then writes CSV rows with input_path, golden_path, object_name that the
    dataloader can resolve.
    """
    ng_reldir = f"{subdirname}_ng"
    ok_reldir = f"{subdirname}_ok"
    ng_absdir = os.path.join(images_dir, ng_reldir)
    ok_absdir = os.path.join(images_dir, ok_reldir)
    os.makedirs(ng_absdir, exist_ok=True)
    os.makedirs(ok_absdir, exist_ok=True)

    inputs = sorted(os.listdir(input_dir))
    goldens = set(os.listdir(golden_dir))

    rows = []
    label_counts: dict[str, int] = {}
    skipped_unpaired: list[str] = []
    converted = 0
    for fname in inputs:
        if fname not in goldens:
            skipped_unpaired.append(fname)
            print(f"WARN: no golden match for {fname}, skipping")
            continue

        row_label = normalize_label(
            label or parse_label_from_filename(fname) or default_label
        )
        stem = Path(fname).stem
        # Use the stem as object_name (e.g., PCB+bridge_00000)
        object_name = stem
        dst_name = f"{object_name}_{light}{image_ext}"

        src_ng = os.path.join(input_dir, fname)
        src_ok = os.path.join(golden_dir, fname)
        dst_ng = os.path.join(ng_absdir, dst_name)
        dst_ok = os.path.join(ok_absdir, dst_name)

        # Convert to target format (PNG -> JPG if needed)
        if fname.lower().endswith(image_ext):
            shutil.copy2(src_ng, dst_ng)
            shutil.copy2(src_ok, dst_ok)
        else:
            convert_to_jpg(src_ng, dst_ng)
            convert_to_jpg(src_ok, dst_ok)
            converted += 1

        # CSV row: input_path and golden_path are relative to images_dir,
        # with trailing slash to match existing format
        rows.append((
            f"{ng_reldir}/",
            f"{ok_reldir}/",
            row_label,
            object_name,
        ))
        label_counts[row_label] = label_counts.get(row_label, 0) + 1

    with open(output_csv, "w") as f:
        f.write(HEADER_14 + "\n")
        for input_path, golden_path, lbl, obj in rows:
            # Pad columns 5-14 with empty values
            f.write(f"{input_path},{golden_path},{lbl},{obj}" + ",,,,,,,,,," + "\n")

    # Emit ingest_summary.json next to the output CSV — per-label counts,
    # extension conversions, and skip reasons. Reading the stdout one-liner
    # is fine for happy paths but loses everything past N=1000.
    summary = {
        "input_count": len(inputs),
        "paired_count": len(rows),
        "skipped_unpaired_count": len(skipped_unpaired),
        "skipped_unpaired_examples": skipped_unpaired[:10],
        "converted_to_jpg_count": converted,
        "labels": dict(sorted(label_counts.items())),
        "ng_staging_dir": ng_absdir,
        "ok_staging_dir": ok_absdir,
        "output_csv": output_csv,
    }
    summary_path = os.path.join(os.path.dirname(output_csv) or ".", "ingest_summary.json")
    with open(summary_path, "w") as f:
        import json
        json.dump(summary, f, indent=2)
        f.write("\n")

    print(f"Copied {len(rows)} image pairs into {images_dir}")
    print(f"  NG: {ng_absdir}/")
    print(f"  OK: {ok_absdir}/")
    print(f"Written {len(rows)} rows to {output_csv}")
    print(f"Wrote ingest_summary.json to {summary_path}")
    if skipped_unpaired:
        print(f"  WARN: {len(skipped_unpaired)} unpaired NG files skipped (see summary)")
    if converted:
        print(f"  converted {converted} files to {image_ext}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input-dir",
        required=True,
        help="Directory containing input (NG) images",
    )
    parser.add_argument(
        "--golden-dir",
        required=True,
        help="Directory containing golden (OK) images",
    )
    parser.add_argument(
        "--output", "-o", default="dataset.csv", help="Output CSV path",
    )
    parser.add_argument(
        "--label", "-l", default=None,
        help="Force label for all rows. If omitted, parses from filename",
    )
    # NV_PCB_Siamese mode options
    parser.add_argument(
        "--images-dir",
        default=None,
        help="NV_PCB_Siamese images root dir. When set, copies images into "
             "this tree and outputs 14-column CSV.",
    )
    parser.add_argument(
        "--subdir",
        default="sdg",
        help="Subdirectory name under images-dir (default: sdg). "
             "Creates <subdir>_ng/ and <subdir>_ok/ dirs.",
    )
    parser.add_argument(
        "--light",
        default="SolderLight",
        help="Lighting condition suffix (default: SolderLight)",
    )
    parser.add_argument(
        "--image-ext",
        default=".jpg",
        help="Target image extension (default: .jpg)",
    )
    args = parser.parse_args()

    if args.images_dir:
        generate_csv_siamese(
            args.input_dir,
            args.golden_dir,
            args.output,
            images_dir=args.images_dir,
            subdirname=args.subdir,
            light=args.light,
            image_ext=args.image_ext,
            label=args.label,
        )
    else:
        generate_csv(args.input_dir, args.golden_dir, args.output, label=args.label)


if __name__ == "__main__":
    main()
