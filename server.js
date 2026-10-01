import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  addCampaignNegativeKeywords, defaultCustomerId, listAccessibleCustomers,
  mutateCampaignStatus, normalizeCustomerId, search,
} from "./src/google-ads.js";

const DATE_RANGES = ["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"];
const MCP_PATH = "/mcp";
const DATE_INPUT = {
  dateRange: z.enum(DATE_RANGES).optional().describe("Predefined range; omit when using startDate and endDate."),
  startDate: z.string().optional().describe("Inclusive YYYY-MM-DD; provide with endDate."),
  endDate: z.string().optional().describe("Inclusive YYYY-MM-DD; provide with startDate."),
};

function textResult(message, structuredContent = {}) {
  return { content: [{ type: "text", text: message }], structuredContent };
}

function safeError(error) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : "Unknown error" }], isError: true };
}

function customerIdOrDefault(value) { return value ? normalizeCustomerId(value) : defaultCustomerId(); }

export function dateFilter({ dateRange, startDate, endDate }) {
  if (startDate || endDate) {
    if (!startDate || !endDate || dateRange) throw new Error("Provide both startDate and endDate, without dateRange.");
    for (const date of [startDate, endDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error("Dates must be valid YYYY-MM-DD values.");
      }
    }
    if (startDate > endDate) throw new Error("startDate must be on or before endDate.");
    return `segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  }
  const range = dateRange || "LAST_30_DAYS";
  if (!DATE_RANGES.includes(range)) throw new Error("Invalid dateRange.");
  return `segments.date DURING ${range}`;
}

export function prepareGaql(query) {
  const trimmed = query.trim();
  if (!/^SELECT\s+[\s\S]+\s+FROM\s+[a-z_][a-z_0-9]*\b/i.test(trimmed)) {
    throw new Error("GAQL must start with SELECT fields FROM resource.");
  }
  if (/[;]|--|\/\*|\*\//.test(trimmed) || /\bPARAMETERS\b/i.test(trimmed)) {
    throw new Error("Semicolons, comments, and PARAMETERS are not supported.");
  }
  const limits = [...trimmed.matchAll(/\bLIMIT\b/gi)];
  if (limits.length > 1) throw new Error("Only one LIMIT clause is allowed.");
  if (limits.length === 0) return `${trimmed} LIMIT 1000`;
  const match = /\bLIMIT\s+(\d+)\s*$/i.exec(trimmed);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 1000) throw new Error("LIMIT must be between 1 and 1000 and appear last.");
  return trimmed;
}

function assertWritesEnabled(confirmed) {
  if (process.env.ALLOW_WRITES !== "true") throw new Error("Write tools are disabled. Set ALLOW_WRITES=true after read-only testing.");
  if (confirmed !== true) throw new Error("This write action requires explicit confirmation.");
}

export function createAdsServer() {
  const server = new McpServer({ name: "google-ad-grants-manager", version: "0.2.0" }, {
    instructions: "Inspect the account before proposing changes. Obtain the user's approval for each exact write. Focus on meaningful conversions and relevant search intent.",
  });

  server.registerTool("list_google_ads_accounts", {
    title: "List accessible Google Ads accounts",
    description: "Lists customer IDs accessible to the configured Google OAuth identity.",
    inputSchema: {}, outputSchema: { accounts: z.array(z.string()) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async () => {
    try { const accounts = await listAccessibleCustomers(); return textResult(`Found ${accounts.length} accessible account(s).`, { accounts }); }
    catch (error) { return safeError(error); }
  });

  server.registerTool("get_ad_grants_overview", {
    title: "Get account and campaign overview",
    description: "Account identity and campaign metrics for a predefined or historical date window. The account must be configured in the server or supplied by customerId.",
    inputSchema: { customerId: z.string().optional(), ...DATE_INPUT },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, ...dates }) => {
    try {
      const id = customerIdOrDefault(customerId);
      const where = dateFilter(dates);
      const customer = await search(id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 1", 1);
      const campaigns = await search(id, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.optimization_score, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.average_cpc, metrics.cost_per_conversion FROM campaign WHERE ${where} ORDER BY metrics.impressions DESC LIMIT 200`, 200);
      return textResult(`Loaded account overview for ${id}.`, { customerId: id, dateFilter: where, customer: customer[0] ?? null, campaigns });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("get_search_terms", {
    title: "Get real search terms",
    description: "Search terms and performance metrics for diagnosing irrelevant traffic.",
    inputSchema: { customerId: z.string().optional(), ...DATE_INPUT, limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, limit, ...dates }) => {
    try {
      const id = customerIdOrDefault(customerId); const where = dateFilter(dates);
      const rows = await search(id, `SELECT search_term_view.search_term, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${where} ORDER BY metrics.clicks DESC LIMIT ${limit}`, limit);
      return textResult(`Loaded ${rows.length} search term row(s).`, { customerId: id, dateFilter: where, rows });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("get_keyword_performance", {
    title: "Get keyword performance",
    description: "Keywords with clicks, costs, and conversions; useful for finding traffic without meaningful results.",
    inputSchema: { customerId: z.string().optional(), ...DATE_INPUT, limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, limit, ...dates }) => {
    try {
      const id = customerIdOrDefault(customerId); const where = dateFilter(dates);
      const rows = await search(id, `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions FROM keyword_view WHERE ${where} ORDER BY metrics.clicks DESC LIMIT ${limit}`, limit);
      return textResult(`Loaded ${rows.length} keyword row(s).`, { customerId: id, dateFilter: where, rows });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("get_landing_page_performance", {
    title: "Get landing page performance",
    description: "Landing page URLs and traffic/conversion metrics. Does not crawl the website.",
    inputSchema: { customerId: z.string().optional(), ...DATE_INPUT, limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, limit, ...dates }) => {
    try {
      const id = customerIdOrDefault(customerId); const where = dateFilter(dates);
      const rows = await search(id, `SELECT landing_page_view.unexpanded_final_url, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM landing_page_view WHERE ${where} ORDER BY metrics.clicks DESC LIMIT ${limit}`, limit);
      return textResult(`Loaded ${rows.length} landing page row(s).`, { customerId: id, dateFilter: where, rows });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("list_conversion_actions", {
    title: "List conversion actions",
    description: "Conversion action status and primary-for-goal setting for measurement review.",
    inputSchema: { customerId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId }) => {
    try {
      const id = customerIdOrDefault(customerId);
      const rows = await search(id, "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action ORDER BY conversion_action.name LIMIT 500", 500);
      return textResult(`Loaded ${rows.length} conversion action(s).`, { customerId: id, rows });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("query_google_ads", {
    title: "Run a bounded read-only GAQL query",
    description: "SELECT-only Google Ads Query Language for account analysis not covered by focused tools. At most 1000 rows and 8 MB per response.",
    inputSchema: { customerId: z.string().optional(), query: z.string().min(10).max(12000) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, query }) => {
    try {
      const id = customerIdOrDefault(customerId); const bounded = prepareGaql(query);
      const rows = await search(id, bounded, 1000);
      return textResult(`GAQL returned ${rows.length} row(s).`, { customerId: id, rows });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("set_campaign_status", {
    title: "Pause or enable a campaign",
    description: "Changes one campaign status. Requires ALLOW_WRITES=true and confirmation of this exact change by the user.",
    inputSchema: { customerId: z.string().optional(), campaignId: z.string().regex(/^\d+$/), status: z.enum(["PAUSED", "ENABLED"]), confirmed: z.boolean() },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, campaignId, status, confirmed }) => {
    try {
      assertWritesEnabled(confirmed); const id = customerIdOrDefault(customerId);
      const result = await mutateCampaignStatus(id, campaignId, status);
      return textResult(`Campaign ${campaignId} changed to ${status}.`, { customerId: id, campaignId, status, result });
    } catch (error) { return safeError(error); }
  });

  server.registerTool("add_campaign_negative_keywords", {
    title: "Add campaign negative keywords",
    description: "Adds up to 50 negative keywords to one campaign. Requires ALLOW_WRITES=true and confirmation of the exact list by the user.",
    inputSchema: {
      customerId: z.string().optional(), campaignId: z.string().regex(/^\d+$/),
      keywords: z.array(z.object({ text: z.string().min(1).max(80), matchType: z.enum(["EXACT", "PHRASE", "BROAD"]).default("PHRASE") })).min(1).max(50),
      confirmed: z.boolean(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ customerId, campaignId, keywords, confirmed }) => {
    try {
      assertWritesEnabled(confirmed); const id = customerIdOrDefault(customerId);
      const result = await addCampaignNegativeKeywords(id, campaignId, keywords);
      return textResult(`Added ${keywords.length} negative keyword(s) to campaign ${campaignId}.`, { customerId: id, campaignId, keywords, result });
    } catch (error) { return safeError(error); }
  });
  return server;
}

function validOrigin(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

function authorized(req) {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) return true;
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(supplied); const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHttpServer() {
  const host = process.env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("HOST must be a loopback address. Use an authenticated HTTPS proxy for remote access.");
  return createServer(async (req, res) => {
    const allowedHosts = ["127.0.0.1", "localhost", "[::1]"];
    const requestHost = req.headers.host?.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/)?.[1];
    if (!req.url || !requestHost || !allowedHosts.includes(requestHost) || !validOrigin(req.headers.origin)) {
      res.writeHead(403).end("Forbidden"); return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "google-ad-grants-manager", version: "0.2.0", mcp: MCP_PATH })); return;
    }
    if (url.pathname !== MCP_PATH) { res.writeHead(404).end("Not Found"); return; }
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (!authorized(req)) { res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized"); return; }
    if (!["POST", "GET", "DELETE"].includes(req.method)) { res.writeHead(405).end("Method Not Allowed"); return; }
    const server = createAdsServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end("Internal server error"); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  const host = process.env.HOST || "127.0.0.1";
  createHttpServer().listen(port, host, () => console.log(`Google Ad Grants MCP listening on http://${host}:${port}${MCP_PATH}`));
}
