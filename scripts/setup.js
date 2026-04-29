#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = path.resolve(__dirname, "..");
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

function env(name, fallback = "") {
  return process.env[name] || fileEnv[name] || fallback;
}

function writeEnv(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value || ""}`);
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`);
}

function randomSuffix() {
  return crypto.randomBytes(4).toString("hex");
}

function normalizeUrl(value) {
  return value.replace(/\/$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actionPayload(attributes) {
  return { attributes };
}

async function postJson(url, body, token) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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

async function postEntity(url, attributes, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/vnd.api+json",
      accept: "application/vnd.api+json, application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      data: {
        type: "oauth_connect",
        attributes,
      },
    }),
  });
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

function findActionItem(response, type, key) {
  return collectActionItems(response).find((item) => item && item.type === type && (!key || item.key === key));
}

function collectActionData(response) {
  for (const item of collectActionItems(response)) {
    if (item && item.type === "client.notify" && item.attributes && typeof item.attributes === "object") {
      return item.attributes;
    }
    if (item && item.attributes && item.attributes.client_id) {
      return item.attributes;
    }
  }
  return {};
}

function tokenFromSignin(response) {
  const tokenItem = findActionItem(response, "client.store.set", "token");
  return tokenItem && (tokenItem.value || (tokenItem.attributes && tokenItem.attributes.value));
}

async function ensureAdminToken(baseUrl, email, password) {
  if (env("DAPTIN_ADMIN_TOKEN")) {
    return env("DAPTIN_ADMIN_TOKEN");
  }

  console.log(`Creating demo admin user if needed: ${email}`);
  try {
    await postJson(`${baseUrl}/action/user_account/signup`, actionPayload({
      email,
      name: "Daptin OAuth Demo Admin",
      password,
      passwordConfirm: password,
    }));
  } catch (error) {
    console.log(`Signup was not applied, continuing with signin: ${error.message}`);
  }

  const signin = await postJson(`${baseUrl}/action/user_account/signin`, actionPayload({
    email,
    password,
  }));
  let token = tokenFromSignin(signin);
  if (!token) {
    throw new Error("Could not extract bearer token from signin action response.");
  }

  console.log("Requesting administrator role for the demo user.");
  try {
    await postJson(`${baseUrl}/action/world/become_an_administrator`, actionPayload({}), token);
  } catch (error) {
    console.log(`Administrator action was not applied, continuing: ${error.message}`);
  }

  const signinAgain = await postJson(`${baseUrl}/action/user_account/signin`, actionPayload({
    email,
    password,
  }));
  token = tokenFromSignin(signinAgain) || token;
  return token;
}

async function registerProviderApp(baseUrl, token, authenticatorName, demoBaseUrl) {
  const providerRedirect = `${demoBaseUrl}/callback?authenticator=${encodeURIComponent(authenticatorName)}`;
  const plainRedirect = `${demoBaseUrl}/plain-client/callback`;

  console.log("Registering OAuth provider client through oauth_app action.");
  const response = await postJson(`${baseUrl}/action/oauth_app/register_client`, actionPayload({
    name: `Daptin self OAuth demo (${authenticatorName})`,
    redirect_uris: `${providerRedirect}\n${plainRedirect}`,
    scopes: "openid profile email",
    grants: "authorization_code refresh_token",
    is_confidential: true,
  }), token);

  const attrs = collectActionData(response);
  if (!attrs.client_id || !attrs.client_secret) {
    throw new Error(`Could not extract OAuth client credentials: ${JSON.stringify(response)}`);
  }

  return {
    clientId: attrs.client_id,
    clientSecret: attrs.client_secret,
    referenceId: attrs.reference_id || attrs.oauth_app_id || attrs.id || "",
  };
}

async function createOauthConnect(apiUrl, browserUrl, internalUrl, token, authenticatorName, demoBaseUrl, clientId, clientSecret) {
  console.log("Creating Daptin oauth_connect configuration for self-login.");
  const response = await postEntity(`${apiUrl}/api/oauth_connect`, {
    name: authenticatorName,
    client_id: clientId,
    client_secret: clientSecret,
    scope: "openid,profile,email",
    response_type: "code",
    redirect_uri: `${demoBaseUrl}/callback`,
    auth_url: `${browserUrl}/oauth/authorize`,
    token_url: `${internalUrl}/oauth/token`,
    profile_url: `${internalUrl}/oauth/userinfo`,
    profile_email_path: "email",
    allow_login: true,
    access_type_offline: true,
  }, token);

  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  return data && (data.id || (data.attributes && data.attributes.reference_id));
}

async function assertDaptinReachable(baseUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/.well-known/openid-configuration`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Status: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      console.log(`Waiting for Daptin OAuth discovery at ${baseUrl} (${attempt}/60).`);
    }
    await sleep(1000);
  }
  throw new Error(`Daptin OAuth discovery endpoint is not reachable at ${baseUrl}: ${lastError && lastError.message}`);
}

const fileEnv = loadEnvFile(envPath);

async function main() {
  const daptinBaseUrl = normalizeUrl(env("DAPTIN_BASE_URL", "http://localhost:6336"));
  const daptinApiUrl = normalizeUrl(env("DAPTIN_API_URL", daptinBaseUrl));
  const daptinBrowserUrl = normalizeUrl(env("DAPTIN_BROWSER_URL", daptinBaseUrl));
  const daptinInternalUrl = normalizeUrl(env("DAPTIN_INTERNAL_URL", daptinApiUrl));
  const demoBaseUrl = normalizeUrl(env("DEMO_BASE_URL", "http://localhost:7777"));
  const email = env("DEMO_ADMIN_EMAIL", "demo-admin@example.com");
  const password = env("DEMO_ADMIN_PASSWORD", "demo-admin-password");
  const authenticatorName = env("AUTHENTICATOR_NAME", `daptin-self-${randomSuffix()}`);

  await assertDaptinReachable(daptinApiUrl);
  const adminToken = await ensureAdminToken(daptinApiUrl, email, password);
  const providerApp = await registerProviderApp(daptinApiUrl, adminToken, authenticatorName, demoBaseUrl);
  const oauthConnectId = await createOauthConnect(
    daptinApiUrl,
    daptinBrowserUrl,
    daptinInternalUrl,
    adminToken,
    authenticatorName,
    demoBaseUrl,
    providerApp.clientId,
    providerApp.clientSecret,
  );

  const output = {
    DAPTIN_BASE_URL: daptinBaseUrl,
    DAPTIN_API_URL: daptinApiUrl,
    DAPTIN_BROWSER_URL: daptinBrowserUrl,
    DAPTIN_INTERNAL_URL: daptinInternalUrl,
    DEMO_BASE_URL: demoBaseUrl,
    DAPTIN_ADMIN_TOKEN: adminToken,
    DEMO_ADMIN_EMAIL: email,
    DEMO_ADMIN_PASSWORD: password,
    AUTHENTICATOR_NAME: authenticatorName,
    OAUTH_APP_REFERENCE_ID: providerApp.referenceId,
    OAUTH_CONNECT_REFERENCE_ID: oauthConnectId || "",
    OAUTH_CLIENT_ID: providerApp.clientId,
    OAUTH_CLIENT_SECRET: providerApp.clientSecret,
  };

  writeEnv(output);
  console.log(`Wrote ${envPath}`);
  console.log(`Start the demo with: npm start`);
  console.log(`Then open: ${demoBaseUrl}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
