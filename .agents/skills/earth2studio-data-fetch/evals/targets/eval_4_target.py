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
# Target reference for eval 4:
# Fetch 48-hour forecast of mean sea level pressure initialized 2024-01-15 00Z.
# GFS_FX is a good default choice (global, operational, no auth).

from datetime import datetime, timedelta

from earth2studio.data import GFS_FX

# Initialize GFS forecast data source
ds = GFS_FX()

# Fetch msl forecast at 48h lead time
time = [datetime(2024, 1, 15, 0)]
lead_time = [timedelta(hours=48)]
variable = ["msl"]

data = ds(time, lead_time, variable)

# Inspect the result
print(data)
print(f"Shape: {data.shape}")
print(f"Coords: {list(data.coords)}")
