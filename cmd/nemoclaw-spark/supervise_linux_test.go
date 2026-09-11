// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/spark"
)

func TestSupervisorFixtureProcess(t *testing.T) {
	if os.Getenv("NEMOCLAW_TEST_SUPERVISOR_CHILD") != "1" {
		return
	}
	time.Sleep(time.Hour)
	os.Exit(0)
}

func TestProtectionStopsTheChildEvenWhenReadinessNeverResponds(t *testing.T) {
	for _, scenario := range []string{"pressure", "failed observation", "operator trip"} {
		t.Run(scenario, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestSupervisorFixtureProcess$")
			cmd.Env = append(os.Environ(), "NEMOCLAW_TEST_SUPERVISOR_CHILD=1")
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill() })
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			samples := make(chan time.Time, 5)
			trip := make(chan os.Signal, 1)
			spec := spark.Service{}
			spec.Defaults()
			m := monitors{samples: samples, health: make(chan bool), trip: trip, observe: func() (spark.Capacity, error) {
				if scenario == "failed observation" {
					return spark.Capacity{}, errors.New("fixture read failed")
				}
				return spark.Capacity{Available: spark.GiB, Free: spark.GiB}, nil
			}, report: func(string, string, int) error { return nil }}
			result := make(chan error, 1)
			go func() { result <- supervise(t.Context(), spec, cmd, done, m) }()
			if scenario == "operator trip" {
				trip <- syscall.SIGUSR1
			} else {
				for range 5 {
					samples <- time.Now()
				}
			}
			select {
			case err := <-result:
				if err == nil || !strings.Contains(err.Error(), "memory protection") || cmd.ProcessState == nil {
					t.Fatal("protection failed to terminate child", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("readiness blocked protection or child shutdown")
			}
		})
	}
}
