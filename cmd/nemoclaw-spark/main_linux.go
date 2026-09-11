// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The Spark supervisor runs as the inference container's PID 1. Its lifetime is
// independent of the CLI. Docker restart=no latches every failure until apply.
package main

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/snapshot"
	"github.com/NVIDIA/NemoClaw/internal/spark"
)

const root = "/data"

type status struct {
	Phase   string    `json:"phase"`
	Detail  string    `json:"detail"`
	Updated time.Time `json:"updated"`
	PID     int       `json:"pid"`
}

func report(phase, detail string, pid int) error {
	fmt.Fprintln(os.Stderr, phase+": "+detail)
	return snapshot.WriteJSON(filepath.Join(root, "status.json"), status{Phase: phase, Detail: detail, Updated: time.Now().UTC(), PID: pid})
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx); err != nil {
		_ = report("stopped", err.Error(), 0)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	var spec spark.Service
	if json.Unmarshal([]byte(os.Getenv("NEMOCLAW_SPARK_SPEC")), &spec) != nil || spec.Validate() != nil {
		return errors.New("invalid pinned Spark service specification")
	}
	lock, err := os.OpenFile(filepath.Join(root, "runtime.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("persistent storage already has a runtime writer")
	}
	m := spark.ModelManifest()
	modelDir := filepath.Join(root, "models", m.Revision)
	if err = report("downloading", "verifying exact model snapshot", 0); err != nil {
		return err
	}
	downloadCtx, cancelDownload := context.WithTimeout(ctx, 8*time.Hour)
	_, err = snapshot.NewClient().Ensure(downloadCtx, modelDir, m, func(file string) { _ = report("downloading", file, 0) })
	cancelDownload()
	if err != nil {
		return err
	}
	if err = report("preparing", "building and verifying packed PLE", 0); err != nil {
		return err
	}
	prepRoot := filepath.Join(root, "prepared")
	_, err = spark.Prepare(ctx, prepRoot, modelDir, func(ctx context.Context, verify bool, model, dir string) ([]byte, error) {
		script := "/opt/nemoclaw/source/recipe/files/build_ple_packed_table.py"
		if verify {
			script = "/opt/nemoclaw/source/verify_packed.py"
		}
		cmd := exec.CommandContext(ctx, "python3", "-u", script, model, dir)
		cmd.Stderr = os.Stderr
		if verify {
			return cmd.Output()
		}
		cmd.Stdout = os.Stderr
		return nil, cmd.Run()
	})
	if err != nil {
		return err
	}
	mem, err := memory()
	if err != nil {
		return err
	}
	if mem.Available < spec.GPUBytes()+20*spark.GiB || spec.GPUBytes()+int64(spec.Memory.HostReserveGiB)*spark.GiB > mem.Total {
		return errors.New("memory headroom changed during preparation; service was not started")
	}
	cmd := exec.Command("python3", spec.Arguments(modelDir, mem.Total)...)
	cmd.Env = append(os.Environ(), "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1", "VLLM_USE_V2_MODEL_RUNNER=1", "VLLM_PLE_CPU_OFFLOAD=1", "VLLM_PLE_OFFLOAD_STEP_TIMEOUT=300", "VLLM_PLE_PACKED_TABLE_DIR="+filepath.Join(prepRoot, spark.PreparationKey()), "VLLM_MTP_DRAFT_VOCAB=/opt/nemoclaw/source/recipe/files/draft_vocab_en_code_47k.txt", "HF_HOME=/data/huggingface", "VLLM_CACHE_ROOT=/data/vllm-cache")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err = cmd.Start(); err != nil {
		return errors.New("inference process could not start")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if err = report("loading", "waiting for inference readiness", cmd.Process.Pid); err != nil {
		terminate(cmd, done)
		return err
	}
	// SIGUSR1 is an explicit operator protection trip. It exercises the same
	// latched shutdown path without allocating memory for qualification.
	trip := make(chan os.Signal, 1)
	signal.Notify(trip, syscall.SIGUSR1)
	defer signal.Stop(trip)
	watch := spark.Watchdog{Policy: spec.Memory}
	deadline := time.Now().Add(time.Duration(spec.Serving.StartupTimeoutSeconds) * time.Second)
	ready := false
	httpClient := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	for {
		select {
		case <-ctx.Done():
			terminate(cmd, done)
			return errors.New("runtime stopped by operator; persistent data retained")
		case <-trip:
			terminate(cmd, done)
			return errors.New("memory protection tripped by operator; explicit apply required")
		case <-done:
			return errors.New("inference process exited; inspect retained container logs and explicitly reapply")
		case <-time.After(time.Second):
			mem, err = memory()
			if err != nil || watch.Sample(mem.Available, mem.Free) {
				terminate(cmd, done)
				return errors.New("host memory protection stopped inference; explicit apply required")
			}
			if !ready {
				if time.Now().After(deadline) {
					terminate(cmd, done)
					return errors.New("inference loading exceeded startup budget; data retained")
				}
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", spec.Serving.Port), nil)
				response, err := httpClient.Do(req)
				if err == nil {
					ready = response.StatusCode == http.StatusOK
					response.Body.Close()
				}
				if ready {
					if err = report("ready", "inference health confirmed", cmd.Process.Pid); err != nil {
						terminate(cmd, done)
						return err
					}
				}
			}
		}
	}
}

func memory() (spark.Capacity, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return spark.Capacity{}, err
	}
	defer f.Close()
	return spark.ReadMemory(f)
}

func terminate(cmd *exec.Cmd, done <-chan error) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
	// Workers can outlive the API process. This process group belongs to this
	// supervisor alone; never select unrelated processes by name.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
