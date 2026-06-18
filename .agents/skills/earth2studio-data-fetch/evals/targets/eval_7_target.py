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
# Target reference for eval 7:
# Fetch surface weather station temperature observations using ISD dataframe source.

from datetime import datetime, timedelta

from earth2studio.data import ISD

# Initialize ISD data source (Integrated Surface Database - global hourly stations)
ds = ISD(time_tolerance=timedelta(hours=1))

# Fetch station temperature observations
time = [datetime(2024, 1, 1, 0)]
variable = ["t2m"]

data = ds(time, variable)

# Inspect the result (returns a pandas DataFrame)
print(data)
print(f"Columns: {list(data.columns)}")
print(f"Shape: {data.shape}")
