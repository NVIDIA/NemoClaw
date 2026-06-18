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
Step 8: Generate exactly 5 benchmark charts as PNG images for the report.

Usage: python3 generate-benchmark-charts.py <output_dir> <json_data_file>

Expected JSON format (benchmark_data.json written by nv-import-vision-model-report skill pre-flight):
{
  "model_name": "yolo26_nano",
  "engine": "models/yolo26_nano/benchmarks/engines/yolo26n_dynamic_b256.engine",
  "max_bs": 256,
  "trtexec": {
    "bs1":   {"qps": 220.5, "gpu_mean_ms": 4.53},
    "bsmax": {"qps": 39.2,  "gpu_mean_ms": 103.7, "p99_ms": 105.1, "imgs_per_sec": 10035.2}
  },
  "peak_gpu_streams": 334,
  "deepstream": {
    "run1": {"streams": 334, "total_fps": 7850.0, "fps_per_stream": 23.5},
    "run2": {"streams": 238, "total_fps": 7378.4, "fps_per_stream": 31.0}
  }
}

Outputs (fixed names — do not rename):
  chart_trtexec_bs1_vs_bsmax.png   — grouped bar: QPS BS=1 vs BS=MAX_BS
  chart_trtexec_throughput.png     — bar: imgs/sec at MAX_BS + PEAK_GPU_STREAMS annotation
  chart_ds_streams_vs_fps.png      — line: stream count vs fps/stream, 30fps threshold
  chart_trt_vs_ds.png              — grouped bar: trtexec vs DS Run1 vs DS Run2 total imgs/s
  chart_efficiency.png             — bar: DS Run1 and Run2 pipeline efficiency %
"""
import sys
import json
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams.update({
    'figure.facecolor': 'white',
    'axes.facecolor': '#FAFAFA',
    'axes.grid': True,
    'grid.alpha': 0.3,
    'font.size': 11,
    'axes.titlesize': 13,
    'axes.titleweight': 'bold',
})

COLORS = {
    'blue':   '#2196F3',
    'green':  '#4CAF50',
    'orange': '#FF9800',
    'pink':   '#E91E63',
    'purple': '#9C27B0',
    'teal':   '#00BCD4',
    'red':    '#FF5722',
}


def two_line_title(model_name, subtitle):
    """Two-line title: model name (line 1) + subtitle (line 2)."""
    return f'{model_name}\n{subtitle}'


def chart_trtexec_bs1_vs_bsmax(data, output_dir):
    """Grouped bar chart: QPS at BS=1 vs BS=MAX_BS side by side."""
    max_bs = data['max_bs']
    qps_bs1   = data['trtexec']['bs1']['qps']
    qps_bsmax = data['trtexec']['bsmax']['qps']

    labels = ['BS=1', f'BS={max_bs}']
    values = [qps_bs1, qps_bsmax]
    colors = [COLORS['blue'], COLORS['green']]

    fig, ax = plt.subplots(figsize=(10, 6))
    bars = ax.bar(labels, values, color=colors, width=0.5, edgecolor='white', linewidth=1.5)
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + max(values) * 0.01,
                f'{val:.1f}', ha='center', va='bottom', fontweight='bold', fontsize=13)
    ax.set_ylabel('QPS (queries/sec)', fontsize=13)
    ax.set_ylim(0, max(values) * 1.18)
    ax.grid(axis='y', alpha=0.3)
    ax.set_title(two_line_title(data['model_name'], f'trtexec QPS: BS=1 vs BS={max_bs}'))
    plt.tight_layout()
    out = os.path.join(output_dir, 'chart_trtexec_bs1_vs_bsmax.png')
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f'  chart_trtexec_bs1_vs_bsmax.png')


def chart_trtexec_throughput(data, output_dir):
    """Single bar: GPU-only imgs/sec at MAX_BS with PEAK_GPU_STREAMS annotation."""
    max_bs          = data['max_bs']
    imgs_per_sec    = data['trtexec']['bsmax']['imgs_per_sec']
    peak_streams    = data['peak_gpu_streams']
    realtime_imgs   = peak_streams * 30  # the throughput that satisfies peak_streams at 30fps

    fig, ax = plt.subplots(figsize=(10, 6))
    bar = ax.bar([f'BS={max_bs}'], [imgs_per_sec], color=COLORS['blue'], width=0.4,
                 edgecolor='white', linewidth=1.5)
    ax.text(bar[0].get_x() + bar[0].get_width() / 2, imgs_per_sec + imgs_per_sec * 0.01,
            f'{imgs_per_sec:.0f}', ha='center', va='bottom', fontweight='bold', fontsize=13)

    # Annotation line at PEAK_GPU_STREAMS × 30fps threshold
    ax.axhline(y=realtime_imgs, color=COLORS['red'], linestyle='--', linewidth=2,
               label=f'PEAK_GPU_STREAMS={peak_streams} × 30fps = {realtime_imgs:.0f} imgs/s')
    ax.text(0.98, realtime_imgs + imgs_per_sec * 0.01,
            f'PEAK={peak_streams} streams',
            ha='right', va='bottom', color=COLORS['red'], fontsize=10, fontweight='bold',
            transform=ax.get_yaxis_transform())

    ax.set_ylabel('Images / sec', fontsize=13)
    ax.set_ylim(0, imgs_per_sec * 1.25)
    ax.grid(axis='y', alpha=0.3)
    ax.legend(loc='upper left', fontsize=10)
    ax.set_title(two_line_title(data['model_name'],
                                f'GPU Throughput at BS={max_bs} (PEAK_GPU_STREAMS={peak_streams})'))
    plt.tight_layout()
    out = os.path.join(output_dir, 'chart_trtexec_throughput.png')
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f'  chart_trtexec_throughput.png')


def chart_ds_streams_vs_fps(data, output_dir):
    """Line chart: X=stream count, Y=fps/stream. Red dashed line at 30fps."""
    run1 = data['deepstream']['run1']
    run2 = data['deepstream']['run2']

    stream_counts = [run1['streams'], run2['streams']]
    fps_vals      = [run1['fps_per_stream'], run2['fps_per_stream']]

    # Sort by stream count ascending
    pairs = sorted(zip(stream_counts, fps_vals))
    stream_counts = [p[0] for p in pairs]
    fps_vals      = [p[1] for p in pairs]

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(stream_counts, fps_vals, color=COLORS['blue'], linewidth=2.5,
            marker='o', markersize=10, zorder=4)
    for sc, fp in zip(stream_counts, fps_vals):
        ax.text(sc, fp + max(fps_vals) * 0.025,
                f'{fp:.1f} fps', ha='center', va='bottom', fontweight='bold', fontsize=12)

    ax.axhline(y=30, color=COLORS['red'], linestyle='--', linewidth=2,
               label='30 fps/stream real-time threshold')

    ax.set_xlabel('Stream Count', fontsize=13)
    ax.set_ylabel('FPS / Stream', fontsize=13)
    lower = -max(fps_vals) * 0.15
    ax.set_ylim(lower, max(fps_vals) * 1.3)
    ax.set_xticks(stream_counts)
    ax.grid(axis='y', alpha=0.3)
    ax.legend(loc='upper right', fontsize=10)

    # Label each point
    run_labels = {run1['streams']: 'Run 1\n(PEAK_GPU_STREAMS)',
                  run2['streams']: 'Run 2\n(RT_STREAMS)'}
    for sc in stream_counts:
        ax.annotate(run_labels.get(sc, ''), xy=(sc, 0), xytext=(sc, -max(fps_vals) * 0.12),
                    ha='center', fontsize=9, color='#555555')

    ax.set_title(two_line_title(data['model_name'], 'DeepStream: FPS/Stream vs Stream Count'))
    plt.tight_layout()
    out = os.path.join(output_dir, 'chart_ds_streams_vs_fps.png')
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f'  chart_ds_streams_vs_fps.png')


def chart_trt_vs_ds(data, output_dir):
    """Grouped bars: trtexec total imgs/s | DS Run 1 total imgs/s | DS Run 2 total imgs/s."""
    max_bs       = data['max_bs']
    trt_imgs     = data['trtexec']['bsmax']['imgs_per_sec']
    ds1_imgs     = data['deepstream']['run1']['total_fps']
    ds2_imgs     = data['deepstream']['run2']['total_fps']
    n1           = data['deepstream']['run1']['streams']
    n2           = data['deepstream']['run2']['streams']

    labels = [f'trtexec\nBS={max_bs}', f'DS Run 1\n({n1} streams)', f'DS Run 2\n({n2} streams)']
    values = [trt_imgs, ds1_imgs, ds2_imgs]
    colors = [COLORS['pink'], COLORS['blue'], COLORS['green']]

    fig, ax = plt.subplots(figsize=(10, 6))
    bars = ax.bar(labels, values, color=colors, width=0.5, edgecolor='white', linewidth=1.5)
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + max(values) * 0.01,
                f'{val:.0f}', ha='center', va='bottom', fontweight='bold', fontsize=13)
    ax.set_ylabel('Total Images / sec', fontsize=13)
    ax.set_ylim(0, max(values) * 1.18)
    ax.grid(axis='y', alpha=0.3)
    ax.set_title(two_line_title(data['model_name'], 'trtexec vs DeepStream: Total Throughput'))
    plt.tight_layout()
    out = os.path.join(output_dir, 'chart_trt_vs_ds.png')
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f'  chart_trt_vs_ds.png')


def chart_efficiency(data, output_dir):
    """Bar chart: DS Run 1 and Run 2 pipeline efficiency %, dashed line at 100%."""
    trt_imgs  = data['trtexec']['bsmax']['imgs_per_sec']
    ds1_imgs  = data['deepstream']['run1']['total_fps']
    ds2_imgs  = data['deepstream']['run2']['total_fps']
    n1        = data['deepstream']['run1']['streams']
    n2        = data['deepstream']['run2']['streams']

    if trt_imgs <= 0:
        print("ERROR: trtexec imgs_per_sec is zero or negative — cannot compute efficiency", file=sys.stderr)
        sys.exit(1)
    eff1 = round(ds1_imgs / trt_imgs * 100, 1)
    eff2 = round(ds2_imgs / trt_imgs * 100, 1)

    labels = [f'DS Run 1\n({n1} streams)', f'DS Run 2\n({n2} streams)']
    values = [eff1, eff2]
    colors = [COLORS['purple'], COLORS['teal']]

    fig, ax = plt.subplots(figsize=(10, 6))
    bars = ax.bar(labels, values, color=colors, width=0.4, edgecolor='white', linewidth=1.5)
    ax.axhline(y=100, color='#333333', linestyle='--', linewidth=1.5, alpha=0.6,
               label='100% efficiency')
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
                f'{val}%', ha='center', va='bottom', fontweight='bold', fontsize=13)
    ax.set_ylabel('DS Efficiency (%)', fontsize=13)
    ax.set_ylim(0, max(values) * 1.2)
    ax.grid(axis='y', alpha=0.3)
    ax.legend(loc='upper right', fontsize=10)
    ax.set_title(two_line_title(data['model_name'], 'DeepStream Pipeline Efficiency vs trtexec'))
    plt.tight_layout()
    out = os.path.join(output_dir, 'chart_efficiency.png')
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f'  chart_efficiency.png')


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <output_dir> <json_data_file>")
        sys.exit(1)

    output_dir = sys.argv[1]
    json_file  = sys.argv[2]

    os.makedirs(output_dir, exist_ok=True)

    with open(json_file) as f:
        data = json.load(f)

    model = data.get('model_name', 'unknown')
    print(f"Generating 5 charts for {model} -> {output_dir}/")
    chart_trtexec_bs1_vs_bsmax(data, output_dir)
    chart_trtexec_throughput(data, output_dir)
    chart_ds_streams_vs_fps(data, output_dir)
    chart_trt_vs_ds(data, output_dir)
    chart_efficiency(data, output_dir)
    print("Done — 5 charts written.")


if __name__ == "__main__":
    main()
