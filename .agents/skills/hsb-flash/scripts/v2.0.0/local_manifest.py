# SPDX-FileCopyrightText: Copyright (c) 2024 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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
# Create a manifest.yaml that trains the local downloader to
# program just a single FPGA with a local bit file. Users
# are trusted to ensure that the bit file is correct for the
# device given here.
#

import argparse
import datetime
import hashlib
import os
import yaml

def measure(filename):
    with open(filename, "rb") as f:
        stat = os.fstat(f.fileno())
        md5 = hashlib.md5()
        for chunk in iter(lambda: f.read(4096), b""):
            md5.update(chunk)
        print(f"name={filename} size={stat.st_size} {md5.hexdigest()=}")
        image = {
            "filename": filename,
            "size": stat.st_size,
            "md5": md5.hexdigest(),
        }
        return image

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version",
        required=True,
        help="Component version (e.g. \"2402\")",
    )
    parser.add_argument(
        "--manifest",
        default="manifest.yaml",
        help="Manifest file to write with programming data.",
    )
    parser.add_argument(
        "--cpnx-file",
        help="CPNX bit file to program.",
    )
    parser.add_argument(
        "--clnx-file",
        help="CLNX bit file to program.",
    )
    parser.add_argument(
        "--stratix-file",
        help="Stratix-10 rpd file to program.",
    )
    parser.add_argument(
        "--strategy",
        help="Specify the strategy to use with this manifest.",
    )
    args = parser.parse_args()
    # ...
    version = args.version
    utc = datetime.timezone.utc
    now = datetime.datetime.now(utc)
    cpnx_file = args.cpnx_file
    clnx_file = args.clnx_file
    stratix_file = args.stratix_file
    if (cpnx_file is None) and (clnx_file is None) and (stratix_file is None):
        parser.error("One of --cpnx-file or --clnx-file or --stratix-file must be specified.")
    strategy = args.strategy
    if strategy is None:
        if (stratix_file is not None):
            strategy = "sensor_bridge_100"
        elif (cpnx_file is not None) or (clnx_file is not None):
            strategy = "sensor_bridge_10"
    # We should never fail this due to the parser.error check above.
    assert strategy is not None
    #
    hololink = {
        "archive": {
            "version": version,
            "enrollment_date": now.isoformat(),
        },
        "content": {
        },
        "strategy": strategy,
    }
    images = [ ]
    if cpnx_file is not None:
        content = measure(cpnx_file)
        hololink["content"][cpnx_file] = measure(cpnx_file)
        images.append({
            "content": cpnx_file,
            "context": "cpnx",
        })
    if clnx_file is not None:
        hololink["content"][clnx_file] = measure(clnx_file)
        images.append({
            "content": clnx_file,
            "context": "clnx",
        })
    if stratix_file is not None:
        hololink["content"][stratix_file] = measure(stratix_file)
        images.append({
            "content": stratix_file,
            "context": "stratix",
        })
    hololink["images"] = images
    # Write the metadata to the manifest file
    manifest = {
        "hololink": hololink,
    }
    with open(args.manifest, "wt") as f:
        f.write(yaml.dump(manifest, default_flow_style=False))

if __name__ == "__main__":
    main()
