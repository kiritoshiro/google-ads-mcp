import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHttpServer, dateFilter, prepareGaql } from "../server.js";

test("historical dates are validated and bounded", () => {
  assert.equal(dateFilter({ startDate: "2024-01-01", endDate: "2024-12-31" }), "segments.date BETWEEN '2024-01-01' AND '2024-12-31'");
  assert.equal(dateFilter({}), "segments.date DURING LAST_30_DAYS");
  assert.throws(() => dateFilter({ startDate: "2024-02-30", endDate: "2024-03-01" }), /valid/);
  assert.throws(() => dateFilter({ startDate: "2024-12-31", endDate: "2024-01-01" }), /before/);
  assert.throws(() => dateFilter({ dateRange: "TODAY", startDate: "2024-01-01", endDate: "2024-01-02" }), /without dateRange/);
});

test("generic GAQL stays read-only and limited", () => {
  assert.equal(prepareGaql("SELECT campaign.id FROM campaign"), "SELECT campaign.id FROM campaign LIMIT 1000");
  assert.equal(prepareGaql("SELECT campaign.id FROM campaign LIMIT 50"), "SELECT campaign.id FROM campaign LIMIT 50");
  for (const query of [
    "UPDATE campaign SET status = 'PAUSED'", "SELECT campaign.id FROM campaign; DELETE campaign",
    "SELECT campaign.id FROM campaign LIMIT 1001", "SELECT campaign.id FROM campaign --comment",
  ]) assert.throws(() => prepareGaql(query));
});

test("local MCP handshake, write gate, and browser origin policy", async () => {
  const previous = process.env.ALLOW_WRITES;
  process.env.ALLOW_WRITES = "false";
  const server = createHttpServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(base);
    assert.equal(health.status, 200);
    const blocked = await fetch(`${base}/mcp`, { method: "POST", headers: {
      origin: "https://example.com", "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(blocked.status, 403);

    const request = async (body) => {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
      }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } });
    assert.equal(init.result.serverInfo.name, "google-ad-grants-manager");
    const tools = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.ok(tools.result.tools.some((tool) => tool.name === "get_keyword_performance"));
    const write = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "set_campaign_status", arguments: { customerId: "1234567890", campaignId: "42", status: "PAUSED", confirmed: true },
    } });
    assert.equal(write.result.isError, true);
    assert.match(write.result.content[0].text, /disabled/);
  } finally {
    server.close(); await once(server, "close");
    if (previous === undefined) delete process.env.ALLOW_WRITES; else process.env.ALLOW_WRITES = previous;
  }
});
