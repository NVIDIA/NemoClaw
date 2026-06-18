# Holoscan Sensor Bridge platform mapping

This file is the quick reference used by the skill.

## Supported host platforms

- IGX Orin with CX7 SmartNIC
- AGX Orin with onboard Ethernet and Linux sockets path
- AGX Thor with MGBE SmartNIC and CoE transport
- DGX Spark with CX7 SmartNIC

## Build mode selection

- `--dgpu`: only for **IGX Orin with a discrete GPU and OS configured as dGPU**
- `--igpu`: for **all other supported configurations**
  - IGX Orin iGPU
  - AGX Orin
  - AGX Thor
  - DGX Spark

## Default board IPs

- Port 0: `192.168.0.2`
- Port 1: `192.168.0.3`

## Default host IPs used in examples and setup

- Host port connected to board port 0: `192.168.0.101/24`
- Optional second host port for stereo: `192.168.0.102/24`

## Host-network summary by platform

### IGX Orin

- Discover CX7 Infiniband device name from `/sys/class/infiniband`
- Map that to Ethernet netdev
- Use NetworkManager
- Configure:
  - static IP `192.168.0.101/24`
  - route `192.168.0.2/32`
  - RX ring `4096`

### AGX Orin

- Use onboard Ethernet, commonly `eno1` on the documented JP6.2.1 setup
- Use NetworkManager
- Increase `net.core.rmem_max`
- Configure static IP `192.168.0.101/24`

### DGX Spark

Same general approach as IGX — see [references/phase-details.md](../references/phase-details.md) for the full DGX Spark setup steps.

### AGX Thor

- Use `--igpu` build mode
- Follow repo or doc guidance for MGBE interface naming
- Socket examples may benefit from increased receive buffers
- Do not hardcode `eno1` unless the local system confirms it
- Supports **native CLI builds** outside the container (Phase 2b):
  - Requires CUDA 13.0, Holoscan SDK 3.9.0, cmake, and build libraries
  - `cmake -DHOLOLINK_BUILD_PYTHON=OFF .. && make -j hololink-enumerate` for enumerate only
  - `cmake -DHOLOLINK_BUILD_SIPL=1 -DHOLOLINK_BUILD_FUSA=1 .. && make -j` for all CoE examples
  - Native binary at `build/tools/enumerate/hololink-enumerate`
  - Native and containerized enumerate share the same UDP port — cannot run simultaneously

## Container startup notes

- Start from a GUI terminal when visualizer access is needed
- `xhost +` or preferably `xhost +local:docker` before `sh docker/demo.sh`
- On iGPU platforms, a message about failing to detect the NVIDIA driver version can be expected and ignored during container start

## Connectivity interpretation

- `ping 192.168.0.2` success means the control-plane IP path is up
- It does **not** guarantee enumeration or data-plane correctness
- If ping succeeds but `hololink enumerate` shows nothing, suspect firmware mismatch, cable placement, or board/app compatibility
