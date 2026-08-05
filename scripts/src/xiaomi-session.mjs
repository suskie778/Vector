#!/usr/bin/env node
/**
 * Local-only official Xiaomi session bootstrap.
 *
 * Reads Username and Password from the process environment at runtime.
 * Never prints either value. It performs the public account login flow,
 * follows Xiaomi's STS callback, and writes a short-lived session JSON file
 * for fastboot-bridge.mjs.
 *
 * This does not bypass CAPTCHA, account eligibility, device linking, or
 * waiting periods. If Xiaomi asks for browser verification, stop and use
 * the official browser login flow.
 */

import { chmod, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SERVICE_URL = "https://account.xiaomi.com/pass/serviceLogin";
const LOGIN_URL = "https://account.xiaomi.com/pass/serviceLoginAuth2";
const SERVICE_SID = "unlockApi";
const DEFAULT_OUTPUT = "session.json";
const USER_AGENT = "XiaomiPCSuite APP/006 miflash_unlock/6.5.224.28";

const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs);
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const username = process.env["Username"] || process.env["XIAOMI_USERNAME"];
const password = process.env["Password"] || process.env["XIAOMI_PASSWORD"];
const deviceId = args.deviceId || process.env["XIAOMI_DEVICE_ID"];
const output = args.output || DEFAULT_OUTPUT;
const checkOnly = Boolean(args.checkOnly);

if (!username || !password) {
  fail(
    "Username and Password must be available as runtime secrets. No secret values were printed.",
  );
}
if (!deviceId && !checkOnly) {
  fail(
    "Provide the browser/device identifier with --device-id or XIAOMI_DEVICE_ID.",
  );
}

async function run() {
  try {
    const jar = new CookieJar();
    console.log("Requesting Xiaomi login challenge...");
    const challengeResponse = await request(
      `${SERVICE_URL}?sid=${SERVICE_SID}&_json=true&checkSafeAddress=true`,
      { headers: jar.headers() },
    );
    jar.addFromHeaders(challengeResponse.headers);
    const challenge = parseMiJson(await challengeResponse.text());
    const sign = required(challenge?._sign, "Xiaomi login _sign");

    console.log("Submitting credentials to Xiaomi...");
    const loginBody = new URLSearchParams({
      _json: "true",
      sid: SERVICE_SID,
      serviceParam: '{"checkSafePhone":false}',
      user: username,
        hash: md5Upper(password),
      _sign: sign,
      callback: "https://unlock.update.miui.com/sts",
    });
    const loginResponse = await request(LOGIN_URL, {
      method: "POST",
      headers: {
        ...jar.headers(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: loginBody,
    });
    jar.addFromHeaders(loginResponse.headers);
    const login = parseMiJson(await loginResponse.text());
    if (Number(login?.code) !== 0) {
      const captcha = login?.captchaUrl
        ? " CAPTCHA/browser verification required."
        : "";
      fail(
        `Xiaomi login was not accepted (code ${login?.code ?? "unknown"}).${
          login?.desc || login?.description || captcha
            ? ` ${login?.desc || login?.description || captcha}`
            : ""
        }`,
      );
    }
    if (login?.notificationUrl) {
      fail(
        "Xiaomi accepted the credentials but requires account verification before issuing passToken. Complete the official verification in the Xiaomi browser flow, then retry.",
      );
    }

    const userId = required(login.userId, "Xiaomi userId");
    const ssecurity = required(login.ssecurity, "Xiaomi ssecurity");
    const passToken = required(login.passToken, "Xiaomi passToken");
    const location = required(login.location, "Xiaomi login callback");

    console.log("Completing Xiaomi service-token callback...");
    const callbackResponse = await requestFollowingRedirects(location, jar);
    const callbackText = await callbackResponse.text();
    const serviceToken =
      jar.get("serviceToken") || extractCookie(callbackText, "serviceToken");
    if (!serviceToken) {
      fail(
        "Xiaomi did not return serviceToken. Complete the official browser verification and retry.",
      );
    }

    if (checkOnly) {
      console.log(
        "Xiaomi login and service-token exchange succeeded. No session file was written.",
      );
      process.exit(0);
    }

    const session = {
      userId: String(userId),
      deviceId: String(deviceId),
      ssecurity: String(ssecurity),
      cookies: {
        userId: String(userId),
        serviceToken: String(serviceToken),
        ...(jar.get("unlockApi_slh")
          ? { unlockApi_slh: jar.get("unlockApi_slh") }
          : {}),
        ...(jar.get("unlockApi_ph")
          ? { unlockApi_ph: jar.get("unlockApi_ph") }
          : {}),
      },
    };
    await writeFile(output, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await chmod(output, 0o600);
    } catch {
      // Windows and some mounted filesystems do not support chmod.
    }

    console.log(
      `Session saved to ${output}. Secret values were not displayed.`,
    );
    console.log("Use this file with fastboot-bridge.mjs.");
  } catch (error) {
    fail(error instanceof Error ? error.message : "Xiaomi login failed.");
  }
}

async function request(input, init = {}) {
  const response = await fetch(input, {
    ...init,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json,text/plain,*/*",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  return response;
}

async function requestFollowingRedirects(input, jar) {
  let current = String(input);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await request(current, {
      redirect: "manual",
      headers: jar.headers(),
    });
    jar.addFromHeaders(response.headers);
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current).toString();
  }
  throw new Error("Xiaomi callback redirected too many times.");
}

class CookieJar {
  #cookies = new Map();

  addFromHeaders(headers) {
    const lines =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : splitSetCookieHeader(headers.get("set-cookie") || "");
    for (const line of lines) {
      const match = line.match(/^\s*([^=;, ]+)=([^;]*)/);
      if (match) this.#cookies.set(match[1], decodeURIComponent(match[2]));
    }
  }

  get(name) {
    return this.#cookies.get(name) || "";
  }

  headers() {
    const value = [...this.#cookies]
      .filter(([, cookie]) => cookie)
      .map(([name, cookie]) => `${name}=${encodeURIComponent(cookie)}`)
      .join("; ");
    return value ? { Cookie: value } : {};
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline === undefined && key === "check-only") {
      parsed.checkOnly = true;
      continue;
    }
    parsed[toCamelCase(key)] = inline ?? values[index + 1] ?? "";
    if (inline === undefined) index++;
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseMiJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return {};
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return {};
  }
}

function splitSetCookieHeader(header) {
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractCookie(text, name) {
  const match = String(text).match(
    new RegExp(`${escapeRegExp(name)}=([^&;\\s"]+)`),
  );
  return match ? decodeURIComponent(match[1]) : "";
}

function md5Upper(value) {
  return createHash("md5").update(String(value)).digest("hex").toUpperCase();
}

function required(value, label) {
  if (!value) fail(`${label} was not returned.`);
  return String(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  throw new Error(message);
}

function printHelp() {
  console.log(`Usage:
  pnpm --filter @workspace/scripts run auth:session -- \\
    --device-id wb_your_device_id \\
    [--output ./session.json]

Runtime secrets:
  Username / XIAOMI_USERNAME
  Password / XIAOMI_PASSWORD

  Login-only check (does not write a session file):
  pnpm --filter @workspace/scripts run auth:session -- --check-only

The script reads secrets only at runtime, never prints them, and preserves
Xiaomi's official CAPTCHA and authorization checks.`);
}

run();
