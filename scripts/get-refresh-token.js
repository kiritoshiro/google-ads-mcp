import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";

const clientId = process.env.GOOGLE_ADS_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const port = Number(process.env.OAUTH_PORT || 53682);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OAUTH_PORT must be between 1 and 65535.");
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const state = randomBytes(24).toString("hex");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: "code",
  scope: "https://www.googleapis.com/auth/adwords", access_type: "offline",
  prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
}).toString();

function openBrowser(url) {
  const executable = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.error("Could not open a browser automatically; use the URL above."));
    child.unref();
  } catch { console.error("Could not open a browser automatically; use the URL above."); }
}

let completed = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (req.method !== "GET" || url.pathname !== "/oauth2callback") { res.writeHead(404).end("Not found"); return; }
  if (completed || url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid OAuth callback"); return; }
  completed = true;
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code) {
    res.writeHead(400).end("Google authorization was not completed.");
    server.close(); return;
  }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code,
        code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(30_000),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.refresh_token) throw new Error(`Token exchange failed (HTTP ${tokenResponse.status}).`);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Google Ads authorization completed. You can close this tab.");
    console.log("\nGOOGLE_ADS_REFRESH_TOKEN=" + tokens.refresh_token);
    console.log("Keep this secret in .env. Do not commit it to Git.\n");
  } catch (error) {
    res.writeHead(500).end("Token exchange failed. See terminal for status.");
    console.error(error instanceof Error ? error.message : "Token exchange failed.");
  } finally { server.close(); }
});

server.setTimeout(60_000);
server.listen(port, "127.0.0.1", () => {
  console.log(`OAuth callback listening on ${redirectUri}`);
  console.log("If the browser does not open, visit:\n" + authUrl);
  openBrowser(authUrl.toString());
});
