"""
Google Colab smoke test for the official Xiaomi unlock flow.

This script:
  1. asks for Xiaomi email/username and password without echoing the password;
  2. logs in through Xiaomi's official account endpoint;
  3. sends only userId/passToken/deviceId to the configured Worker;
  4. checks /api/userinfo;
  5. optionally requests encryptData when the operator supplies product and
     deviceToken from a real fastboot device.

It never prints passwords, passToken, serviceToken, ssecurity, or cookies.
It never runs fastboot oem unlock and does not bypass Xiaomi authorization,
CAPTCHA, account linking, or waiting periods.
"""

import getpass
import hashlib
import html
import json
import re
import sys
import time
from pathlib import Path

import requests


ACCOUNT_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLoginAuth2"
ACCOUNT_SERVICE_URL = "https://account.xiaomi.com/pass/serviceLogin"
SERVICE_SID = "unlockApi"
USER_AGENT = "XiaomiPCSuite APP/006 miflash_unlock/6.5.224.28"
TIMEOUT_SECONDS = 30


def parse_mi_json(text):
    """Parse Xiaomi's JSON, which may be wrapped in &&&START&&& markers."""
    raw = str(text or "")
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        return {}
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return {}


def safe_message(value):
    if not isinstance(value, dict):
        return ""
    return (
        value.get("descEN")
        or value.get("description")
        or value.get("desc")
        or value.get("notice")
        or ""
    )


def login_failure_hint(code, login, challenge):
    """Explain a login rejection without exposing Xiaomi's raw response."""
    if login.get("captchaUrl") or challenge.get("captchaUrl"):
        return "Xiaomi طلب CAPTCHA أو تحققاً من المتصفح الرسمي."
    if code in {70016, 70002, 70003}:
        return (
            "Xiaomi رفض بيانات تسجيل الدخول أو جلسة الطلب. "
            "تحقق أولاً من تسجيل الدخول عبر account.xiaomi.com؛ "
            "إذا نجح المتصفح وفشل Colab فالحساب يتطلب تدفق المتصفح الرسمي."
        )
    return "Xiaomi رفض الطلب؛ استخدم رسالة Xiaomi الظاهرة للتحقق من السبب."


def md5_upper(value):
    return hashlib.md5(value.encode("utf-8")).hexdigest().upper()


def redact(value):
    """Redact live credentials/tokens before anything is printed."""
    sensitive_words = (
        "password",
        "passwd",
        "token",
        "ssecurity",
        "cookie",
        "pass",
        "secret",
        "encrypt",
        "device",
    )
    if isinstance(value, dict):
        return {
            key: "[REDACTED]"
            if any(word in str(key).lower() for word in sensitive_words)
            else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def post_worker(worker_url, path, payload, worker_token=""):
    headers = {"Content-Type": "application/json"}
    if worker_token:
        headers["Authorization"] = f"Bearer {worker_token}"
    response = requests.post(
        f"{worker_url.rstrip('/')}{path}",
        headers=headers,
        json=payload,
        timeout=TIMEOUT_SECONDS,
    )
    content_type = response.headers.get("content-type", "").lower()
    if "application/octet-stream" in content_type:
        return response, response.content
    try:
        body = response.json()
    except ValueError:
        raise RuntimeError(
            f"Worker returned HTTP {response.status_code} with invalid JSON."
        ) from None
    if not response.ok:
        raise RuntimeError(
            body.get("message") or f"Worker returned HTTP {response.status_code}."
        )
    return response, body


def login_to_xiaomi(username, password, verification_attempts=2):
    """Return only the non-password login fields needed by /api/session."""
    browser = requests.Session()
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json,text/plain,*/*",
    }

    for attempt in range(verification_attempts + 1):
        challenge_url = (
            f"{ACCOUNT_SERVICE_URL}?sid={SERVICE_SID}"
            "&_json=true&checkSafeAddress=true"
        )
        challenge_response = browser.get(
            challenge_url, headers=headers, timeout=TIMEOUT_SECONDS
        )
        challenge = parse_mi_json(challenge_response.text)
        sign = challenge.get("_sign")
        if not sign:
            raise RuntimeError(
                "Xiaomi did not return a login challenge. Browser verification may be required."
            )
        challenge_qs = challenge.get("qs", "")
        challenge_callback = challenge.get(
            "callback", "https://unlock.update.miui.com/sts"
        )
        challenge_service_param = challenge.get(
            "serviceParam", '{"checkSafePhone":false}'
        )

        login_body = {
            "_json": "true",
            "sid": challenge.get("sid") or SERVICE_SID,
            "qs": challenge_qs,
            "serviceParam": challenge_service_param,
            "user": username,
            "hash": md5_upper(password),
            "_sign": sign,
            "callback": challenge_callback,
        }
        login_response = browser.post(
            ACCOUNT_LOGIN_URL,
            data=login_body,
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            timeout=TIMEOUT_SECONDS,
        )
        login = parse_mi_json(login_response.text)
        try:
            login_code = int(login.get("code", -1))
        except (TypeError, ValueError):
            login_code = -1
        if login_code != 0:
            code = login.get("code", "unknown")
            hint = safe_message(login)
            diagnosis = login_failure_hint(login_code, login, challenge)
            diagnostics = (
                f"captcha={bool(login.get('captchaUrl'))}, "
                f"passToken={bool(login.get('passToken'))}, "
                f"ssecurity={bool(login.get('ssecurity'))}, "
                f"callback={bool(login.get('location'))}"
            )
            raise RuntimeError(
                f"Xiaomi login rejected (code {code}). {hint} "
                f"{diagnosis} [{diagnostics}]".strip()
            )
        if login.get("notificationUrl"):
            if attempt >= verification_attempts:
                raise RuntimeError(
                    "Xiaomi still requires account verification after the allowed retries."
                )
            verification_url = str(login["notificationUrl"])
            print(
                "\nXiaomi accepted the credentials but requires official verification."
            )
            print(
                "Complete every step until Xiaomi shows a success/finished message. "
                "Opening the page alone is not enough."
            )
            print("The URL is temporary and sensitive; do not copy or share it.")
            open_colab_verification(verification_url)
            input(
                "\nAfter the Xiaomi page explicitly says verification is complete, "
                "close that tab and press Enter to retry login..."
            )
            time.sleep(2)
            continue

        required = ("userId", "passToken")
        missing = [key for key in required if not login.get(key)]
        if missing:
            raise RuntimeError(
                f"Xiaomi login response is missing: {', '.join(missing)}."
            )

        # Keep ssecurity/location in memory only as diagnostic presence checks.
        return {
            "userId": str(login["userId"]),
            "passToken": str(login["passToken"]),
            "has_ssecurity": bool(login.get("ssecurity")),
            "has_callback": bool(login.get("location")),
        }

    raise RuntimeError("Xiaomi verification flow did not complete.")


def open_colab_verification(url):
    """Open Xiaomi's official verification page in the user's Colab browser."""
    try:
        from IPython.display import HTML, Javascript, display

        safe_url = html.escape(url, quote=True)
        display(
            HTML(
                '<p><a href="'
                f"{safe_url}"
                '" target="_blank" rel="noreferrer">'
                "Open Xiaomi verification in a new browser tab</a></p>"
            )
        )
        display(Javascript(f"window.open({json.dumps(url)}, '_blank');"))
        print("A browser tab was opened. If it was blocked, click the link above.")
    except Exception:
        print("Open this URL manually in the same browser where Xiaomi is signed in:")
        print(url)


def print_userinfo(result):
    if not isinstance(result, dict):
        print("userinfo returned a non-JSON response.")
        return
    print("userinfo response (sensitive fields redacted):")
    print(json.dumps(redact(result), ensure_ascii=False, indent=2))


def main():
    print("Xiaomi official-flow test for Google Colab")
    print("Password and tokens are never printed or saved by this script.")
    print()

    username = input("Xiaomi email/username: ").strip()
    password = getpass.getpass("Xiaomi password (hidden): ")
    if not username or not password:
        raise RuntimeError("Username and password are required.")

    worker_url = input(
        "Worker URL (leave empty to test Xiaomi login only): "
    ).strip()
    if not worker_url:
        login = login_to_xiaomi(username, password)
        print("Xiaomi account login succeeded.")
        print(f"userId received: {bool(login['userId'])}")
        print(f"passToken received: {bool(login['passToken'])}")
        print(f"ssecurity received: {login['has_ssecurity']}")
        print(f"callback received: {login['has_callback']}")
        return

    device_id = input(
        "Xiaomi browser/device id (usually starts with wb_): "
    ).strip()
    region = input("Region [global]: ").strip() or "global"
    worker_token = getpass.getpass(
        "Worker auth token (hidden, leave empty if not configured): "
    )
    if not device_id:
        raise RuntimeError("deviceId is required when testing the Worker.")

    login = login_to_xiaomi(username, password)
    print("Xiaomi account login succeeded; password was not sent to the Worker.")

    _, session_body = post_worker(
        worker_url,
        "/api/session",
        {
            "userId": login["userId"],
            "passToken": login["passToken"],
            "deviceId": device_id,
        },
        worker_token,
    )
    session = session_body.get("session") if isinstance(session_body, dict) else None
    if not isinstance(session, dict):
        raise RuntimeError(
            "Worker /api/session did not return a session object. "
            "The response was redacted below."
        )
    print("Worker /api/session succeeded; live session values stay in memory.")

    _, userinfo = post_worker(
        worker_url,
        "/api/userinfo",
        {"session": session, "region": region},
        worker_token,
    )
    print_userinfo(userinfo)

    product = input(
        "Device product/codename (leave empty to stop after userinfo): "
    ).strip()
    device_token = getpass.getpass(
        "Fastboot device token (hidden, leave empty to stop): "
    ).strip()
    if not product or not device_token:
        print("Stopped after account eligibility check. No unlock request was sent.")
        return

    confirm = input(
        "Send the official unlock authorization request now? [y/N]: "
    ).strip().lower()
    if confirm != "y":
        print("No unlock request was sent.")
        return

    _, unlock_result = post_worker(
        worker_url,
        "/api/unlock",
        {
            "session": session,
            "region": region,
            "product": product,
            "deviceToken": device_token,
        },
        worker_token,
    )
    if isinstance(unlock_result, dict) and unlock_result.get("encryptData"):
        encrypt_data = str(unlock_result["encryptData"])
        if not re.fullmatch(r"[0-9a-fA-F]+", encrypt_data):
            raise RuntimeError("Worker returned invalid encryptData.")
        output = Path("/content/encryptData")
        output.write_bytes(bytes.fromhex(encrypt_data))
        print(f"Authorized encryptData saved to {output}.")
        print("This script did not run fastboot or erase the phone.")
    else:
        print("Xiaomi did not authorize the unlock request:")
        print(json.dumps(redact(unlock_result), ensure_ascii=False, indent=2))


def run_colab():
    """Run without sys.exit so Colab does not generate a secondary traceback."""
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
    except (requests.RequestException, RuntimeError) as error:
        print(f"\n[ERROR] {error}", file=sys.stderr)


if __name__ == "__main__":
    run_colab()