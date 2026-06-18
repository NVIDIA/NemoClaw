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
from collections import defaultdict, deque

import numpy as np


def build_adjacency(edges):
    adj = defaultdict(list)
    for src, dst in edges:
        adj[src].append(dst)
        adj[dst].append(src)
    return adj


def connected_components(adj, nodes):
    seen = set()
    component_of = {}
    label = 0
    for start in nodes:
        if start in seen:
            continue
        queue = deque([start])
        seen.add(start)
        while queue:
            node = queue.popleft()
            component_of[node] = label
            for neighbor in adj[node]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    queue.append(neighbor)
        label += 1
    return component_of, label


def component_sizes(component_of, n_labels):
    sizes = np.zeros(n_labels, dtype=np.int64)
    for label in component_of.values():
        sizes[label] += 1
    return sizes
