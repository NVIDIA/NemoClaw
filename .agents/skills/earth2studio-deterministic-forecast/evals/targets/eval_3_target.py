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
from tqdm import tqdm

from earth2studio.data import GFS, fetch_data
from earth2studio.io import ZarrBackend
from earth2studio.models.px import Pangu
from earth2studio.utils.coords import map_coords, split_coords
from earth2studio.utils.time import to_time_array

# 1. Configuration
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
time = to_time_array(["2024-03-01T00:00:00"])
nsteps = 20  # 5 days / 6h time step = 20 steps

# 2. Initialize model and move to device
model = Pangu.load_model(Pangu.load_default_package())
model = model.to(device)

# 3. Initialize data source
data = GFS()

# 4. Fetch initial conditions
prognostic_ic = model.input_coords()
x, coords = fetch_data(
    source=data,
    time=time,
    variable=prognostic_ic["variable"],
    lead_time=prognostic_ic["lead_time"],
    device=device,
)

# 5. Define output coordinate subsetting (only z500 and t2m)
output_coords = OrderedDict(
    {
        "variable": np.array(["z500", "t2m"]),
    }
)

# 6. Set up IO backend with total coordinate system
total_coords = model.output_coords(model.input_coords()).copy()
# Remove batch dimensions (shape == (0,))
for key, value in list(total_coords.items()):
    if value.shape == (0,):
        del total_coords[key]
# Set time and lead_time arrays
total_coords["time"] = time
total_coords["lead_time"] = np.asarray(
    [
        model.output_coords(model.input_coords())["lead_time"] * i
        for i in range(nsteps + 1)
    ]
).flatten()
total_coords.move_to_end("lead_time", last=False)
total_coords.move_to_end("time", last=False)

# Apply output_coords overrides (e.g. variable subsetting)
for key, value in total_coords.items():
    total_coords[key] = output_coords.get(key, value)

# Initialize IO
io = ZarrBackend("output_eval7.zarr")
var_names = total_coords.pop("variable")
io.add_array(total_coords, var_names)

# 7. Map input coordinates to model's expected input
x, coords = map_coords(x, coords, model.input_coords())

# 8. Create prognostic iterator
model_iterator = model.create_iterator(x, coords)

# 9. Step through the model and write output
for step, (x, coords) in enumerate(
    tqdm(model_iterator, total=nsteps + 1, desc="Running inference")
):
    # Subselect output variables/coordinates
    x, coords = map_coords(x, coords, output_coords)
    # Split and write to IO
    io.write(*split_coords(x, coords))
    if step == nsteps:
        break

print("Forecast complete. Output at: output_eval7.zarr")
