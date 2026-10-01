---
name: ad-grants-manager
description: Review and manage a Google Ad Grants account using the bundled Google Ads MCP tools. Use for campaign performance, search terms, conversions, landing pages, negative keywords, or campaign status changes.
---

# Google Ad Grants Manager

Start with read-only inspection. Prefer meaningful conversions and relevant search intent over spending the full grant.

For account reviews:
1. Call `get_ad_grants_overview` for the requested period.
2. Inspect `list_conversion_actions` before judging campaign effectiveness.
3. Use `get_search_terms` to find irrelevant queries and `get_keyword_performance` to inspect clicks without conversions.
4. Use `get_landing_page_performance` to identify weak or mismatched landing pages.
5. Use `query_google_ads` only when the focused tools do not expose the required field.

For changes:
- Never call a write tool until the user has explicitly approved the exact change.
- Re-read or identify the campaign before changing it.
- Prefer adding narrowly justified negative keywords over broad exclusions.
- Do not optimize merely to maximize clicks, impressions, or spend.
- If Google rejects a mutation, report the API error without repeatedly retrying a potentially invalid change.
