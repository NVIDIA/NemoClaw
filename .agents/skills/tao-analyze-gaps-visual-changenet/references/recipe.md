# VCN Gap Analysis Reference Invocation

Paste-and-edit the workspace, the four paths, and the two numeric knobs; this runs end-to-end. Capture stdout so the script-check hook sees row counts.

```bash
WORKSPACE=<absolute path>            # mounted identically inside the container
EXP_DIR=<experiment_result_dir>      # contains inference/inference.csv and train.yaml; must be inside $WORKSPACE
DATASET_ROOT=<dataset_root>          # image root for inference.csv input_path entries; must be inside $WORKSPACE
MIN_RECALL=1.0                       # zero-miss default; lower if KPI relaxes
TOP_K=50                             # per-label augmentation budget
OUT="$EXP_DIR/rca_results/$(date +%Y-%m-%d_%H%M%S)"
SPEC="$OUT/vcn_aoi_spec.yaml"
IMG=$(python3 -c "import yaml,os; print(yaml.safe_load(open(os.environ['TAO_SKILL_BANK_PATH']+'/versions.yaml'))['images']['tao_toolkit']['data_services'])")

mkdir -p "$OUT"

# Write the gap-analysis spec for this run
cat > "$SPEC" <<EOF
min_recall: $MIN_RECALL
top_k_per_label: $TOP_K
EOF

docker run --gpus all --rm --ipc=host \
    --user "$(id -u):$(id -g)" \
    -v "$WORKSPACE:$WORKSPACE" -w "$WORKSPACE" \
    "$IMG" gap_analysis vcn_aoi \
    -e "$SPEC" \
    inference_results_dir="$EXP_DIR/inference/latest/" \
    train_config="$EXP_DIR/train.yaml" \
    kpi_media_path="$DATASET_ROOT" \
    results_dir="$OUT"

# Sanity print so the script-check hook sees real numbers
python3 - "$OUT" << 'PYEOF'
import json, os, sys
out = sys.argv[1]
unreachable = os.path.join(out, "unreachable_kpi.txt")
if os.path.isfile(unreachable):
    print("KPI UNREACHABLE — see", unreachable)
    sys.exit(0)
with open(os.path.join(out, "threshold.txt")) as f:
    print("threshold:", f.read().strip())
with open(os.path.join(out, "metrics.json")) as f:
    m = json.load(f)
print(f"precision={m['precision']:.4f} recall={m['recall']:.4f} f1={m['f1']:.4f}")
import pandas as pd
df = pd.read_parquet(os.path.join(out, "kpi_gaps.parquet"))
print(f"kpi_gaps.parquet: rows={len(df)}, cols={list(df.columns)}")
print(df['label'].value_counts())
PYEOF
```
