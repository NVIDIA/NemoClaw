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

from collections import OrderedDict

import numpy as np
import torch

from earth2studio.data import GFS
from earth2studio.io import ZarrBackend
from earth2studio.models.px import AIFS
from earth2studio.run import deterministic

# 1. Initialize model (any MR-class model fitting 80GB is acceptable)
model = AIFS.load_model(AIFS.load_default_package())

# 2. Initialize data source (must be compatible with model's input_coords)
data = GFS()

# 3. Initialize IO backend
io = ZarrBackend("output_eval1.zarr")

# 4. Subselect output variables
output_coords = OrderedDict(
    {
        "variable": np.array(["t2m", "u10m", "v10m"]),
    }
)

# 5. Run deterministic forecast
# AIFS has a 6-hour time step, 3 days = 72h / 6h = 12 steps
io = deterministic(
    time=["2024-01-15T00:00:00"],
    nsteps=12,
    prognostic=model,
    data=data,
    io=io,
    output_coords=output_coords,
    device=torch.device("cuda"),
)

print("Forecast complete.")
