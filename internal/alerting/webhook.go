package alerting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Payload struct {
	Version      string            `json:"version"`
	GroupKey     string            `json:"groupKey"`
	Status       string            `json:"status"`
	Receiver     string            `json:"receiver"`
	GroupLabels  map[string]string `json:"groupLabels"`
	CommonLabels map[string]string `json:"commonLabels"`
	Alerts       []PayloadAlert    `json:"alerts"`
}

type PayloadAlert struct {
	Status       string            `json:"status"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	StartsAt     time.Time         `json:"startsAt"`
	EndsAt       *time.Time        `json:"endsAt,omitempty"`
	GeneratorURL string            `json:"generatorURL"`
}

type HTTPSender struct{ client *http.Client }

func NewHTTPSender(timeout time.Duration) *HTTPSender {
	return &HTTPSender{client: &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (s *HTTPSender) Send(ctx context.Context, target WebhookTarget, payload Payload) SendResult {
	body, err := json.Marshal(payload)
	if err != nil {
		return SendResult{Err: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.URL, bytes.NewReader(body))
	if err != nil {
		return SendResult{Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "clickhouse-console-alerting/1.0")
	if target.Authorization != "" {
		req.Header.Set("Authorization", target.Authorization)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return SendResult{Err: err}
	}
	defer resp.Body.Close()
	response, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
	result := SendResult{StatusCode: resp.StatusCode, Body: string(response)}
	if readErr != nil {
		result.Err = readErr
	} else if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.Err = fmt.Errorf("webhook returned HTTP %d", resp.StatusCode)
	}
	return result
}
