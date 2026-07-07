# LLM Relay

A lightweight, self-hosted, OpenAI-compatible gateway for any OpenAI-style LLM API.

Point it at Nvidia NIM, Groq, OpenRouter, DeepSeek, a local vLLM server, or any other provider that speaks the OpenAI chat completions format — then point your apps at the relay. One URL, one key you control, consistent behavior everywhere.

## Why

Calling LLM providers directly from client-side apps has recurring problems:

- **CORS.** Most provider APIs don't send CORS headers, so browser-based frontends can't call them directly.
- **Key exposure.** Putting a provider API key in a frontend means anyone can extract it. The relay keeps the real key server-side; clients authenticate with keys you issue and can revoke.
- **Reasoning models.** Models like DeepSeek-R1 return their chain of thought in a separate `reasoning_content` field that many frontends don't understand, producing blank or broken responses. The relay can hide it, render it inline, or pass it through — your choice.
- **No control plane.** Direct calls give you no rate limiting, no usage stats, no model restrictions, no retry logic. The relay adds all of these in ~300 lines you can actually read.

## Features

- OpenAI-compatible `/v1/chat/completions` and `/v1/models` (streaming and non-streaming)
- Works with any OpenAI-style upstream via one env var
- Client API keys (multiple, comma-separated) independent of the upstream key
- Three reasoning modes: `hide`, `show` (wrapped in `<think>` tags), `passthrough`
- Per-key sliding-window rate limiting
- Automatic retries with exponential backoff on transient upstream failures (429/502/503/504)
- Model allowlist and forced model override
- `/stats` endpoint with request counts per model
- Structured JSON logs that never include message content
- OpenAI-shaped error objects, so client SDKs handle failures gracefully
- Zero database, two dependencies (`express`, `cors`), deploys anywhere Node 18+ runs

## Quick start

### Local

```bash
git clone <your-repo-url>
cd llm-relay
npm install
UPSTREAM_API_KEY=your-provider-key PROXY_KEYS=choose-a-secret npm start
```

Test it:

```bash
curl http://localhost:3000/health
```

### Render (your only option if you are jobless)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service → connect the repo**.
3. Build command: `npm install` · Start command: `npm start`.
4. Add environment variables (at minimum `UPSTREAM_API_KEY` and `PROXY_KEYS`).
5. Your gateway is live at `https://<your-app>.onrender.com`.

Note: Render's free tier sleeps after 15 minutes of inactivity. The first request after idle takes ~50 seconds while the instance cold-starts. This is normal.

### Railway / Fly / anywhere

Any platform that runs `npm start` with env vars works. No build step, no database, no volumes.

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|---|---|---|
| `UPSTREAM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Base URL of the OpenAI-compatible provider |
| `UPSTREAM_API_KEY` | — | Your provider API key (required) |
| `PROXY_KEYS` | — | Comma-separated client keys. If unset, the gateway is **open to anyone** — set this in production |
| `REASONING_MODE` | `hide` | `hide` strips reasoning tokens, `show` renders them inline wrapped in `<think>` tags, `passthrough` forwards the raw `reasoning_content` field |
| `MODEL_OVERRIDE` | — | Force every request to use this model, ignoring what the client asked for |
| `MODEL_ALLOWLIST` | — | Comma-separated model IDs. Requests for other models get a 403 |
| `RATE_LIMIT_PER_MIN` | `0` (off) | Max requests per minute per client key |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `MAX_RETRIES` | `2` | Retry attempts on transient upstream errors |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins. Default allows all |
| `BODY_LIMIT` | `50mb` | Max request body size |
| `PORT` | `3000` | Listen port (hosting platforms set this automatically) |

### Example upstream configurations

| Provider | `UPSTREAM_BASE_URL` |
|---|---|
| Nvidia NIM | `https://integrate.api.nvidia.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Local vLLM / Ollama | `http://localhost:8000/v1` |

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness check with uptime |
| GET | `/stats` | key | Request counts, error counts, per-model usage |
| GET | `/v1/models` | key | Proxied model list from the upstream |
| POST | `/v1/chat/completions` | key | Proxied chat completions, streaming or not |

## Usage examples

### curl

```bash
curl https://your-relay.example.com/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-ai/deepseek-r1",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-relay.example.com/v1",
    api_key="your-proxy-key",
)

response = client.chat.completions.create(
    model="deepseek-ai/deepseek-r1",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

### Any OpenAI-compatible frontend

Set the API base URL to `https://your-relay.example.com/v1/chat/completions` (or `/v1` depending on how the app expects it), the API key to one of your `PROXY_KEYS`, and the model to any ID the upstream supports.

## Reasoning modes explained

Reasoning models emit two text channels: the visible answer (`content`) and the chain of thought (`reasoning_content`). Clients unaware of the second field may show nothing while the model "thinks."

- **`hide`** — reasoning tokens are silently dropped. The client only ever sees the final answer. Safest default.
- **`show`** — reasoning is converted into visible text wrapped in `<think>...</think>` tags, streamed live. Useful for debugging or clients that render think-tags specially.
- **`passthrough`** — the raw field is forwarded untouched, for clients that natively support `reasoning_content`.

## Security notes

- Always set `PROXY_KEYS` on a public deployment. Without it, anyone who finds your URL can spend your upstream quota.
- To revoke a client, remove their key from `PROXY_KEYS` and redeploy.
- The relay logs method, path, model, status, and latency — never message content.
- Restrict `ALLOWED_ORIGINS` to your app's domain if only browsers should call the gateway.

## Troubleshooting

**401 from the gateway** — your client key doesn't match any entry in `PROXY_KEYS`. Check for whitespace.

**401/403 passed through from upstream** — your `UPSTREAM_API_KEY` is wrong or expired.

**First request after idle is very slow** — free hosting tiers cold-start. Wait it out or upgrade.

**413 Payload Too Large** — raise `BODY_LIMIT`.

**Responses cut off mid-stream** — usually the upstream generating slowly, not the relay. Try a non-streaming request to compare.

**Model errors** — model IDs must exactly match what the upstream expects. Hit `/v1/models` to list valid IDs.

## License

MIT

Veer Rabari
