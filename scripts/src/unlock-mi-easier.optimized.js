/**
 * Optimized drop-in version of the public unlock-mi-easier Cloudflare Worker.
 *
 * Performance changes:
 * - Reuses TextEncoder/TextDecoder instances.
 * - Imports the HMAC key once per isolate and the AES key once per request.
 * - Encrypts request parameters concurrently after the signed input is ready.
 * - Reuses the MD5 result for repeated calls made with the same device ID.
 * - Applies a bounded timeout to outbound Xiaomi requests.
 *
 * The endpoint contract and Xiaomi authorization flow are intentionally
 * unchanged. This file does not accept passwords, bypass waiting periods,
 * skip account/device checks, or communicate with a phone over USB.
 */

const VERSION = "2.1.0";
const USER_AGENT = "XiaomiPCSuite APP/006 MiUnlockTool/7.6.727.43";
const SERVICE_LOGIN = "https://account.xiaomi.com/pass/serviceLogin";
const OUTBOUND_TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IV = textBytes("0102030405060708");
const SIGN_KEY = textBytes(
  "2tBeoEyJTunmWUGq7bQH2Abn0k2NhhurOaqBfyxCuLVgn4AVj7swcawe53uDUno",
);

const REGIONS = Object.freeze({
  cn: "https://unlock.update.miui.com",
  eu: "https://eu-unlock.update.intl.miui.com",
  in: "https://in-unlock.update.intl.miui.com",
  ru: "https://ru-unlock.update.intl.miui.com",
  global: "https://unlock.update.intl.miui.com",
});

const ERROR_MESSAGES = {
  20030: "Xiaomi requires at least 30 days between device unlocks.",
  20031:
    "Link this account and device in Developer options > Mi Unlock status.",
  20036: "Xiaomi requires more waiting time before this account can unlock.",
  20037: "This Xiaomi account has reached its unlock limit.",
  20040: "The device has not been used for the minimum required period.",
  30002:
    "Xiaomi requires authorization through Mi Community for this account/device.",
  87001: "Xiaomi requires browser verification or CAPTCHA completion.",
};

let signKeyPromise;
const md5Cache = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const path = cleanPath(new URL(request.url).pathname);
    if (path === "/" || path === "/health") {
      return json(
        {
          ok: true,
          name: "unlock-mi-easier",
          version: VERSION,
          message:
            "HTTPS API ready. A local computer is still required for fastboot.",
        },
        200,
        cors,
      );
    }

    if (!path.startsWith("/api/")) {
      return json({ error: "not_found" }, 404, cors);
    }

    if (!authorized(request, env)) {
      return json(
        { error: "unauthorized", message: "Missing or invalid Worker token." },
        401,
        cors,
      );
    }

    try {
      if (request.method === "GET" && path === "/api/docs") {
        return json(docs(request.url), 200, cors);
      }
      if (request.method !== "POST") {
        return json(
          {
            error: "method_not_allowed",
            message: "Use POST for this endpoint.",
          },
          405,
          cors,
        );
      }

      const body = await readJson(request);
      if (path === "/api/session") {
        return json(await createSession(body), 200, cors);
      }

      if (path === "/api/userinfo") {
        const session = normalizeSession(body.session || body);
        const result = await signedRequest(
          regionBase(body.region),
          "/api/v3/unlock/userinfo",
          {
            appId: "1",
            data: {
              clientId: "2",
              clientVersion: "7.6.727.43",
              language: "en",
              pcId: await md5Hex(session.deviceId),
              region: "",
              uid: session.userId,
            },
          },
          session,
        );
        return json(withErrorHint(result), 200, cors);
      }

      if (path === "/api/nonce") {
        const session = normalizeSession(body.session || body);
        const result = await signedRequest(
          regionBase(body.region),
          "/api/v2/nonce",
          { r: randomLetters(16) },
          session,
        );
        return json(withErrorHint(result), 200, cors);
      }

      if (path === "/api/clear") {
        const session = normalizeSession(body.session || body);
        const product = requiredString(body.product, "product", 96);
        const nonce =
          optionalString(body.nonce, 128) ||
          (await getNonce(session, body.region));
        const result = await signedRequest(
          regionBase(body.region),
          "/api/v2/unlock/device/clear",
          { appId: "1", data: { product }, nonce },
          session,
        );
        return json(withErrorHint(result), 200, cors);
      }

      if (path === "/api/unlock" || path === "/api/unlock/download") {
        const session = normalizeSession(body.session || body);
        const deviceToken = requiredString(
          body.deviceToken,
          "deviceToken",
          4096,
        );
        const product = requiredString(body.product, "product", 96);
        const deviceInfo =
          path === "/api/unlock"
            ? {
                boardVersion:
                  optionalString(body.deviceInfo?.boardVersion, 128) || "",
                deviceName:
                  optionalString(body.deviceInfo?.deviceName, 128) || "",
                product,
                socId: optionalString(body.deviceInfo?.socId, 256) || "",
              }
            : {
                boardVersion: "",
                deviceName: "",
                product,
                socId: "",
              };
        const nonce =
          optionalString(body.nonce, 128) ||
          (await getNonce(session, body.region));
        const result = await signedRequest(
          regionBase(body.region),
          "/api/v3/ahaUnlock",
          {
            appId: "1",
            data: {
              clientId: "2",
              clientVersion: "7.6.727.43",
              deviceInfo,
              deviceToken,
              language: "en",
              operate: "unlock",
              pcId: await md5Hex(session.deviceId),
              region: "",
              uid: session.userId,
            },
            nonce,
          },
          session,
        );

        if (path === "/api/unlock") {
          return json(withErrorHint(result), 200, cors);
        }
        if (
          Number(result?.code) !== 0 ||
          !/^[0-9a-f]+$/i.test(result?.encryptData || "")
        ) {
          return json(withErrorHint(result), 200, cors);
        }

        const headers = new Headers(cors);
        headers.set("Content-Type", "application/octet-stream");
        headers.set(
          "Content-Disposition",
          'attachment; filename="encryptData"',
        );
        headers.set("Cache-Control", "no-store");
        return new Response(hexToBytes(result.encryptData), {
          status: 200,
          headers,
        });
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (error) {
      return json(
        { error: errorCode(error), message: safeMessage(error) },
        statusFor(error),
        cors,
      );
    }
  },
};

function cleanPath(path) {
  const value = path.replace(/\/+/g, "/").replace(/\/$/, "");
  return value || "/";
}

function corsHeaders(origin, env) {
  const configured = String(env?.CORS_ORIGIN || "*").trim();
  return {
    "Access-Control-Allow-Origin":
      configured === "*" || !origin || configured === origin
        ? configured
        : configured,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function authorized(request, env) {
  const expected = String(env?.WORKER_AUTH_TOKEN || "").trim();
  if (!expected) return true;
  return request.headers.get("Authorization") === `Bearer ${expected}`;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 128 * 1024) {
    throw httpError(413, "payload_too_large", "Request body is too large.");
  }
  let body;
  try {
    body = await request.json();
  } catch {
    throw httpError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return body;
}

async function createSession(body) {
  if ("password" in body || "passwd" in body || "hash" in body) {
    throw httpError(
      400,
      "password_not_supported",
      "Do not send Xiaomi passwords to this Worker. Log in through Xiaomi's official browser flow and send passToken instead.",
    );
  }

  const userId = requiredString(body.userId, "userId", 256);
  const passToken = requiredString(body.passToken, "passToken", 4096);
  const deviceId = requiredString(body.deviceId, "deviceId", 256);
  const sid = optionalString(body.sid, 64) || "unlockApi";
  const cookie = `userId=${cookieValue(userId)}; passToken=${cookieValue(passToken)}; deviceId=${cookieValue(deviceId)}`;
  const firstUrl = new URL(SERVICE_LOGIN);
  firstUrl.searchParams.set("sid", sid);
  firstUrl.searchParams.set("_json", "true");
  firstUrl.searchParams.set("checkSafeAddress", "true");

  const requestHeaders = {
    Cookie: cookie,
    "User-Agent": USER_AGENT,
    Accept: "application/json,text/plain,*/*",
  };
  let first;
  try {
    first = await timedFetch(firstUrl, { headers: requestHeaders });
  } catch {
    throw httpError(502, "xiaomi_network_error", "Could not reach Xiaomi.");
  }
  const service = parseMiJson(await first.text());
  if (!first.ok || Number(service?.code) !== 0) {
    throw httpError(
      401,
      "xiaomi_service_login_failed",
      xiaomiMessage(service) || "Xiaomi rejected the browser session.",
      service,
    );
  }

  const nonce = requiredString(service.nonce, "service nonce", 256);
  const ssecurity = requiredString(service.ssecurity, "ssecurity", 256);
  const location = requiredString(service.location, "service location", 4096);
  const clientSign = encodeURIComponent(
    bytesToBase64(await sha1(textBytes(`nonce=${nonce}&${ssecurity}`))),
  );
  const callbackUrl = `${location}${location.includes("?") ? "&" : "?"}clientSign=${clientSign}`;

  let callback;
  try {
    callback = await timedFetch(callbackUrl, {
      redirect: "follow",
      headers: requestHeaders,
    });
  } catch {
    throw httpError(502, "xiaomi_network_error", "Could not reach Xiaomi.");
  }
  const callbackText = await callback.text();
  const callbackCookies = parseSetCookies(callback.headers);
  const serviceToken =
    callbackCookies.serviceToken ||
    extractCookie(callbackText, "serviceToken") ||
    "";
  if (!callback.ok || !serviceToken) {
    throw httpError(
      401,
      "xiaomi_service_token_missing",
      "Xiaomi did not return a serviceToken. Re-run the official browser login and try again.",
    );
  }

  return {
    ok: true,
    session: {
      userId,
      deviceId,
      ssecurity,
      cookies: {
        userId,
        serviceToken,
        ...(callbackCookies.unlockApi_slh
          ? { unlockApi_slh: callbackCookies.unlockApi_slh }
          : {}),
        ...(callbackCookies.unlockApi_ph
          ? { unlockApi_ph: callbackCookies.unlockApi_ph }
          : {}),
      },
    },
    note: "Keep this session private. It contains live Xiaomi authorization cookies.",
  };
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") {
    throw httpError(400, "session_required", "A session object is required.");
  }
  if ("password" in value || "passwd" in value) {
    throw httpError(
      400,
      "password_not_supported",
      "This Worker never accepts Xiaomi passwords.",
    );
  }

  const userId = requiredString(value.userId, "session.userId", 256);
  const deviceId = requiredString(value.deviceId, "session.deviceId", 256);
  const ssecurity = requiredString(value.ssecurity, "session.ssecurity", 256);
  const cookies = value.cookies;
  if (!cookies || typeof cookies !== "object" || Array.isArray(cookies)) {
    throw httpError(
      400,
      "cookies_required",
      "session.cookies must contain the Xiaomi serviceToken.",
    );
  }

  const safeCookies = {};
  for (const name of [
    "userId",
    "serviceToken",
    "unlockApi_slh",
    "unlockApi_ph",
  ]) {
    const token = optionalString(cookies[name], 8192);
    if (token) safeCookies[name] = token;
  }
  if (!safeCookies.serviceToken) {
    throw httpError(
      400,
      "service_token_required",
      "session.cookies.serviceToken is required.",
    );
  }
  return {
    userId,
    deviceId,
    ssecurity,
    keyBytes: decodeBase64(ssecurity),
    cookies: safeCookies,
  };
}

async function getNonce(session, region) {
  const result = await signedRequest(
    regionBase(region),
    "/api/v2/nonce",
    { r: randomLetters(16) },
    session,
  );
  if (Number(result?.code) !== 0 || !result.nonce) {
    throw httpError(
      502,
      "nonce_failed",
      xiaomiMessage(result) || "Xiaomi did not return a nonce.",
      result,
    );
  }
  return String(result.nonce);
}

async function signedRequest(base, path, rawParams, session) {
  const params = { ...rawParams, sid: "miui_unlocktool_client" };
  if (params.data !== undefined) {
    params.data = bytesToBase64(textBytes(JSON.stringify(params.data)));
  }

  const names = Object.keys(params).sort();
  const signParams = names
    .map((name) => `${name}=${String(params[name])}`)
    .join("&");
  const signText = `POST\n${path}\n${signParams}`;
  const signHash = bytesToHex(
    await hmacSha1(SIGN_KEY, textBytes(signText)),
  ).toLowerCase();
  const key = await importAesKey(session.keyBytes);

  // These encryptions are independent. Promise.all removes avoidable
  // per-parameter Web Crypto scheduling overhead while preserving order.
  const [encryptedSign, ...encryptedParams] = await Promise.all([
    aesCbcEncryptWithKey(textBytes(signHash), key),
    ...names.map((name) =>
      aesCbcEncryptWithKey(textBytes(String(params[name])), key),
    ),
  ]);
  const encodedParams = names.map(
    (name, index) => `${name}=${bytesToBase64(encryptedParams[index])}`,
  );

  const signatureText = `POST&${path}&${encodedParams.join("&")}&${session.ssecurity}`;
  const signature = bytesToBase64(await sha1(textBytes(signatureText)));
  const postParams = new URLSearchParams();
  for (let index = 0; index < names.length; index++) {
    postParams.set(names[index], bytesToBase64(encryptedParams[index]));
  }
  postParams.set("sign", bytesToBase64(encryptedSign));
  postParams.set("signature", signature);

  let response;
  try {
    response = await timedFetch(`${base}${path}?${postParams.toString()}`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader(session.cookies),
        "User-Agent": USER_AGENT,
        Accept: "*/*",
      },
    });
  } catch {
    throw httpError(502, "xiaomi_network_error", "Could not reach Xiaomi.");
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw httpError(
      502,
      "xiaomi_http_error",
      `Xiaomi returned HTTP ${response.status}.`,
    );
  }

  try {
    const decrypted = await aesCbcDecryptWithKey(
      decodeBase64(responseText.trim()),
      key,
    );
    return JSON.parse(textFromBytes(decodeBase64(textFromBytes(decrypted))));
  } catch {
    const plain = parseMiJson(responseText);
    if (plain && typeof plain === "object") return plain;
    throw httpError(
      502,
      "xiaomi_response_error",
      "Xiaomi returned a response the Worker could not decrypt.",
    );
  }
}

function regionBase(region) {
  const key = String(region || "global")
    .trim()
    .toLowerCase();
  if (!REGIONS[key]) {
    throw httpError(
      400,
      "invalid_region",
      `Region must be one of: ${Object.keys(REGIONS).join(", ")}.`,
    );
  }
  return REGIONS[key];
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${cookieValue(value)}`)
    .join("; ");
}

function cookieValue(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

function parseSetCookies(headers) {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get("Set-Cookie") || "");
  const result = {};
  for (const line of values) {
    const match = line.match(/^\s*([^=;, ]+)=([^;]*)/);
    if (match) result[match[1]] = decodeURIComponent(match[2]);
  }
  return result;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMiJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

function xiaomiMessage(value) {
  if (!value || typeof value !== "object") return "";
  const code = Number(value.code);
  return (
    ERROR_MESSAGES[code] ||
    value.descEN ||
    value.description ||
    value.desc ||
    value.notice ||
    ""
  );
}

function withErrorHint(result) {
  if (!result || typeof result !== "object") return result;
  if (Number(result.code) !== 0) {
    return {
      ...result,
      workerHint: xiaomiMessage(result) || "Xiaomi rejected the request.",
    };
  }
  return result;
}

function docs(workerUrl) {
  return {
    name: "unlock-mi-easier",
    version: VERSION,
    warning:
      "This follows Xiaomi's official unlock authorization flow. It does not bypass waiting periods and cannot unlock a phone without local fastboot.",
    endpoints: {
      "POST /api/session": {
        body: { userId: "...", passToken: "...", deviceId: "wb_..." },
        returns: "A short-lived Xiaomi service session.",
      },
      "POST /api/userinfo": {
        body: { session: "session object", region: "global" },
        returns: "Xiaomi account eligibility response.",
      },
      "POST /api/clear": {
        body: {
          session: "session object",
          region: "global",
          product: "device codename",
        },
        returns: "Xiaomi notice and whether data will be wiped.",
      },
      "POST /api/unlock": {
        body: {
          session: "session object",
          region: "global",
          product: "device codename",
          deviceToken: "output of fastboot getvar token",
        },
        returns: "Xiaomi response containing encryptData on success.",
      },
      "POST /api/unlock/download": {
        body: {
          session: "session object",
          region: "global",
          product: "device codename",
          deviceToken: "output of fastboot getvar token",
        },
        returns: "Binary encryptData file on success.",
      },
    },
    fastboot: ["fastboot stage encryptData", "fastboot oem unlock"],
    baseUrl: workerUrl,
  };
}

function requiredString(value, label, maxLength) {
  const result = optionalString(value, maxLength);
  if (!result) throw httpError(400, "missing_field", `${label} is required.`);
  return result;
}

function optionalString(value, maxLength) {
  if (typeof value !== "string") return "";
  const result = value.trim();
  if (result.length > maxLength) {
    throw httpError(400, "field_too_large", "A request field is too large.");
  }
  return result;
}

function randomLetters(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) =>
    String.fromCharCode(97 + (value % 26)),
  ).join("");
}

function textBytes(value) {
  return encoder.encode(String(value));
}

function textFromBytes(value) {
  return decoder.decode(value);
}

function bytesToBase64(bytes) {
  let value = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(value);
}

function decodeBase64(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) {
    throw new Error("invalid hex");
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index++) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

async function importAesKey(keyBytes) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function aesCbcEncryptWithKey(value, key) {
  return crypto.subtle
    .encrypt({ name: "AES-CBC", iv: IV }, key, value)
    .then((result) => new Uint8Array(result));
}

function aesCbcDecryptWithKey(value, key) {
  return crypto.subtle
    .decrypt({ name: "AES-CBC", iv: IV }, key, value)
    .then((result) => new Uint8Array(result));
}

async function sha1(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", value));
}

async function hmacSha1(keyBytes, value) {
  signKeyPromise ||= crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const key = await signKeyPromise;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
}

async function md5Hex(value) {
  const input = String(value);
  const cached = md5Cache.get(input);
  if (cached) return cached;
  const result = md5(textBytes(input));
  if (md5Cache.size >= 256) md5Cache.delete(md5Cache.keys().next().value);
  md5Cache.set(input, result);
  return result;
}

// Web Crypto does not expose MD5, but Xiaomi's pcId field still requires it.
function md5(input) {
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const constants = Array.from(
    { length: 64 },
    (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0,
  );
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index++) {
      let f;
      let g;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const next = d;
      d = c;
      c = b;
      const sum = (a + f + constants[index] + words[g]) >>> 0;
      b = (b + ((sum << shifts[index]) | (sum >>> (32 - shifts[index])))) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const result = new Uint8Array(16);
  const output = new DataView(result.buffer);
  output.setUint32(0, a0, true);
  output.setUint32(4, b0, true);
  output.setUint32(8, c0, true);
  output.setUint32(12, d0, true);
  return bytesToHex(result);
}

async function timedFetch(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(error) {
  return error?.code || "worker_error";
}

function statusFor(error) {
  const status = Number(error?.status);
  return status >= 400 && status <= 599 ? status : 500;
}

function safeMessage(error) {
  return error instanceof Error ? error.message : "Unexpected Worker error.";
}

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details && typeof details === "object") error.details = details;
  return error;
}

function json(value, status, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}
