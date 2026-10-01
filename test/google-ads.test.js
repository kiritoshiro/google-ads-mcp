import test from "node:test";
import assert from "node:assert/strict";
import { listAccessibleCustomers, normalizeCustomerId, search } from "../src/google-ads.js";

test("customer IDs and API results are bounded, and Google errors are redacted", async () => {
  assert.equal(normalizeCustomerId("123-456-7890"), "1234567890");
  assert.throws(() => normalizeCustomerId("123"));
  const oldFetch = globalThis.fetch;
  const oldEnv = {
    GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  };
  Object.assign(process.env, { GOOGLE_ADS_CLIENT_ID: "client", GOOGLE_ADS_CLIENT_SECRET: "secret", GOOGLE_ADS_REFRESH_TOKEN: "refresh" });
  let mode = "accounts";
  globalThis.fetch = async (url, options) => {
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(options.method, "POST");
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    }
    assert.match(url, /^https:\/\/googleads\.googleapis\.com\/v25\//);
    assert.equal(options.headers.authorization, "Bearer access");
    if (mode === "accounts") return new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), { status: 200 });
    if (mode === "rows") return new Response(JSON.stringify([{ results: [{ campaign: { id: "1" } }, { campaign: { id: "2" } }] }]), { status: 200 });
    return new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "request echoed secret refresh" } }), { status: 400 });
  };
  try {
    assert.deepEqual(await listAccessibleCustomers(), ["customers/1234567890"]);
    mode = "rows";
    await assert.rejects(() => search("1234567890", "SELECT campaign.id FROM campaign LIMIT 2", 1), /more than 1 row/);
    mode = "error";
    await assert.rejects(() => search("1234567890", "SELECT campaign.id FROM campaign LIMIT 1", 1), (error) => {
      assert.match(error.message, /HTTP 400: INVALID_ARGUMENT/);
      assert.doesNotMatch(error.message, /secret refresh/);
      return true;
    });
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
