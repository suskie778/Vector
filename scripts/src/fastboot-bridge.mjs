#!/usr/bin/env node
/**
 * Local bridge for the optimized unlock-mi-easier Worker.
 *
 * This script does not implement or bypass Xiaomi authorization. It only:
 *   1. reads the connected phone through fastboot;
 *   2. sends the official device token to the configured Worker;
 *   3. saves encryptData when Xiaomi authorizes the request;
 *   4. prints the final fastboot commands for the operator.
 *
 * The destructive `fastboot oem unlock` command is intentionally never
 * executed automatically because it wipes user data.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FASTBOOT_TIMEOUT_MS = 15_000;
const FASTBOOT_BIN = process.env["FASTBOOT_BIN"] || "fastboot";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

try {
  if (command === "devices") {
    await printDevices();
  } else if (command === "inspect") {
    await printDeviceInfo();
  } else if (command === "unlock") {
    if (
      args.help ||
      args.h ||
      args._[1] === "help" ||
      args._[1] === "--help" ||
      args._[1] === "-h"
    ) {
      printHelp();
      process.exit(0);
    }
    await prepareUnlock(args);
  } else {
    fail(`Unknown command "${command}". Run with "help" to see usage.`);
  }
} catch (error) {
  console.error(
    `[error] ${error instanceof Error ? error.message : "Unexpected bridge error."}`,
  );
  process.exitCode = 1;
}

async function prepareUnlock(options) {
  const workerUrl = requiredOption(
    options.workerUrl || process.env["XIAOMI_WORKER_URL"],
    "--worker-url or XIAOMI_WORKER_URL",
  ).replace(/\/+$/, "");
  const sessionFile = requiredOption(
    options.session,
    "--session path/to/session.json",
  );
  const region = options.region || "global";
  const output = options.output || "encryptData";
  const token = await readDeviceToken();
  const product = await readFastbootVar("product");
  const unlocked = await readFastbootVar("unlocked");

  if (!product) {
    fail(
      "Could not read the device product. Boot the phone into fastboot mode and check the USB connection.",
    );
  }
  if (String(unlocked).toLowerCase() === "yes") {
    console.log("Bootloader is already unlocked; no request was sent.");
    return;
  }
  if (!token) {
    fail(
      "Could not read the device token. Enable Mi Unlock status in Developer options and reconnect the phone.",
    );
  }

  const session = await readSessionFile(sessionFile);
  console.log(`Device product: ${product}`);
  console.log(`Device token: ${token.slice(0, 16)}...`);
  console.log(`Region: ${region}`);
  console.log("Checking Xiaomi account eligibility...");

  const userInfo = await workerRequest(workerUrl, "/api/userinfo", {
    session,
    region,
  });
  if (Number(userInfo?.code) !== 0) {
    printXiaomiResponse(
      "Xiaomi did not approve this account/device:",
      userInfo,
    );
    return;
  }

  console.log("Requesting authorized encryptData from Xiaomi...");
  const result = await workerRequest(workerUrl, "/api/unlock/download", {
    session,
    region,
    product,
    deviceToken: token,
  });

  if (result instanceof Uint8Array) {
    await writeFile(output, result);
    try {
      await chmod(output, 0o600);
    } catch {
      // Windows and some mounted filesystems do not support chmod.
    }
    console.log(`Saved authorized data to: ${output}`);
    console.log("");
    console.log("The final unlock step is destructive and wipes device data.");
    console.log("After checking the device and backing up your data, run:");
    console.log(`  fastboot stage ${output}`);
    console.log("  fastboot oem unlock");
    console.log("  fastboot reboot");
    return;
  }

  printXiaomiResponse("Xiaomi did not return encryptData:", result);
}

async function printDevices() {
  const result = await runFastboot(["devices"]);
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^finished\./i.test(line));

  if (lines.length === 0) {
    console.log("No fastboot devices detected.");
    console.log("Boot the phone with Volume Down + Power and connect USB.");
    return;
  }
  console.log(lines.join("\n"));
}

async function printDeviceInfo() {
  const [product, serialno, unlocked, token] = await Promise.all([
    readFastbootVar("product"),
    readFastbootVar("serialno"),
    readFastbootVar("unlocked"),
    readDeviceToken(),
  ]);

  console.log(
    JSON.stringify(
      {
        product,
        serialno,
        unlocked,
        deviceToken: token ? `${token.slice(0, 16)}...` : null,
      },
      null,
      2,
    ),
  );
}

async function readDeviceToken() {
  const result = await runFastboot(["oem", "get_identifier_token"]);
  const text = `${result.stdout}\n${result.stderr}`;
  const chunks = text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/\(bootloader\)\s*([0-9a-f]+)/i);
      return match ? match[1] : "";
    })
    .filter(Boolean);

  if (chunks.length > 0) return chunks.join("");
  return readFastbootVar("token");
}

async function readFastbootVar(name) {
  const result = await runFastboot(["getvar", name]);
  const text = `${result.stdout}\n${result.stderr}`;
  const expression = new RegExp(
    `(?:\\(bootloader\\)\\s*)?${escapeRegExp(name)}\\s*:\\s*(.+)`,
    "i",
  );
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(expression);
    if (match) return match[1].trim();
  }
  return "";
}

async function runFastboot(parameters) {
  try {
    return await execFileAsync(FASTBOOT_BIN, parameters, {
      timeout: FASTBOOT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "";
    if (details.includes("ENOENT")) {
      throw new Error(
        `fastboot was not found. Install Android Platform Tools, add it to PATH, or set FASTBOOT_BIN. Current value: ${FASTBOOT_BIN}`,
      );
    }
    return {
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || ""),
    };
  }
}

async function readSessionFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read session JSON file: ${path}`);
  }
  const session = parsed?.session || parsed;
  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session) ||
    !session.userId ||
    !session.deviceId ||
    !session.ssecurity ||
    !session.cookies?.serviceToken
  ) {
    throw new Error(
      "Session JSON must contain userId, deviceId, ssecurity, and cookies.serviceToken.",
    );
  }
  return session;
}

async function workerRequest(workerUrl, path, body) {
  const headers = { "Content-Type": "application/json" };
  const workerToken = process.env["XIAOMI_WORKER_TOKEN"];
  if (workerToken) headers.Authorization = `Bearer ${workerToken}`;

  let response;
  try {
    response = await fetch(`${workerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(
      "Could not reach the Worker. Check --worker-url, network access, and the Worker health endpoint.",
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/octet-stream")) {
    return new Uint8Array(await response.arrayBuffer());
  }

  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      `Worker returned HTTP ${response.status} with an invalid response.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      value?.message || `Worker returned HTTP ${response.status}.`,
    );
  }
  return value;
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--") {
      parsed._.push(...values.slice(index + 1));
      break;
    }
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) {
      parsed[toCamelCase(key)] = inline;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[toCamelCase(key)] = values[++index];
    } else {
      parsed[toCamelCase(key)] = true;
    }
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function requiredOption(value, label) {
  if (!value || value === true) fail(`Missing ${label}.`);
  return String(value);
}

function printXiaomiResponse(prefix, value) {
  console.error(prefix);
  console.error(JSON.stringify(value, null, 2));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  throw new Error(message);
}

function printHelp() {
  console.log(`Usage:
  node scripts/src/fastboot-bridge.mjs devices
  node scripts/src/fastboot-bridge.mjs inspect
  node scripts/src/fastboot-bridge.mjs unlock \\
    --worker-url https://your-worker.example \\
    --session ./session.json \\
    [--region global] [--output encryptData]

Environment:
  XIAOMI_WORKER_URL    Default Worker URL.
  XIAOMI_WORKER_TOKEN  Optional Worker authorization token.

The session file must be the session object returned by POST /api/session,
or the full JSON response containing its "session" property.

The script never runs "fastboot oem unlock" automatically because that command
wipes the phone. It prints the commands after Xiaomi returns encryptData.`);
}
