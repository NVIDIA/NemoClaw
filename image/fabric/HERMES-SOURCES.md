<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Native Image Library Sources

The Hermes image retains these original source archives under `/opt/nemoclaw/source/hermes/`:

- `hermes-pillow-heif-source.tar.gz`: Pillow-HEIF 1.8.1, including its native extension and library build helper.
- `hermes-libheif-source.tar.gz`: libheif 1.23.6, LGPLv3.
- `hermes-libde265-source.tar.gz`: libde265 1.1.3, LGPLv3.
- `hermes-x265-source.tar.gz`: x265 4.3, GPLv2.

The library versions and release URLs match Pillow-HEIF's retained `libheif/build_libs.py` and the installed wheel's `LICENSES_bundled.txt`.
The wheel describes its combined binary distribution as GPLv2; its BSD package metadata alone does not describe the bundled libraries.
The image preserves the wheel's existing notices and the archives' original licenses.
`versions.json` pins the archive URLs and SHA-256 values.

Copy all four archives into an empty working directory.
Extract Pillow-HEIF, then use its unmodified helper with the retained library archives:

```sh
mkdir pillow-heif-source
tar -xzf hermes-pillow-heif-source.tar.gz -C pillow-heif-source --strip-components=1
export INSTALL_DIR_LIBS="$PWD/native-prefix"
export BUILD_DIR="$PWD/native-build"
export PH_LIBHEIF_CMAKE_ARGS="-DWITH_X264=OFF"
python3 - <<'PY'
from pathlib import Path
import importlib.util

root = Path.cwd()
spec = importlib.util.spec_from_file_location("build_libs", root / "pillow-heif-source/libheif/build_libs.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
build.LIBX265_URL = (root / "hermes-x265-source.tar.gz").as_uri()
build.LIBDE265_URL = (root / "hermes-libde265-source.tar.gz").as_uri()
build.LIBHEIF_URL = (root / "hermes-libheif-source.tar.gz").as_uri()
build.build_libs()
PY
LIBHEIF_ROOT="$INSTALL_DIR_LIBS" python3 -m pip wheel --no-deps ./pillow-heif-source
```

Install Python build prerequisites, a C/C++ toolchain, Make, CMake 3.31.6, pkg-config, curl, and NASM on x86 before building.
Run as root inside an isolated Linux build container with a writable prefix; the helper runs `ldconfig` on Linux.
Python build-backend downloads and toolchain prerequisites are separate from the retained library sources.
Rebuilding or replacing the shared libraries can require adjusting the wheel's repaired library names and loader paths.
These inputs do not promise identical Linux wheel bytes or complete source coverage for Hermes's other dependencies; final artifact reconciliation remains in [#13524](https://github.com/NVIDIA/NemoClaw/issues/13524).
