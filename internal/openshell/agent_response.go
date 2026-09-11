// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"encoding/json/v2"
	"errors"
	"strings"
	"time"
	"uuid"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// AgentResponse verifies the agent process and its OpenShell inference route,
// beyond the direct inference request used by InferenceReady.
func AgentResponse(ctx context.Context, c Client, workspace, sandbox, agent string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()
	r, err := c.Exec().Run(ctx, workspace, sandbox, []string{"openclaw", "agent", "--agent", agent, "--session-id", uuid.NewV4().String(), "--message", "Reply with the word FOUR.", "--thinking", "off", "--json", "--timeout", "300"}, v1.ExecOptions{})
	if err != nil || r.ExitCode != 0 {
		return "", errors.New("actual agent response failed; configuration, identities, and data retained")
	}
	text, err := responseText(r.Stdout)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(strings.Trim(text, " \n\r\t.!\"'"), "FOUR") {
		return "", errors.New("agent did not answer the inference probe; resources retained")
	}
	return text, nil
}

func responseText(b []byte) (string, error) {
	var r struct {
		Status string `json:"status"`
		Result struct {
			Payloads []struct {
				Text    string `json:"text"`
				IsError bool   `json:"isError"`
			} `json:"payloads"`
		} `json:"result"`
	}
	if len(b) > 1<<20 || json.Unmarshal(b, &r) != nil || r.Status != "ok" || len(r.Result.Payloads) == 0 {
		return "", errors.New("agent returned no confirmed response")
	}
	for _, p := range r.Result.Payloads {
		if p.IsError {
			return "", errors.New("agent response reports an inference error")
		}
	}
	text := strings.TrimSpace(r.Result.Payloads[0].Text)
	if text == "" || len(text) > 16<<10 {
		return "", errors.New("agent response is empty or exceeds the probe limit")
	}
	return text, nil
}
