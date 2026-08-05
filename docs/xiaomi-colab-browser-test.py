"""
Interactive Google Colab test using a Chromium browser inside the Colab VM.

Run the installation cell from xiaomi-colab-browser-test-ar.md first.
The browser and its Xiaomi cookies stay inside the same Colab runtime, so
verification is not split between a local browser and requests.Session().

This uses Xiaomi's normal web login and leaves any CAPTCHA/2FA/account
verification to the user. It never prints or saves password/token values,
never bypasses Xiaomi authorization, and never runs fastboot.
"""

import getpass
import json
import hashlib
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests


TIMEOUT_SECONDS = 30
SERVICE_URL = "https://account.xiaomi.com/pass/serviceLogin"
AUTH_URL = "https://account.xiaomi.com/pass/serviceLoginAuth2"
SERVICE_SID = "unlockApi"
USER_AGENT = "XiaomiPCSuite APP/006 miflash_unlock/6.5.224.28"


def redact(value):
    sensitive = (
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
            if any(part in str(key).lower() for part in sensitive)
            else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def start_browser_stack():
    required = ("Xvfb", "x11vnc")
    missing = [name for name in required if not shutil_which(name)]
    if missing:
        raise RuntimeError(
            "Missing browser tools: "
            + ", ".join(missing)
            + ". In Colab run: !apt-get update -qq && "
            + "!apt-get install -y -qq x11vnc, then rerun this cell."
        )
    websockify_command = find_websockify_command()
    if not websockify_command:
        raise RuntimeError(
            "Missing websockify. Run the installation cell from the accompanying "
            "guide first, including: pip install -q websockify."
        )

    display = ":99"
    os.environ["DISPLAY"] = display
    subprocess.Popen(
        ["Xvfb", display, "-screen", "0", "1365x900x24", "-ac"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)
    subprocess.Popen(
        [
            "x11vnc",
            "-display",
            display,
            "-rfbport",
            "5900",
            "-localhost",
            "-nopw",
            "-forever",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)
    novnc_root = "/usr/share/novnc"
    if not Path(novnc_root).exists():
        novnc_root = "/usr/share/novnc/utils"
    subprocess.Popen(
        [
            *websockify_command,
            "--web",
            novnc_root,
            "6080",
            "localhost:5900",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)
    try:
        from google.colab import output

        output.serve_kernel_port_as_iframe(6080, height=760)
        print("The Chromium desktop is shown above. Keep it open during verification.")
    except Exception:
        print("Open the Colab port 6080 preview to use the Chromium desktop.")
    return display


def shutil_which(name):
    result = subprocess.run(
        ["bash", "-lc", f"command -v {name}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or None


def find_websockify_command():
    executable = shutil_which("websockify")
    if executable:
        return [executable]
    probe = subprocess.run(
        [sys.executable, "-c", "import websockify"],
        capture_output=True,
        check=False,
    )
    return [sys.executable, "-m", "websockify"] if probe.returncode == 0 else None


def create_driver(display):
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
    except ImportError as error:
        raise RuntimeError(
            "Selenium is not installed. Run: pip install -q selenium"
        ) from error

    options = Options()
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1365,900")
    options.add_argument("--lang=en-US")
    options.add_argument("--user-data-dir=/tmp/xiaomi-colab-chrome")
    options.binary_location = (
        shutil_which("chromium")
        or shutil_which("chromium-browser")
        or shutil_which("google-chrome")
    )
    if not options.binary_location:
        raise RuntimeError("Chromium was not found after installation.")

    driver_path = shutil_which("chromedriver")
    if not driver_path:
        raise RuntimeError("chromedriver was not found after installation.")
    os.environ["DISPLAY"] = display
    return webdriver.Chrome(service=Service(driver_path), options=options)


def parse_mi_json(text):
    raw = str(text or "")
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        return {}
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return {}


def md5_upper(value):
    return hashlib.md5(value.encode("utf-8")).hexdigest().upper()


def xiaomi_login(session, username, password):
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json,text/plain,*/*",
    }
    challenge_response = session.get(
        SERVICE_URL,
        params={
            "sid": SERVICE_SID,
            "_json": "true",
            "checkSafeAddress": "true",
        },
        headers=headers,
        timeout=TIMEOUT_SECONDS,
    )
    challenge = parse_mi_json(challenge_response.text)
    sign = challenge.get("_sign")
    if not sign:
        raise RuntimeError("Xiaomi did not return a login challenge.")

    response = session.post(
        AUTH_URL,
        data={
            "_json": "true",
            "sid": challenge.get("sid") or SERVICE_SID,
            "qs": challenge.get("qs") or "",
            "serviceParam": challenge.get(
                "serviceParam", '{"checkSafePhone":false}'
            ),
            "user": username,
            "hash": md5_upper(password),
            "_sign": sign,
            "callback": challenge.get(
                "callback", "https://unlock.update.miui.com/sts"
            ),
        },
        headers={
            **headers,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout=TIMEOUT_SECONDS,
    )
    login = parse_mi_json(response.text)
    try:
        code = int(login.get("code", -1))
    except (TypeError, ValueError):
        code = -1
    if code != 0:
        raise RuntimeError(
            f"Xiaomi login rejected (code {login.get('code', 'unknown')}). "
            f"{login.get('description') or login.get('desc') or ''}".strip()
        )
    return login


def import_cookies(driver, cookies):
    driver.get("https://account.xiaomi.com/")
    for cookie in cookies:
        value = {
            "name": cookie.name,
            "value": cookie.value,
            "path": cookie.path or "/",
        }
        if cookie.domain:
            domain = cookie.domain.lstrip(".")
            if domain.endswith("xiaomi.com"):
                value["domain"] = cookie.domain
        try:
            driver.add_cookie(value)
        except Exception:
            # Some expired/domain-specific cookies cannot be imported; the
            # useful authentication cookies are still imported below.
            continue


def merge_browser_cookies(session, driver):
    for cookie in driver.get_cookies():
        name = cookie.get("name")
        value = cookie.get("value")
        if name and value:
            session.cookies.set(
                name,
                value,
                domain=cookie.get("domain") or "account.xiaomi.com",
                path=cookie.get("path") or "/",
            )


def has_cookie(session, name):
    return bool(session.cookies.get(name, default=""))


def build_session(session, login, device_id):
    user_id = str(login.get("userId") or session.cookies.get("userId") or "")
    pass_token = str(
        login.get("passToken") or session.cookies.get("passToken") or ""
    )
    ssecurity = str(login.get("ssecurity") or "")
    location = login.get("location")
    if not user_id or not pass_token or not ssecurity or not location:
        raise RuntimeError(
            "Xiaomi did not return all login fields after verification. "
            f"presence={{userId:{bool(user_id)}, passToken:{bool(pass_token)}, "
            f"ssecurity:{bool(ssecurity)}, callback:{bool(location)}}}"
        )

    nonce = str(login.get("nonce") or "")
    if nonce:
        client_sign = quote(
            __import__("base64")
            .b64encode(
                hashlib.sha1(f"nonce={nonce}&{ssecurity}".encode()).digest()
            )
            .decode()
        )
        location = f"{location}&clientSign={client_sign}"

    callback = session.get(
        location,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
        timeout=TIMEOUT_SECONDS,
        allow_redirects=True,
    )
    callback_text = callback.text
    service_token = (
        session.cookies.get("serviceToken", default="")
        or session.cookies.get("new_bbs_serviceToken", default="")
    )
    if not service_token:
        raise RuntimeError(
            "Xiaomi login succeeded but did not return serviceToken after callback."
        )

    return {
        "userId": user_id,
        "passToken": pass_token,
        "deviceId": device_id or session.cookies.get("deviceId", default=""),
        "ssecurity": ssecurity,
        "cookies": {
            "userId": user_id,
            "serviceToken": service_token,
        },
    }


def cookie_map(driver):
    return {
        item["name"]: item["value"]
        for item in driver.get_cookies()
        if item.get("name") and item.get("value")
    }


def worker_request(worker_url, path, payload, worker_token=""):
    headers = {"Content-Type": "application/json"}
    if worker_token:
        headers["Authorization"] = f"Bearer {worker_token}"
    response = requests.post(
        f"{worker_url.rstrip('/')}{path}",
        headers=headers,
        json=payload,
        timeout=TIMEOUT_SECONDS,
    )
    if "application/octet-stream" in response.headers.get("content-type", ""):
        return response.content
    try:
        body = response.json()
    except ValueError:
        raise RuntimeError(
            f"Worker returned HTTP {response.status_code} with invalid JSON."
        ) from None
    if not response.ok:
        raise RuntimeError(body.get("message") or f"Worker HTTP {response.status_code}.")
    return body


def main():
    print("Xiaomi official browser-flow test inside Google Colab")
    print("Password and tokens remain inside the Colab runtime and are not printed.")
    username = input("Xiaomi email/username: ").strip()
    password = getpass.getpass("Xiaomi password (hidden): ")
    worker_url = input("Worker URL (leave empty for session check only): ").strip()
    worker_token = ""
    device_id = ""
    region = "global"
    if worker_url:
        device_id = input("Device ID [leave empty to use Xiaomi browser cookie]: ").strip()
        region = input("Region [global]: ").strip() or "global"
        worker_token = getpass.getpass("Worker auth token (hidden, optional): ")

    display = start_browser_stack()
    driver = create_driver(display)
    xiaomi = requests.Session()
    try:
        login = xiaomi_login(xiaomi, username, password)
        verification_attempts = 0
        while login.get("notificationUrl"):
            if verification_attempts >= 2:
                raise RuntimeError(
                    "Xiaomi still requires verification after two browser attempts."
                )
            import_cookies(driver, xiaomi.cookies)
            driver.get(str(login["notificationUrl"]))
            verification_attempts += 1
            print(
                "\nThe Xiaomi verification page is open inside the Colab Chromium "
                "desktop above."
            )
            print(
                "Click Send, enter the code Xiaomi emails to the masked address, "
                "then complete every step until Xiaomi shows an explicit success message."
            )
            input("After success is visible in Chromium, press Enter here: ")
            merge_browser_cookies(xiaomi, driver)
            login = xiaomi_login(xiaomi, username, password)

        session = build_session(xiaomi, login, device_id)
        print(
            "\nXiaomi returned the required login fields. "
            "Values remain in memory and are not printed."
        )

        if not worker_url:
            print("Official Xiaomi session is complete. No Worker request was sent.")
            return

        session_body = worker_request(
            worker_url,
            "/api/session",
            {
                "userId": session["userId"],
                "passToken": session["passToken"],
                "deviceId": session["deviceId"],
            },
            worker_token,
        )
        session = session_body.get("session") if isinstance(session_body, dict) else None
        if not isinstance(session, dict):
            raise RuntimeError("Worker did not return a session object.")
        print("Worker /api/session succeeded. Session values remain in memory.")

        userinfo = worker_request(
            worker_url,
            "/api/userinfo",
            {"session": session, "region": region},
            worker_token,
        )
        print("Worker /api/userinfo response (sensitive fields redacted):")
        print(json.dumps(redact(userinfo), ensure_ascii=False, indent=2))

    finally:
        driver.quit()


try:
    main()
except KeyboardInterrupt:
    print("\nCancelled.")
except (requests.RequestException, RuntimeError) as error:
    print(f"\n[ERROR] {error}", file=sys.stderr)