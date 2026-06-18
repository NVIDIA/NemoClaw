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

# See README.md for detailed information.

import argparse
import datetime
import hashlib
import json
import tempfile
import yaml

import requests

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--org",
        default="nvidia",
        help="NGC 'org' with project files.",
    )
    parser.add_argument(
        "--team",
        default="clara-holoscan",
        help="NGC 'team' with project files.",
    )
    parser.add_argument(
        "--project",
        default="holoscan_sensor_bridge_fpga_ip",
        help="NGC resource with project files.",
    )
    parser.add_argument(
        "--version",
        required=True,
        help="Componoent version (e.g. \"2402\")",
    )
    parser.add_argument(
        "--manifest",
        default="manifest.yaml",
        help="Manifest file to write with programming data.",
    )
    parser.add_argument(
        "--strategy",
        default="sensor_bridge_10",
        help="Specify the strategy to use with this manifest.",
    )
    args = parser.parse_args()
    # ...
    org = args.org
    team = args.team
    project = args.project
    version = args.version
    utc = datetime.timezone.utc
    now = datetime.datetime.now(utc)
    #
    files_url = f"https://api.ngc.nvidia.com/v2/resources/org/{org}/team/{team}/{project}/{version}/files"
    files_request = requests.get(
        files_url,
        headers={
            "Content-Type": "application/json",
        },
    )
    if files_request.status_code != requests.codes.ok:
        raise Exception(f"Unable to fetch \"{files_url}\"; status={files_request.status_code}")
    files_response = json.loads(files_request.content)
    #
    hololink = {
        "archive": {
            "version": version,
            "enrollment_date": now.isoformat(),
        },
        "content": {
        },
        "images": [
        ],
        "strategy": args.strategy,
    }
    for name in files_response["filepath"]:
        print(f"Fetching {name}.")
        content_url = f"https://api.ngc.nvidia.com/v2/resources/org/{org}/team/{team}/{project}/{version}/files?redirect=true&path={name}"
        content_request = requests.get(
            content_url,
            headers={
                "Content-Type": "binary/octet-stream",
            },
        )
        if content_request.status_code != requests.codes.ok:
            raise Exception(f"Unable to fetch \"{content_url}\"; status={content_request.status_code}")
        #
        content = content_request.content
        md5 = hashlib.md5(content)
        image = {
            "size": len(content),
            "md5": md5.hexdigest(),
            "url": content_url,
        }
        if name in hololink["content"]:
            raise Exception(f"{name} is already in the content; all content names must be unique.")
        hololink["content"][name] = image
        if "cpnx" in name:
            hololink["images"].append({
                "context": "cpnx",
                "content": name,
            })
            continue
        if "clnx" in name:
            hololink["images"].append({
                "context": "clnx",
                "content": name,
            })
            continue
        if "LICENSE" in name.upper():
            licenses = hololink.setdefault("licenses", [])
            licenses.append(name)
            continue
    assert len(hololink["images"]) > 0
    # Write the metadata to the manifest file
    manifest = {
        "hololink": hololink,
    }
    with open(args.manifest, "wt") as f:
        f.write(yaml.dump(manifest, default_flow_style=False))

if __name__ == "__main__":
    main()
