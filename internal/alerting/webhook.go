package alerting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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
	body, err := FormatPayload(target.ChannelType, payload)
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

func FormatPayload(channel string, payload Payload) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(channel)) {
	case "wecom":
		return FormatWeCom(payload)
	case "feishu":
		return FormatFeishu(payload)
	case "dingtalk":
		return FormatDingTalk(payload)
	case "slack":
		return FormatSlack(payload)
	default:
		return json.Marshal(payload)
	}
}

func FormatWeCom(payload Payload) ([]byte, error) {
	var buf strings.Builder
	statusText := "告警触发 (FIRING)"
	if payload.Status == "resolved" {
		statusText = "告警恢复 (RESOLVED)"
	}
	buf.WriteString(fmt.Sprintf("### %s\n", statusText))
	for _, a := range payload.Alerts {
		buf.WriteString(fmt.Sprintf("> **规则**: %s\n", a.Labels["alertname"]))
		buf.WriteString(fmt.Sprintf("> **集群**: %s\n", a.Labels["cluster"]))
		if v, ok := a.Annotations["value"]; ok {
			buf.WriteString(fmt.Sprintf("> **数值**: %s\n", v))
		}
		buf.WriteString(fmt.Sprintf("> **开始时间**: %s\n", a.StartsAt.Format(time.RFC3339)))
		if a.EndsAt != nil {
			buf.WriteString(fmt.Sprintf("> **恢复时间**: %s\n", a.EndsAt.Format(time.RFC3339)))
		}
	}
	return json.Marshal(map[string]any{
		"msgtype": "markdown",
		"markdown": map[string]string{
			"content": buf.String(),
		},
	})
}

func FormatFeishu(payload Payload) ([]byte, error) {
	title := "【ClickHouse 告警】" + payload.GroupLabels["alertname"]
	template := "red"
	if payload.Status == "resolved" {
		template = "green"
	}
	var content strings.Builder
	content.WriteString(fmt.Sprintf("**状态**: %s\n**集群**: %s\n", payload.Status, payload.GroupLabels["cluster"]))
	for _, a := range payload.Alerts {
		if v, ok := a.Annotations["value"]; ok {
			content.WriteString(fmt.Sprintf("**数值**: %s\n", v))
		}
		content.WriteString(fmt.Sprintf("**开始时间**: %s\n", a.StartsAt.Format(time.RFC3339)))
		if a.EndsAt != nil {
			content.WriteString(fmt.Sprintf("**恢复时间**: %s\n", a.EndsAt.Format(time.RFC3339)))
		}
	}
	return json.Marshal(map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"header": map[string]any{
				"title":    map[string]string{"tag": "plain_text", "content": title},
				"template": template,
			},
			"elements": []any{
				map[string]any{
					"tag":  "div",
					"text": map[string]string{"tag": "lark_md", "content": content.String()},
				},
			},
		},
	})
}

func FormatDingTalk(payload Payload) ([]byte, error) {
	title := "【ClickHouse 告警】" + payload.GroupLabels["alertname"]
	var text strings.Builder
	text.WriteString(fmt.Sprintf("### %s\n", title))
	text.WriteString(fmt.Sprintf("- **状态**: %s\n- **集群**: %s\n", payload.Status, payload.GroupLabels["cluster"]))
	for _, a := range payload.Alerts {
		if v, ok := a.Annotations["value"]; ok {
			text.WriteString(fmt.Sprintf("- **数值**: %s\n", v))
		}
		text.WriteString(fmt.Sprintf("- **开始时间**: %s\n", a.StartsAt.Format(time.RFC3339)))
		if a.EndsAt != nil {
			text.WriteString(fmt.Sprintf("- **恢复时间**: %s\n", a.EndsAt.Format(time.RFC3339)))
		}
	}
	return json.Marshal(map[string]any{
		"msgtype": "markdown",
		"markdown": map[string]string{
			"title": title,
			"text":  text.String(),
		},
	})
}

func FormatSlack(payload Payload) ([]byte, error) {
	color := "danger"
	if payload.Status == "resolved" {
		color = "good"
	}
	ruleName := payload.GroupLabels["alertname"]
	fields := []map[string]any{
		{"title": "状态", "value": payload.Status, "short": true},
		{"title": "集群", "value": payload.GroupLabels["cluster"], "short": true},
	}
	for _, a := range payload.Alerts {
		if v, ok := a.Annotations["value"]; ok {
			fields = append(fields, map[string]any{"title": "数值", "value": v, "short": true})
		}
		fields = append(fields, map[string]any{"title": "开始时间", "value": a.StartsAt.Format(time.RFC3339), "short": true})
		if a.EndsAt != nil {
			fields = append(fields, map[string]any{"title": "恢复时间", "value": a.EndsAt.Format(time.RFC3339), "short": true})
		}
	}
	return json.Marshal(map[string]any{
		"text": fmt.Sprintf("[%s] %s", payload.Status, ruleName),
		"attachments": []any{
			map[string]any{
				"color":  color,
				"title":  ruleName,
				"fields": fields,
			},
		},
	})
}
