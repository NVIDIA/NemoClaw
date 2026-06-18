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
Step 1: Inspect an ONNX model — inputs, outputs, opset, operators, validity.
Usage: python3 inspect-onnx.py <onnx_file>
"""
import sys
import onnx

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <onnx_file>")
    sys.exit(1)

try:
    model = onnx.load(sys.argv[1])
except FileNotFoundError:
    print(f"Error: File '{sys.argv[1]}' not found")
    sys.exit(1)
except Exception as e:
    print(f"Error loading ONNX model: {e}")
    sys.exit(1)

print("=== ONNX Model Info ===")
print(f"File:     {sys.argv[1]}")
opset_ver = model.opset_import[0].version if model.opset_import else "N/A"
print(f"Opset:    {opset_ver}")
print(f"IR ver:   {model.ir_version}")
print(f"Producer: {model.producer_name} {model.producer_version}")

graph = getattr(model, "graph", None)
if graph is None:
    print("Error: ONNX model has no graph")
    sys.exit(1)

print(f"Nodes:    {len(graph.node)}")

dtype_map = {1: "float32", 10: "float16", 7: "int64", 6: "int32", 9: "bool"}

print("\n=== INPUTS ===")
for inp in graph.input:
    shape = [d.dim_value if d.dim_value else d.dim_param for d in inp.type.tensor_type.shape.dim]
    dtype = dtype_map.get(inp.type.tensor_type.elem_type, inp.type.tensor_type.elem_type)
    print(f"  {inp.name}: shape={shape}, dtype={dtype}")

print("\n=== OUTPUTS ===")
for out in graph.output:
    shape = [d.dim_value if d.dim_value else d.dim_param for d in out.type.tensor_type.shape.dim]
    dtype = dtype_map.get(out.type.tensor_type.elem_type, out.type.tensor_type.elem_type)
    print(f"  {out.name}: shape={shape}, dtype={dtype}")

print("\n=== Operators ===")
op_types = sorted(set(n.op_type for n in graph.node))
print(f"  {', '.join(op_types)}")
print(f"  Total unique ops: {len(op_types)}")

try:
    onnx.checker.check_model(model)
    print("\n✓ ONNX model is valid")
except Exception as e:
    print(f"\n✗ ONNX validation error: {e}")

# --- Machine-parseable summary (consumed by nv-engine-build and ds-run-pipeline) ---
# grep patterns expect lines: "input_name: <name>", "height: <int>", "width: <int>"
print("\n=== Machine-Parseable Summary ===")
if graph and graph.input:
    inp = graph.input[0]
    dims = inp.type.tensor_type.shape.dim
    print(f"input_name: {inp.name}")
    if len(dims) >= 4:
        # Assume NCHW: dim[0]=batch, dim[1]=channels, dim[2]=H, dim[3]=W
        h_val = dims[2].dim_value  # 0 means dynamic
        w_val = dims[3].dim_value
        if h_val > 0 and w_val > 0:
            print(f"height: {h_val}")
            print(f"width: {w_val}")
        else:
            # Dynamic spatial dims — print symbol so callers can detect failure
            print(f"height: DYNAMIC (symbol={dims[2].dim_param or 'unknown'})")
            print(f"width: DYNAMIC (symbol={dims[3].dim_param or 'unknown'})")
            print("WARNING: Dynamic H/W — set height and width manually in trtexec flags")
    else:
        print(f"WARNING: Input has {len(dims)} dims — expected 4 (NCHW); cannot auto-detect H/W")
else:
    print("WARNING: No inputs found in ONNX graph")
