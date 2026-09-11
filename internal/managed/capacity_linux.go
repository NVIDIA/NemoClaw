// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/spark"
	"github.com/containerd/errdefs"
	"github.com/moby/moby/client"
	"golang.org/x/sys/unix"
)

func (d *Docker) Capacity(ctx context.Context, s Spec, o *Observation) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return errors.New("host memory is unobservable")
	}
	c, err := spark.ReadMemory(f)
	f.Close()
	if err != nil {
		return err
	}
	c.Architecture = runtime.GOARCH
	b, err := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return errors.New("GPU and driver observation failed")
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 1 {
		return errors.New("Spark backend requires exactly one observable GPU")
	}
	fields := strings.Split(lines[0], ",")
	if len(fields) != 2 {
		return errors.New("GPU inventory is incomplete")
	}
	c.GPU = strings.TrimSpace(fields[0])
	major, _, _ := strings.Cut(strings.TrimSpace(fields[1]), ".")
	c.DriverMajor, err = strconv.Atoi(major)
	if err != nil {
		return errors.New("driver version is unobservable")
	}
	b, err = exec.CommandContext(ctx, "nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return errors.New("GPU process inventory failed")
	}
	if text := strings.TrimSpace(string(b)); text != "" {
		c.ForeignGPUProcesses = len(strings.Split(text, "\n"))
	}
	info, err := d.API.Info(ctx, client.InfoOptions{})
	if err != nil {
		return errors.New("Docker storage capacity observation failed")
	}
	if info.Info.OSType != "linux" || (info.Info.Architecture != "aarch64" && info.Info.Architecture != "arm64") {
		return errors.New("Spark backend requires the local Linux ARM64 engine")
	}
	var fs unix.Statfs_t
	if err = unix.Statfs(info.Info.DockerRootDir, &fs); err != nil {
		return errors.New("Docker storage capacity is unobservable")
	}
	c.DiskFree = int64(fs.Bavail) * fs.Bsize
	remaining := spark.ModelManifest().Bytes()
	preparing := spark.PreparedBytes
	if o != nil {
		for _, f := range spark.ModelManifest().Files {
			base := "/data/models/" + s.Service.Model.Revision + "/" + f.Name
			for _, suffix := range []string{"", ".nemoclaw-partial"} {
				st, e := d.API.ContainerStatPath(ctx, o.ContainerID, client.ContainerStatPathOptions{Path: base + suffix})
				if errdefs.IsNotFound(e) {
					continue
				}
				if e != nil || !st.Stat.Mode.IsRegular() || st.Stat.Size < 0 || st.Stat.Size > f.Size {
					return errors.New("retained download progress is unobservable or corrupt")
				}
				remaining -= st.Stat.Size
				break
			}
		}
		st, e := d.API.ContainerStatPath(ctx, o.ContainerID, client.ContainerStatPathOptions{Path: "/data/prepared/" + spark.PreparationKey() + "/" + spark.PreparedFile})
		if e == nil && st.Stat.Mode.IsRegular() && st.Stat.Size > 0 && st.Stat.Size <= spark.PreparedBytes {
			preparing -= st.Stat.Size
		} else if e != nil && !errdefs.IsNotFound(e) {
			return errors.New("prepared storage capacity observation failed")
		}
	}
	return s.Service.CheckCapacity(c, o == nil || !o.Running, remaining, preparing)
}
