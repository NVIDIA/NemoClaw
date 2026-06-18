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
Step 7: Create static-batch ONNX files from a batch-1 ONNX.
Patches input/output batch dims and internal Reshape nodes.

Usage: python3 make-static-batch-onnx.py <src_onnx> <dst_onnx> <batch_size>
Example: python3 make-static-batch-onnx.py yolox_nano.onnx b16/yolox_nano_b16.onnx 16
"""
import sys
import onnx
import numpy as np
from onnx import numpy_helper

if len(sys.argv) != 4:
    print(f"Usage: {sys.argv[0]} <src_onnx> <dst_onnx> <batch_size>")
    sys.exit(1)

src_path = sys.argv[1]
dst_path = sys.argv[2]
try:
    batch_size = int(sys.argv[3])
    if batch_size <= 0:
        raise ValueError("Batch size must be positive")
except ValueError as e:
    print(f"Error: Invalid batch size '{sys.argv[3]}': {e}")
    sys.exit(1)

try:
    model = onnx.load(src_path)
except FileNotFoundError:
    print(f"Error: File '{src_path}' not found")
    sys.exit(1)
except Exception as e:
    print(f"Error loading ONNX model: {e}")
    sys.exit(1)

graph = getattr(model, "graph", None)
if graph is None:
    print("Error: ONNX model has no graph")
    sys.exit(1)

# Set static batch on inputs
for inp in graph.input:
    if len(inp.type.tensor_type.shape.dim) > 0:
        inp.type.tensor_type.shape.dim[0].dim_param = ""
        inp.type.tensor_type.shape.dim[0].dim_value = batch_size

# Set static batch on outputs
for out in graph.output:
    if len(out.type.tensor_type.shape.dim) > 0:
        out.type.tensor_type.shape.dim[0].dim_param = ""
        out.type.tensor_type.shape.dim[0].dim_value = batch_size

# Fix Reshape nodes that reference batch=1
for node in graph.node:
    if node.op_type == "Reshape":
        shape_input = node.input[1]
        for init in graph.initializer:
            if init.name == shape_input:
                shape_data = numpy_helper.to_array(init).copy()
                if shape_data.size > 0 and shape_data[0] == 1:
                    shape_data[0] = batch_size
                    init.CopyFrom(numpy_helper.from_array(shape_data, name=init.name))

onnx.save(model, dst_path)
print(f"Saved {dst_path} with batch={batch_size}")
