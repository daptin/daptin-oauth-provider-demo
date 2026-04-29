#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = __dirname;
const envPath = path.join(rootDir, ".env.local");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

const fileEnv = loadEnvFile(envPath);

function env(name, fallback = "") {
  return process.env[name] || fileEnv[name] || fallback;
}

const config = {
  daptinBaseUrl: env("DAPTIN_BASE_URL", "http://localhost:6336").replace(/\/$/, ""),
  demoBaseUrl: env("DEMO_BASE_URL", "http://localhost:7777").replace(/\/$/, ""),
  adminToken: env("DAPTIN_ADMIN_TOKEN"),
  authenticatorName: env("AUTHENTICATOR_NAME"),
  oauthConnectId: env("OAUTH_CONNECT_REFERENCE_ID"),
  clientId: env("OAUTH_CLIENT_ID"),
  clientSecret: env("OAUTH_CLIENT_SECRET"),
};

const listenUrl = new URL(config.demoBaseUrl);
const port = Number(listenUrl.port || (listenUrl.protocol === "https:" ? 443 : 80));
const host = listenUrl.hostname || "localhost";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(size = 32) {
  return base64Url(crypto.randomBytes(size));
}

function pkceChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonBlock(value) {
  return `<pre>${htmlEscape(JSON.stringify(value, null, 2))}</pre>`;
}

function parseCookies(request) {
  const cookies = {};
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function setCookie(response, name, value) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  const existing = response.getHeader("set-cookie");
  if (!existing) {
    response.setHeader("set-cookie", cookie);
  } else if (Array.isArray(existing)) {
    response.setHeader("set-cookie", [...existing, cookie]);
  } else {
    response.setHeader("set-cookie", [existing, cookie]);
  }
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

function sendHtml(response, title, body, status = 200) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #1f2723; }
    main { max-width: 920px; margin: 0 auto; padding: 48px 24px; }
    h1 { font-size: 32px; line-height: 1.15; margin: 0 0 12px; letter-spacing: 0; }
    h2 { font-size: 20px; margin: 32px 0 8px; }
    p { line-height: 1.6; color: #48514d; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0; }
    a.button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border: 1px solid #1f6f55; border-radius: 6px; text-decoration: none; color: white; background: #1f6f55; font-weight: 650; }
    a.secondary { background: white; color: #1f6f55; }
    code { background: rgba(31, 111, 85, 0.1); padding: 2px 5px; border-radius: 4px; }
    pre { overflow: auto; padding: 16px; border-radius: 6px; background: #1f2723; color: #eef6f2; }
    .panel { border: 1px solid #d8ded9; border-radius: 8px; padding: 20px; background: white; margin: 18px 0; }
    .warning { color: #8a4f00; }
    @media (prefers-color-scheme: dark) {
      body { background: #151916; color: #ecf2ee; }
      p { color: #bac6bf; }
      .panel { background: #1d241f; border-color: #354239; }
      a.secondary { background: #1d241f; }
    }
  </style>
</head>
<body><main>${body}</main></body>
</html>`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${detail}`);
  }
  return data;
}

function collectActionItems(response) {
  const items = [];
  const data = response && response.data;
  if (Array.isArray(data)) {
    for (const row of data) {
      if (Array.isArray(row.attributes)) {
        items.push(...row.attributes);
      }
    }
  } else if (data && Array.isArray(data.attributes)) {
    items.push(...data.attributes);
  } else if (Array.isArray(response && response.attributes)) {
    items.push(...response.attributes);
  }
  return items;
}

function actionItem(response, type, key) {
  return collectActionItems(response).find((item) => item && item.type === type && (!key || item.key === key));
}

function requireConfig(keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(", ")}. Run npm run setup first.`);
  }
}

function renderHome(response) {
  const missing = ["adminToken", "authenticatorName", "oauthConnectId", "clientId", "clientSecret"].filter((key) => !config[key]);
  const configWarning = missing.length
    ? `<p class="warning">Missing generated setup values: <code>${htmlEscape(missing.join(", "))}</code>. Run <code>npm run setup</code>.</p>`
    : "";
  sendHtml(response, "Daptin OAuth Provider Demo", `
    <h1>Daptin OAuth Provider Demo</h1>
    <p>This local app exercises Daptin as an OAuth provider and as an OAuth client of itself.</p>
    ${configWarning}
    <div class="actions">
      <a class="button" href="/plain-client/begin">Plain OAuth client login</a>
      <a class="button secondary" href="/daptin-consumer/begin">Daptin oauth_connect self-login</a>
    </div>
    <div class="panel">
      <h2>Current configuration</h2>
      <p>Daptin: <code>${htmlEscape(config.daptinBaseUrl)}</code></p>
      <p>Demo: <code>${htmlEscape(config.demoBaseUrl)}</code></p>
      <p>Authenticator: <code>${htmlEscape(config.authenticatorName || "(not configured)")}</code></p>
      <p>Client ID: <code>${htmlEscape(config.clientId || "(not configured)")}</code></p>
    </div>
    <div class="panel">
      <h2>Before running</h2>
      <p>Sign in to Daptin in the same browser at <code>${htmlEscape(config.daptinBaseUrl)}</code>. The provider authorization page uses the browser's Daptin session.</p>
    </div>
  `);
}

async function beginPlainClient(request, response) {
  requireConfig(["clientId", "clientSecret"]);
  const state = randomToken();
  const verifier = randomToken(48);
  const authorizeUrl = new URL(`${config.daptinBaseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", `${config.demoBaseUrl}/plain-client/callback`);
  authorizeUrl.searchParams.set("scope", "openid profile email");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  setCookie(response, "plain_state", state);
  setCookie(response, "plain_verifier", verifier);
  redirect(response, authorizeUrl.toString());
}

async function finishPlainClient(request, response, url) {
  requireConfig(["clientId", "clientSecret"]);
  const cookies = parseCookies(request);
  const expectedState = cookies.plain_state;
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`Provider returned OAuth error: ${error}`);
  }
  if (!code) {
    throw new Error("Callback did not include code.");
  }
  if (!expectedState || expectedState !== state) {
    throw new Error("OAuth state mismatch.");
  }
  if (!cookies.plain_verifier) {
    throw new Error("Missing PKCE verifier cookie.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${config.demoBaseUrl}/plain-client/callback`,
    code_verifier: cookies.plain_verifier,
  });
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const token = await fetchJson(`${config.daptinBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  const userinfo = await fetchJson(`${config.daptinBaseUrl}/oauth/userinfo`, {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/json",
    },
  });
  sendHtml(response, "Plain OAuth Client Result", `
    <h1>Plain OAuth client result</h1>
    <p>The demo exchanged the authorization code at Daptin's token endpoint and fetched userinfo.</p>
    <div class="actions"><a class="button secondary" href="/">Back</a></div>
    <h2>UserInfo</h2>
    ${jsonBlock(userinfo)}
    <h2>Token response</h2>
    ${jsonBlock(token)}
  `);
}

async function beginDaptinConsumer(request, response) {
  requireConfig(["adminToken", "oauthConnectId"]);
  const result = await fetchJson(`${config.daptinBaseUrl}/action/oauth_connect/oauth_login_begin`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.adminToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      attributes: {
        oauth_connect_id: config.oauthConnectId,
      },
    }),
  });
  const stateItem = actionItem(result, "client.store.set", "secret");
  const redirectItem = actionItem(result, "client.redirect");
  const location = redirectItem && (redirectItem.location || redirectItem.value || (redirectItem.attributes && redirectItem.attributes.location));
  const state = stateItem && (stateItem.value || (stateItem.attributes && stateItem.attributes.value));
  if (!location) {
    throw new Error(`Daptin did not return a client.redirect item: ${JSON.stringify(result)}`);
  }
  if (state) {
    setCookie(response, "daptin_consumer_state", state);
  }
  redirect(response, location);
}

async function finishDaptinConsumer(request, response, url) {
  requireConfig(["adminToken", "authenticatorName"]);
  const cookies = parseCookies(request);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const authenticator = url.searchParams.get("authenticator") || config.authenticatorName;
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`Provider returned OAuth error: ${error}`);
  }
  if (!code || !state) {
    throw new Error("Callback did not include code and state.");
  }
  if (cookies.daptin_consumer_state && cookies.daptin_consumer_state !== state) {
    throw new Error("Daptin consumer state mismatch.");
  }
  const result = await fetchJson(`${config.daptinBaseUrl}/action/oauth_token/oauth.login.response`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.adminToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      attributes: {
        code,
        state,
        authenticator,
      },
    }),
  });
  sendHtml(response, "Daptin Consumer Result", `
    <h1>Daptin oauth_connect result</h1>
    <p>Daptin consumed its own provider response through <code>oauth.login.response</code>.</p>
    <div class="actions"><a class="button secondary" href="/">Back</a></div>
    ${jsonBlock(result)}
  `);
}

async function route(request, response) {
  const url = new URL(request.url, config.demoBaseUrl);
  if (url.pathname === "/") {
    renderHome(response);
    return;
  }
  if (url.pathname === "/plain-client/begin") {
    await beginPlainClient(request, response);
    return;
  }
  if (url.pathname === "/plain-client/callback") {
    await finishPlainClient(request, response, url);
    return;
  }
  if (url.pathname === "/daptin-consumer/begin") {
    await beginDaptinConsumer(request, response);
    return;
  }
  if (url.pathname === "/callback") {
    await finishDaptinConsumer(request, response, url);
    return;
  }
  sendHtml(response, "Not Found", `<h1>Not Found</h1><p>No route for <code>${htmlEscape(url.pathname)}</code>.</p>`, 404);
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    sendHtml(response, "Demo Error", `
      <h1>Demo Error</h1>
      <p>${htmlEscape(error.message)}</p>
      ${jsonBlock({ stack: error.stack })}
      <div class="actions"><a class="button secondary" href="/">Back</a></div>
    `, 500);
  });
});

server.listen(port, host, () => {
  console.log(`Daptin OAuth provider demo listening at ${config.demoBaseUrl}`);
});
