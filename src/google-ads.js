const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_URL = "https://googleads.googleapis.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

let cachedToken;
let cachedTokenExpiresAt = 0;
let pendingToken;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function normalizeCustomerId(value) {
  const id = String(value ?? "").replaceAll("-", "").trim();
  if (!/^\d{10}$/.test(id)) throw new Error("Customer ID must be 10 digits (hyphens are accepted).");
  return id;
}

export function defaultCustomerId() {
  return normalizeCustomerId(required("GOOGLE_ADS_CUSTOMER_ID"));
}

function apiVersion() {
  const version = (process.env.GOOGLE_ADS_API_VERSION || "v25").trim();
  if (!/^v\d+$/.test(version)) throw new Error("GOOGLE_ADS_API_VERSION must look like v25.");
  return version;
}

async function readLimitedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Google response exceeded the 8 MB safety limit. Narrow the query.");
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error("Google returned an invalid JSON response."); }
}

export async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;
  if (pendingToken) return pendingToken;
  pendingToken = (async () => {
    const body = new URLSearchParams({
      client_id: required("GOOGLE_ADS_CLIENT_ID"),
      client_secret: required("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: required("GOOGLE_ADS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await readLimitedJson(response);
    if (!response.ok || typeof data.access_token !== "string" || !data.access_token) {
      throw new Error(`Google OAuth token refresh failed (HTTP ${response.status}). Check the configured OAuth client and refresh token.`);
    }
    cachedToken = data.access_token;
    cachedTokenExpiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    return cachedToken;
  })();
  try { return await pendingToken; }
  finally { pendingToken = undefined; }
}

async function googleAdsFetch(path, { method = "GET", body, customerId } = {}) {
  const accessToken = await getAccessToken();
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const loginId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim();
  if (loginId && customerId) headers["login-customer-id"] = normalizeCustomerId(loginId);
  const response = await fetch(`${ADS_URL}/${apiVersion()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await readLimitedJson(response);
  if (!response.ok) {
    // Google error details can echo requests. Never return them to an MCP caller.
    const code = data?.error?.status;
    const suffix = typeof code === "string" && /^[A-Z_]+$/.test(code) ? `: ${code}` : "";
    throw new Error(`Google Ads API request failed (HTTP ${response.status}${suffix}).`);
  }
  return data;
}

export async function listAccessibleCustomers() {
  const data = await googleAdsFetch("/customers:listAccessibleCustomers");
  return data.resourceNames ?? [];
}

export async function search(customerId, query, maxRows = 1000) {
  const id = normalizeCustomerId(customerId || defaultCustomerId());
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000) throw new Error("Invalid result limit.");
  const data = await googleAdsFetch(`/customers/${id}/googleAds:searchStream`, {
    method: "POST", customerId: id, body: { query },
  });
  const chunks = Array.isArray(data) ? data : [data];
  const results = [];
  for (const chunk of chunks) {
    for (const row of chunk?.results ?? []) {
      if (results.length >= maxRows) throw new Error(`Google returned more than ${maxRows} rows. Narrow the query.`);
      results.push(row);
    }
  }
  return results;
}

function normalizeCampaignId(value) {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Campaign ID must contain digits only.");
  return id;
}

export async function mutateCampaignStatus(customerId, campaignId, status) {
  const id = normalizeCustomerId(customerId || defaultCustomerId());
  const cid = normalizeCampaignId(campaignId);
  if (status !== "ENABLED" && status !== "PAUSED") throw new Error("Status must be ENABLED or PAUSED.");
  return googleAdsFetch(`/customers/${id}/campaigns:mutate`, {
    method: "POST", customerId: id,
    body: {
      operations: [{ update: { resourceName: `customers/${id}/campaigns/${cid}`, status }, updateMask: "status" }],
      partialFailure: false, validateOnly: false,
    },
  });
}

export async function addCampaignNegativeKeywords(customerId, campaignId, keywords) {
  const id = normalizeCustomerId(customerId || defaultCustomerId());
  const cid = normalizeCampaignId(campaignId);
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 50) {
    throw new Error("Provide between 1 and 50 negative keywords.");
  }
  const operations = keywords.map(({ text, matchType = "PHRASE" }) => {
    const keywordText = String(text ?? "").trim();
    if (!keywordText || keywordText.length > 80) throw new Error("Negative keyword must contain 1–80 characters.");
    if (!["EXACT", "PHRASE", "BROAD"].includes(matchType)) throw new Error("Invalid keyword match type.");
    return { create: {
      campaign: `customers/${id}/campaigns/${cid}`, negative: true,
      keyword: { text: keywordText, matchType },
    } };
  });
  return googleAdsFetch(`/customers/${id}/campaignCriteria:mutate`, {
    method: "POST", customerId: id,
    body: { operations, partialFailure: false, validateOnly: false },
  });
}
