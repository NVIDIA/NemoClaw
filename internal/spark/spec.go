// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package spark

import (
	"errors"
	"fmt"
	"regexp"
)

const GiB int64 = 1 << 30
const ModelName = "qwen3.8-flash-next"

// Service is the qualified backend contract. There are no shell hooks or extra
// argv/env fields: every serving option has a bounded compatibility check.
type Service struct {
	Backend string  `yaml:"backend" json:"backend"`
	Image   string  `yaml:"image" json:"image"`
	Model   Model   `yaml:"model" json:"model"`
	Serving Serving `yaml:"serving" json:"serving"`
	Memory  Memory  `yaml:"memory" json:"memory"`
}
type Model struct {
	Repository string `yaml:"repository" json:"repository"`
	Revision   string `yaml:"revision" json:"revision"`
}
type Serving struct {
	Port                  int `yaml:"port" json:"port"`
	ContextTokens         int `yaml:"contextTokens" json:"contextTokens"`
	MaxSequences          int `yaml:"maxSequences" json:"maxSequences"`
	BatchTokens           int `yaml:"batchTokens" json:"batchTokens"`
	SpeculativeTokens     int `yaml:"speculativeTokens" json:"speculativeTokens"`
	StartupTimeoutSeconds int `yaml:"startupTimeoutSeconds" json:"startupTimeoutSeconds"`
}
type Memory struct {
	HostReserveGiB     int `yaml:"hostReserveGiB" json:"hostReserveGiB"`
	KVCacheGiB         int `yaml:"kvCacheGiB" json:"kvCacheGiB"`
	MinAvailableGiB    int `yaml:"minAvailableGiB" json:"minAvailableGiB"`
	MinFreeGiB         int `yaml:"minFreeGiB" json:"minFreeGiB"`
	FreeGateGiB        int `yaml:"freeGateGiB" json:"freeGateGiB"`
	ConsecutiveSamples int `yaml:"consecutiveSamples" json:"consecutiveSamples"`
}

func (s *Service) Defaults() {
	if s.Serving.Port == 0 {
		s.Serving.Port = 18888
	}
	if s.Serving.ContextTokens == 0 {
		s.Serving.ContextTokens = 32768
	}
	if s.Serving.MaxSequences == 0 {
		s.Serving.MaxSequences = 1
	}
	if s.Serving.BatchTokens == 0 {
		s.Serving.BatchTokens = 1024
	}
	if s.Serving.StartupTimeoutSeconds == 0 {
		s.Serving.StartupTimeoutSeconds = 1800
	}
	if s.Memory.HostReserveGiB == 0 {
		s.Memory.HostReserveGiB = 32
	}
	if s.Memory.KVCacheGiB == 0 {
		s.Memory.KVCacheGiB = 8
	}
	if s.Memory.MinAvailableGiB == 0 {
		s.Memory.MinAvailableGiB = 8
	}
	if s.Memory.MinFreeGiB == 0 {
		s.Memory.MinFreeGiB = 3
	}
	if s.Memory.FreeGateGiB == 0 {
		s.Memory.FreeGateGiB = 12
	}
	if s.Memory.ConsecutiveSamples == 0 {
		s.Memory.ConsecutiveSamples = 5
	}
}

var pinnedImage = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`)

func (s Service) Validate() error {
	m := ModelManifest()
	if s.Backend != Backend || s.Model.Repository != m.Repository || s.Model.Revision != m.Revision || !pinnedImage.MatchString(s.Image) {
		return errors.New("Spark service requires the qualified backend, pinned recipe model, and immutable runtime image")
	}
	v := s.Serving
	if v.Port < 1024 || v.Port > 65535 || v.ContextTokens < 8192 || v.ContextTokens > 65536 || v.MaxSequences < 1 || v.MaxSequences > 2 || v.BatchTokens < 512 || v.BatchTokens > 2048 || v.SpeculativeTokens < 0 || v.SpeculativeTokens > 3 || v.StartupTimeoutSeconds < 900 || v.StartupTimeoutSeconds > 3600 {
		return errors.New("serving settings exceed the qualified Spark profile; loading requires at least 15 minutes")
	}
	w := s.Memory
	if w.HostReserveGiB < 28 || w.HostReserveGiB > 64 || w.KVCacheGiB < 4 || w.KVCacheGiB > 12 || w.MinAvailableGiB < 6 || w.MinAvailableGiB > 16 || w.MinFreeGiB < 2 || w.MinFreeGiB > 8 || w.FreeGateGiB < w.MinAvailableGiB || w.FreeGateGiB > 24 || w.ConsecutiveSamples < 1 || w.ConsecutiveSamples > 5 {
		return errors.New("memory protection exceeds the qualified Spark safety bounds")
	}
	return nil
}

// GPUBytes separates resident GPU allocations from the evictable PLE table.
// These constants describe only the pinned model/runtime, not arbitrary vLLM.
func (s Service) GPUBytes() int64 {
	budget := int64(77.5*float64(GiB)) + int64(s.Memory.KVCacheGiB)*GiB
	if s.Serving.SpeculativeTokens > 0 {
		budget += 2 * GiB
	}
	return budget
}

type Capacity struct {
	Architecture                     string
	GPU                              string
	DriverMajor                      int
	Total, Available, Free, DiskFree int64
	ForeignGPUProcesses              int
}

func (s Service) CheckCapacity(c Capacity, starting bool, downloadRemaining, preparationRemaining int64) error {
	if c.Architecture != "arm64" || c.GPU != "NVIDIA GB10" || c.DriverMajor < 580 || c.Total < 118*GiB {
		return errors.New("backend requires ARM64 GB10 Spark with at least 118 GiB RAM and NVIDIA driver 580 or newer")
	}
	if c.DiskFree < downloadRemaining+preparationRemaining+16*GiB {
		return errors.New("insufficient disk for remaining pinned model, packed PLE, and 16 GiB working reserve")
	}
	if starting && c.ForeignGPUProcesses != 0 {
		return errors.New("GPU is in use by an unrelated process; service was not started")
	}
	if s.GPUBytes()+int64(s.Memory.HostReserveGiB)*GiB > c.Total {
		return errors.New("requested GPU budget leaves less than the declared host memory reserve")
	}
	if starting && (c.Available < s.GPUBytes()+20*GiB || c.Free < int64(s.Memory.MinFreeGiB)*GiB) {
		return fmt.Errorf("insufficient startup memory headroom: available %.1f GiB, require %.1f GiB", float64(c.Available)/float64(GiB), float64(s.GPUBytes()+20*GiB)/float64(GiB))
	}
	return nil
}

type Watchdog struct {
	Policy     Memory
	LowSamples int
}

func (w *Watchdog) Sample(available, free int64) bool {
	low := available < int64(w.Policy.MinAvailableGiB)*GiB || (free < int64(w.Policy.MinFreeGiB)*GiB && available < int64(w.Policy.FreeGateGiB)*GiB)
	if low {
		w.LowSamples++
	} else {
		w.LowSamples = 0
	}
	return w.LowSamples >= w.Policy.ConsecutiveSamples
}
