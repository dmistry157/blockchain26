"""
SpeedrunFi AI Oracle Worker

Captures a screen region every 10 seconds, sends it to Claude Vision API
to extract the speedrun timer, and POSTs the elapsed seconds to the server.
"""

import base64
import io
import sys
import time

import anthropic
import mss
import requests
from PIL import Image

SERVER_URL = "http://localhost:8080/api/oracle-update"
CAPTURE_INTERVAL = 10  # seconds

# Screen region to capture (adjust to where the timer is visible)
# Format: {"top": y, "left": x, "width": w, "height": h, "mon": monitor_number}
CAPTURE_REGION = {"top": 50, "left": 50, "width": 400, "height": 100, "mon": 1}

PROMPT = (
    "Look at this game footage. Extract the current speedrun timer. "
    "Respond ONLY with the total elapsed time in seconds as an integer."
)


def capture_screenshot(region):
    with mss.mss() as sct:
        raw = sct.grab(region)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def query_claude(image_b64):
    client = anthropic.Anthropic()  # uses ANTHROPIC_API_KEY env var
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=64,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    )
    text = response.content[0].text.strip()
    return int(text)


def post_oracle_update(elapsed_seconds):
    resp = requests.post(
        SERVER_URL,
        json={"actualElapsedSeconds": elapsed_seconds},
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    print(f"SpeedrunFi Oracle Worker started (interval={CAPTURE_INTERVAL}s)")
    print(f"Capture region: {CAPTURE_REGION}")
    print(f"Posting to: {SERVER_URL}")

    while True:
        try:
            image_b64 = capture_screenshot(CAPTURE_REGION)
            elapsed = query_claude(image_b64)
            print(f"[Oracle] Detected elapsed time: {elapsed}s")

            result = post_oracle_update(elapsed)
            print(f"[Oracle] Server response: {result}")

        except ValueError as e:
            print(f"[Oracle] Claude returned non-integer response: {e}", file=sys.stderr)
        except requests.RequestException as e:
            print(f"[Oracle] HTTP error posting update: {e}", file=sys.stderr)
        except anthropic.APIError as e:
            print(f"[Oracle] Anthropic API error: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[Oracle] Unexpected error: {e}", file=sys.stderr)

        time.sleep(CAPTURE_INTERVAL)


if __name__ == "__main__":
    main()
