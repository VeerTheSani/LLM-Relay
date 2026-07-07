const express = require("express");
const cors = require("cors");
const { Readable } = require("stream");
const config = require("./config");
const { SlidingWindowLimiter } = require("./lib/ratelimit");
const { transformCompletion, SseRewriter } = require("./lib/reasoning");

const app = express();
const limiter = new SlidingWindowLimiter(config.rateLimitPerMin);
const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  upstreamErrors: 0,
  rateLimited: 0,
  models: {},
};

const corsOptions =
  config.allowedOrigins.length === 0 || config.allowedOrigins.includes("*")
    ? {}
    : { origin: config.allowedOrigins };

app.use(cors(corsOptions));
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ limit: config.bodyLimit, extended: true }));

function clientKey(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function apiError(res, status, message, type, code) {
  return res.status(status).json({ error: { message, type, code: code || null } });
}

function requireAuth(req, res, next) {
  if (config.proxyKeys.length === 0) return next();
  if (config.proxyKeys.includes(clientKey(req))) return next();
  return apiError(res, 401, "Invalid or missing API key.", "authentication_error", "invalid_api_key");
}

function rateLimit(req, res, next) {
  const verdict = limiter.check(clientKey(req) || req.ip);
  if (verdict.allowed) return next();
  stats.rateLimited += 1;
  res.set("Retry-After", String(verdict.retryAfterSeconds));
  return apiError(
    res,
    429,
    `Rate limit of ${config.rateLimitPerMin} requests per minute exceeded. Retry in ${verdict.retryAfterSeconds}s.`,
    "rate_limit_error",
    "rate_limit_exceeded"
  );
}

function logRequest(req, status, model, startedMs) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      model: model || null,
      status,
      ms: Date.now() - startedMs,
    })
  );
}

function upstreamHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.upstreamApiKey}`,
  };
}

async function fetchUpstream(path, init) {
  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(config.upstreamBaseUrl + path, {
        ...init,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      const retryable = [429, 502, 503, 504].includes(response.status);
      if (retryable && attempt < config.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < config.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw lastError || new Error("Upstream request failed after retries");
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
});

app.get("/stats", requireAuth, (req, res) => {
  res.json(stats);
});

app.get("/v1/models", requireAuth, async (req, res) => {
  const started = Date.now();
  try {
    const upstream = await fetchUpstream("/models", { headers: upstreamHeaders() });
    const data = await upstream.json();
    logRequest(req, upstream.status, null, started);
    res.status(upstream.status).json(data);
  } catch (error) {
    stats.upstreamErrors += 1;
    logRequest(req, 502, null, started);
    apiError(res, 502, `Upstream unreachable: ${error.message}`, "upstream_error");
  }
});

app.post("/v1/chat/completions", requireAuth, rateLimit, async (req, res) => {
  const started = Date.now();
  const body = { ...req.body };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError(res, 400, "'messages' must be a non-empty array.", "invalid_request_error", "invalid_messages");
  }

  if (config.modelOverride) body.model = config.modelOverride;

  if (!body.model || typeof body.model !== "string") {
    return apiError(res, 400, "'model' is required.", "invalid_request_error", "missing_model");
  }

  if (config.modelAllowlist.length > 0 && !config.modelAllowlist.includes(body.model)) {
    return apiError(res, 403, `Model '${body.model}' is not allowed on this gateway.`, "invalid_request_error", "model_not_allowed");
  }

  stats.requests += 1;
  stats.models[body.model] = (stats.models[body.model] || 0) + 1;

  let upstream;
  try {
    upstream = await fetchUpstream("/chat/completions", {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(body),
    });
  } catch (error) {
    stats.upstreamErrors += 1;
    logRequest(req, 502, body.model, started);
    return apiError(res, 502, `Upstream unreachable: ${error.message}`, "upstream_error");
  }

  if (!body.stream) {
    let data;
    try {
      data = await upstream.json();
    } catch {
      data = { error: { message: "Upstream returned a non-JSON response.", type: "upstream_error" } };
    }
    if (!upstream.ok) stats.upstreamErrors += 1;
    logRequest(req, upstream.status, body.model, started);
    return res.status(upstream.status).json(transformCompletion(data, config.reasoningMode));
  }

  if (!upstream.ok || !upstream.body) {
    stats.upstreamErrors += 1;
    let detail = null;
    try {
      detail = await upstream.json();
    } catch {}
    logRequest(req, upstream.status, body.model, started);
    if (detail && detail.error) return res.status(upstream.status).json(detail);
    return apiError(res, upstream.status, "Upstream stream failed to start.", "upstream_error");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const rewriter = new SseRewriter(config.reasoningMode);
  const reader = Readable.fromWeb(upstream.body);

  reader.on("data", (chunk) => {
    res.write(rewriter.feed(chunk.toString("utf8")));
  });

  reader.on("end", () => {
    res.write(rewriter.flush());
    res.end();
    logRequest(req, 200, body.model, started);
  });

  reader.on("error", () => {
    stats.upstreamErrors += 1;
    res.end();
    logRequest(req, 500, body.model, started);
  });

  req.on("close", () => reader.destroy());
});

app.use((req, res) => {
  apiError(
    res,
    404,
    `No route for ${req.method} ${req.path}. Available: GET /health, GET /stats, GET /v1/models, POST /v1/chat/completions.`,
    "invalid_request_error",
    "unknown_endpoint"
  );
});

app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      message: "gateway started",
      port: config.port,
      upstream: config.upstreamBaseUrl,
      reasoningMode: config.reasoningMode,
      authEnabled: config.proxyKeys.length > 0,
      rateLimitPerMin: config.rateLimitPerMin || "off",
    })
  );
});
