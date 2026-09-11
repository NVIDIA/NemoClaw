// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package spark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/snapshot"
)

func testService() Service {
	m := ModelManifest()
	s := Service{Backend: Backend, Image: "test@sha256:" + strings.Repeat("a", 64), Model: Model{Repository: m.Repository, Revision: m.Revision}}
	s.Defaults()
	return s
}

func TestCapacityRejectsSafelyBeforeAllocations(t *testing.T) {
	s := testService()
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	c := Capacity{Architecture: "arm64", GPU: "NVIDIA GB10", DriverMajor: 580, Total: 121 * GiB, Available: 116 * GiB, Free: 110 * GiB, DiskFree: 200 * GiB}
	if err := s.CheckCapacity(c, true, ModelManifest().Bytes(), PreparedBytes); err != nil {
		t.Fatal(err)
	}
	c.Free = GiB
	if err := s.CheckCapacity(c, true, 0, PreparedBytes); err != nil {
		t.Fatal("reclaimable model page cache prevented safe startup", err)
	}
	for _, dimension := range []string{"memory", "disk", "gpu", "architecture", "driver", "gpu busy", "reserve"} {
		t.Run(dimension, func(t *testing.T) {
			bad, spec := c, s
			switch dimension {
			case "memory":
				bad.Available = 60 * GiB
			case "disk":
				bad.DiskFree = 40 * GiB
			case "gpu":
				bad.GPU = "unknown"
			case "architecture":
				bad.Architecture = "amd64"
			case "driver":
				bad.DriverMajor = 570
			case "gpu busy":
				bad.ForeignGPUProcesses = 1
			case "reserve":
				spec.Memory.HostReserveGiB = 64
			}
			if err := spec.CheckCapacity(bad, true, ModelManifest().Bytes(), PreparedBytes); err == nil {
				t.Fatal("unsafe capacity accepted")
			}
		})
	}
	c.Available = 20 * GiB
	if err := s.CheckCapacity(c, false, 0, 0); err != nil {
		t.Fatal("unchanged running service rejected its own allocations", err)
	}
}

func TestWatchdogNeedsConsecutivePressureAndResetsAfterRecovery(t *testing.T) {
	w := Watchdog{Policy: testService().Memory}
	for range 4 {
		if w.Sample(7*GiB, 4*GiB) {
			t.Fatal("stopped before threshold")
		}
	}
	if w.Sample(20*GiB, GiB) {
		t.Fatal("evictable page cache caused shutdown")
	}
	for range 4 {
		if w.Sample(11*GiB, 2*GiB) {
			t.Fatal("counter did not reset")
		}
	}
	if !w.Sample(11*GiB, 2*GiB) {
		t.Fatal("sustained low free memory did not trip")
	}
}

func TestPreparationRecoversInterruptedPublishAndSkipsVerifiedArtifact(t *testing.T) {
	root := t.TempDir()
	staging := filepath.Join(root, PreparationKey()+".preparing")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	// A crash after upstream binary rename but before metadata is recoverable.
	if err := os.WriteFile(filepath.Join(staging, PreparedFile), []byte("incomplete"), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	run := func(ctx context.Context, verify bool, model, dir string) ([]byte, error) {
		calls++
		if !verify {
			if _, err := os.Stat(filepath.Join(dir, PreparedFile)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("upstream would skip unpublished output")
			}
			if err := os.WriteFile(filepath.Join(dir, PreparedFile), []byte("packed"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, PreparedFile+".json"), []byte(`{"verified":"fixture"}`), 0600); err != nil {
				t.Fatal(err)
			}
			return nil, nil
		}
		h := sha256.Sum256([]byte("packed"))
		return json.Marshal(snapshot.File{Name: PreparedFile, Size: 6, SHA256: hex.EncodeToString(h[:])})
	}
	p, err := Prepare(t.Context(), root, "model", run)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ObservePreparation(filepath.Join(root, PreparationKey())); err != nil {
		t.Fatal(err)
	}
	q, err := Prepare(t.Context(), root, "model", run)
	if err != nil || p.Key != q.Key || calls != 2 {
		t.Fatal("verified preparation was rerun", err, calls)
	}
	if err := os.WriteFile(filepath.Join(root, PreparationKey(), PreparedFile), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Prepare(t.Context(), root, "model", run); err == nil || calls != 2 {
		t.Fatal("corrupt established data overwritten")
	}
}

func TestPreparationFailureDoesNotPublishOrEraseStagedData(t *testing.T) {
	for _, verify := range []bool{false, true} {
		t.Run(map[bool]string{false: "preparer", true: "verifier"}[verify], func(t *testing.T) {
			root := t.TempDir()
			_, err := Prepare(t.Context(), root, "model", func(ctx context.Context, v bool, model, dir string) ([]byte, error) {
				if err := os.WriteFile(filepath.Join(dir, "retained.tmp"), []byte("progress"), 0600); err != nil {
					t.Fatal(err)
				}
				if v == verify {
					return nil, errors.New("interruption")
				}
				return nil, nil
			})
			if err == nil {
				t.Fatal("accepted failed preparation")
			}
			if _, err := os.Stat(filepath.Join(root, PreparationKey())); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("published partial preparation")
			}
			if _, err := os.Stat(filepath.Join(root, PreparationKey()+".preparing", "retained.tmp")); err != nil {
				t.Fatal("lost progress")
			}
		})
	}
}

func TestPartialHostMemoryObservationIsAnError(t *testing.T) {
	if _, err := ReadMemory(strings.NewReader("MemTotal: 120 kB\nMemFree: 20 kB\n")); err == nil {
		t.Fatal("partial host inventory accepted")
	}
	if _, err := ReadMemory(strings.NewReader("MemTotal: 120 kB\nMemAvailable: 100 kB\nMemFree: 20 kB\n")); err != nil {
		t.Fatal(err)
	}
}
