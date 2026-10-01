# Google Ad Grants MCP

A private Node.js MCP server for reviewing one Google Ads / Ad Grants account. It uses the Google Ads REST API directly, with no paid middleware. The first release keeps all account changes disabled by default.

## Tools

Read: `list_google_ads_accounts`, `get_ad_grants_overview`, `get_search_terms`, `get_keyword_performance`, `get_landing_page_performance`, `list_conversion_actions`, and `query_google_ads`. Performance tools accept a predefined `dateRange` or an inclusive `startDate` and `endDate` in `YYYY-MM-DD` form. The generic GAQL tool accepts one `SELECT` query and caps it at 1,000 rows. Responses are capped at 8 MB.

Writes: `set_campaign_status` and `add_campaign_negative_keywords`. Both require `ALLOW_WRITES=true` and a `confirmed=true` argument after the user has approved the exact change. MCP annotations and the argument are workflow safeguards, not a substitute for controlling who can reach the server.

## Requirements

- Node.js 20 or newer (tested with Node 24).
- A Google Cloud project with Google Ads API enabled and an approved API access level for the intended account.
- A Google OAuth desktop client in that project, and a Google user with access to the Ads account.

Google retired developer tokens on September 9, 2026. API access is tied to the Cloud project owning the OAuth credentials; this server does not send a developer-token header. A new Cloud project may still need an appropriate Google Ads API access level before it can read a production account. See [Google's access guide](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).

## Local setup

```bash
cp .env.example .env
npm ci
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp` if preferred. Set `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET` in `.env`. Keep that file local; it is ignored by Git.

Run the OAuth helper from the same computer:

```bash
node --env-file=.env scripts/get-refresh-token.js
```

Authorize the Google user who has access to the Ad Grants account. The helper displays a refresh token in your terminal once. Put it in `.env` as `GOOGLE_ADS_REFRESH_TOKEN`. Do not paste it into chat, an issue, or Git. Set `GOOGLE_ADS_CUSTOMER_ID` to the 10-digit Ads account ID. If access is through a manager account, also set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to that manager's 10-digit ID.

Start with `ALLOW_WRITES=false`:

```bash
npm start
```

The local MCP endpoint is `http://127.0.0.1:8787/mcp`; `GET /` is a minimal health check. The portable `mcp.json` points to the local endpoint for local MCP clients. The server accepts only loopback `HOST` values and checks Host and browser Origin headers. If you set `MCP_AUTH_TOKEN`, every MCP request must carry `Authorization: Bearer <token>`; configure that in the MCP client. Keep any such token outside the repository.

## Verify before using the account

```bash
npm run check
npm test
npx @modelcontextprotocol/inspector@latest
```

In MCP Inspector, select Streamable HTTP and connect to the local endpoint. First call `list_google_ads_accounts`; then run the overview and conversion tools. If Google returns an authorization error, verify that the OAuth user's account access, manager ID, Google Ads API enablement, and Cloud project API access level are correct. The server intentionally does not return Google's full error payload because it can echo request details.

The local tests use no Google credentials. A live account test still requires the owner's OAuth setup.

## ChatGPT and Codex connection

Local Codex clients can use the local MCP URL. ChatGPT needs a reachable endpoint: use OpenAI's Secure MCP Tunnel for private development when available, or a properly authenticated HTTPS deployment. Do not publish the bare local server through an unauthenticated tunnel. The portable `plugin.json`, `mcp.json`, and skill package the project; after registering the MCP server in ChatGPT developer mode, map the registered connection when packaging for ChatGPT. A localhost URL in `mcp.json` is not a public ChatGPT endpoint.

OpenAI's [MCP server guide](https://developers.openai.com/plugins/build/mcp-server) describes the transport, local testing, and authenticated deployment requirements. Publishing this repository on GitHub does **not** install or publish a plugin in ChatGPT.

## Security and scope

- The refresh token stays in the server environment; access tokens are held in process memory.
- Ads API requests have a 30-second timeout and bounded JSON response size.
- Error results omit raw Google response bodies.
- The server exposes no generic mutation endpoint.
- Only trusted local software should run with access to this user's `.env` and loopback port. Use an authenticated proxy or tunnel for remote access.
- Website crawling, policy decisions, and account suspension diagnosis are **not** implemented yet. `get_landing_page_performance` reports Ads data; it does not test page availability.

## Roadmap

After a successful read-only account connection: review real account fields and build focused tools for change history, Ad Grants policy evidence, and safe landing-page checks. Then design Search ad, keyword, and campaign editing around exact review and approval. PMax reporting and assets require separate data-model work. A future `audit_ad_grants_compliance` should combine account evidence with a rate-limited crawl of an explicitly configured domain and report findings, not assert that Google will approve a suspended account.

See [PLAN.md](PLAN.md) for the release sequence.
