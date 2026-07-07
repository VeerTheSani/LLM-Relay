function csv(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  port: int(process.env.PORT, 3000),
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  proxyKeys: csv(process.env.PROXY_KEYS),
  reasoningMode: (process.env.REASONING_MODE || "hide").toLowerCase(),
  modelOverride: process.env.MODEL_OVERRIDE || "",
  modelAllowlist: csv(process.env.MODEL_ALLOWLIST),
  rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 0),
  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 120000),
  maxRetries: int(process.env.MAX_RETRIES, 2),
  allowedOrigins: csv(process.env.ALLOWED_ORIGINS),
  bodyLimit: process.env.BODY_LIMIT || "50mb",
};

const VALID_REASONING_MODES = ["hide", "show", "passthrough"];

if (!VALID_REASONING_MODES.includes(config.reasoningMode)) {
  console.error(`Invalid REASONING_MODE "${config.reasoningMode}". Valid values: ${VALID_REASONING_MODES.join(", ")}`);
  process.exit(1);
}

if (!config.upstreamApiKey) {
  console.warn("Warning: UPSTREAM_API_KEY is not set. Upstream requests will fail with 401.");
}

if (config.proxyKeys.length === 0) {
  console.warn("Warning: PROXY_KEYS is not set. The gateway will accept requests from anyone.");
}

module.exports = config;
