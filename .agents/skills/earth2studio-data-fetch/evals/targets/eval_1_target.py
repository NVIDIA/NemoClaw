# SPDX-FileCopyrightText: Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES.
# SPDX-FileCopyrightText: All rights reserved.
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

#
# Target reference for eval 1:
# Fetch global 2m temperature for 2024-01-01 00Z using a fast analysis source.
# GFS is recommended for speed (operational, no auth), ARCO is an alternative.

from datetime import datetime

from earth2studio.data import GFS

# Initialize data source (GFS: operational, fast, no auth required)
ds = GFS()

# Fetch 2m temperature for a single time
time = [datetime(2024, 1, 1, 0)]
variable = ["t2m"]

data = ds(time, variable)

# Inspect the result
print(data)
print(f"Shape: {data.shape}")
print(f"Coords: {list(data.coords)}")
