"""
Clean two-way Gemini Live connection test.

Tests:
  [UPLOAD]   Script → WebSocket → Backend → Gemini Live  (sends JPEG frames)
  [DOWNLOAD] Gemini Live → Backend SSE → Script          (receives events)

Run: python test_gemini_live.py
"""

import asyncio
import json
import struct
import time
import httpx
import websockets

BACKEND = "http://127.0.0.1:8421"
WS_BACKEND = "ws://127.0.0.1:8421"

# A bright red 64x64 JPEG — simple enough that Gemini can describe it.
# Generated inline so we need no image files.
def make_test_jpeg() -> bytes:
    """Create a valid 320x240 red JPEG using Pillow."""
    from PIL import Image
    import io
    img = Image.new('RGB', (320, 240), color=(200, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=80)
    return buf.getvalue()


async def listen_sse(session_id: str, results: list, stop_event: asyncio.Event):
    """Read SSE events and collect them."""
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("GET", f"{BACKEND}/events/{session_id}") as resp:
            async for line in resp.aiter_lines():
                if stop_event.is_set():
                    break
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if event.get("type") == "ping":
                    continue

                ts = time.strftime("%H:%M:%S")
                kind = event.get("type", "?")

                if kind == "system":
                    print(f"  [{ts}] SYSTEM  → {event['message']}", flush=True)
                elif kind == "event":
                    print(
                        f"  [{ts}] EVENT   → {event['event_type']} "
                        f"({int(event['confidence']*100)}%) — {event['description']}",
                        flush=True,
                    )
                elif kind == "error":
                    print(f"  [{ts}] ERROR   → {event['message']}", flush=True)

                results.append(event)

                if kind == "system" and event.get("message") == "STREAM_STOPPED":
                    break


async def run_test():
    print("=" * 60)
    print("  Gemini Live — two-way connection test")
    print("=" * 60)

    # ── 1. Health check ───────────────────────────────────────────
    print("\n[1] Health check...", end=" ", flush=True)
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BACKEND}/health")
        r.raise_for_status()
    print(f"OK  {r.json()}")

    # ── 2. Start session ──────────────────────────────────────────
    prompt = (
        "Call trigger_event() when you observe ANY of the following:\n"
        "- A solid colour block or simple shape (event_type: 'solid_color_detected')\n"
        "- A test image or pattern (event_type: 'test_pattern_detected')\n"
        "- Any image at all, even a single colour frame (event_type: 'frame_received')\n"
        "This is a connection test. Call trigger_event() on the very first frame "
        "you can see something in. Confidence can be 0.9 for any visible frame."
    )

    print("\n[2] Creating session...", end=" ", flush=True)
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{BACKEND}/session/start",
            json={"prompt": prompt, "stream_title": "Connection Test"},
        )
        r.raise_for_status()
        session_id = r.json()["session_id"]
    print(f"OK  session_id={session_id[:8]}...")

    # ── 3. Start SSE listener in background ───────────────────────
    print("\n[3] Opening SSE event stream...", end=" ", flush=True)
    results = []
    stop_event = asyncio.Event()
    sse_task = asyncio.create_task(listen_sse(session_id, results, stop_event))
    await asyncio.sleep(1)  # let SSE connect
    print("OK")

    # ── 4. Send frames via WebSocket ──────────────────────────────
    jpeg = make_test_jpeg()
    n_frames = 10
    print(f"\n[4] Sending {n_frames} JPEG frames via WebSocket (1fps)...")

    try:
        async with websockets.connect(f"{WS_BACKEND}/stream/{session_id}") as ws:
            print(f"    WebSocket connected ✓", flush=True)
            for i in range(n_frames):
                await ws.send(jpeg)
                print(f"    → frame {i+1}/{n_frames}", flush=True)
                await asyncio.sleep(1)
        print("    WebSocket closed cleanly ✓")
    except Exception as e:
        print(f"    WebSocket error: {e}")

    # ── 5. Wait a few extra seconds for Gemini to respond ─────────
    print(f"\n[5] Waiting up to 30s for Gemini events...")
    for _ in range(30):
        await asyncio.sleep(1)
        if any(e.get("type") == "event" for e in results):
            print("    Got at least one event — stopping early.")
            break

    # ── 6. Stop session ───────────────────────────────────────────
    print("\n[6] Stopping session...", end=" ", flush=True)
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BACKEND}/session/stop/{session_id}")
        r.raise_for_status()
    print(f"OK  {r.json()}")

    stop_event.set()
    sse_task.cancel()
    try:
        await sse_task
    except asyncio.CancelledError:
        pass

    # ── 7. Results ────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  RESULTS")
    print("=" * 60)

    sys_msgs  = [e for e in results if e.get("type") == "system"]
    events    = [e for e in results if e.get("type") == "event"]
    errors    = [e for e in results if e.get("type") == "error"]

    print(f"  System messages : {len(sys_msgs)}")
    print(f"  Events from AI  : {len(events)}")
    print(f"  Errors          : {len(errors)}")

    if events:
        print("\n  ✅  UPLOAD → GEMINI → DOWNLOAD path confirmed working!")
    elif errors:
        print(f"\n  ❌  Errors received: {[e['message'] for e in errors]}")
    else:
        print("\n  ⚠️  No events returned — Gemini may need more frames or a richer image.")
        print("      The upload path still worked if you saw 'STREAM_STARTED' above.")

    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(run_test())
