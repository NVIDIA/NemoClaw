#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Render a defect_spec.jsonl for anomalygen AMP routing.

Fallback used by Day 0 and Day 1 anomaly-infer when the prepared inference URL
does not ship a hand-authored `defect_spec.jsonl` at its root.
Two input modes: `--pairs '[["material","defect"],...]'` for multi-material
taxonomies, or `--material X --defects '["d1","d2"]'` for single-material.
The schema matches `skills/anomalygen/assets/defect_spec_template.jsonl`:

    {"defect_type": "<MATERIAL>+<DEFECT>", "spatial_dependency": "<mode>",
     "roi_prompt_defect_location": "<prompt-or-empty>"}

`spatial_dependency` is one of `free` / `text` / `cad`; `roi_prompt_defect_location`
is required when mode=`text` (Qwen+SAM2) and unused otherwise. Per-defect mode
mixing is not supported by this fallback — ship a custom defect_spec.jsonl in
the prepared URL artifact for that.
"""
import argparse
import json
import sys


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--output", required=True, help="Path to write defect_spec.jsonl")
    # Two input shapes — exactly one is required:
    #   --pairs '[["IC","bridge"],["passive_component","missing"]]'  (multi-material)
    #   --material IC --defects '["bridge","excess_solder"]'           (single material)
    p.add_argument("--pairs", default="",
                   help='JSON list of [material, defect] pairs, '
                        'e.g. \'[["IC","bridge"],["passive_component","missing"]]\'')
    p.add_argument("--material", default="", help="Anomaly material prefix (single-material mode)")
    p.add_argument("--defects", default="",
                   help='JSON list of defect names (single-material mode)')
    p.add_argument("--spatial-dependency", default="free", choices=["free", "text", "cad"],
                   help="AMP routing branch (default: free = whole-image ROI)")
    p.add_argument("--roi-prompt", default="",
                   help="Free-text ROI prompt (required when --spatial-dependency=text)")
    args = p.parse_args()

    if args.spatial_dependency == "text" and not args.roi_prompt:
        print("ERROR: --roi-prompt is required when --spatial-dependency=text", file=sys.stderr)
        return 2

    pairs: list[tuple[str, str]] = []
    if args.pairs:
        try:
            parsed = json.loads(args.pairs)
        except json.JSONDecodeError as e:
            print(f"ERROR: --pairs is not valid JSON: {e}", file=sys.stderr)
            return 2
        for i, item in enumerate(parsed):
            if not (isinstance(item, list) and len(item) == 2
                    and all(isinstance(x, str) for x in item)):
                print(f"ERROR: --pairs entry {i} must be [material, defect] strings",
                      file=sys.stderr)
                return 2
            pairs.append((item[0], item[1]))
    elif args.material and args.defects:
        try:
            defects = json.loads(args.defects)
        except json.JSONDecodeError as e:
            print(f"ERROR: --defects is not valid JSON: {e}", file=sys.stderr)
            return 2
        if not isinstance(defects, list) or not all(isinstance(d, str) for d in defects):
            print("ERROR: --defects must be a JSON array of strings", file=sys.stderr)
            return 2
        pairs = [(args.material, d) for d in defects]
    else:
        print("ERROR: pass either --pairs or (--material + --defects)", file=sys.stderr)
        return 2

    with open(args.output, "w") as fp:
        for material, defect in pairs:
            fp.write(json.dumps({
                "defect_type": f"{material}+{defect}",
                "spatial_dependency": args.spatial_dependency,
                "roi_prompt_defect_location": args.roi_prompt,
            }) + "\n")
    print(f"wrote {len(pairs)} entries to {args.output} "
          f"(spatial_dependency={args.spatial_dependency})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
