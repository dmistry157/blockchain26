# ARCHITECTURE OVERVIEW
#
# This backend is a real-time oracle for Twitch stream prediction markets.
# It detects game events from a live Twitch stream so that prediction market
# bets can be resolved (e.g. "Does the player enter the Nether before 5min?").
#
# DATA FLOW — two separate connections, opposite directions:
#
# [UPLOAD]  Extension → Backend → Gemini
#   chrome.tabCapture grabs the Twitch tab as a MediaStream.
#   Every 1 second, a JPEG frame is drawn from the video to a canvas,
#   converted to bytes, and sent over WebSocket to /stream/{session_id}.
#   The backend calls generateContent with the JPEG and the user's prompt.
#   Gemini returns a trigger_event() function call if an event is detected.
#
# [DOWNLOAD] Gemini → Backend → Extension
#   When trigger_event() fires, the backend logs the datapoint to stdout
#   and pushes it to an SSE queue.
#   The extension has an EventSource listening on /events/{session_id}.
#   EventSource receives the push instantly and renders it in the sidebar.
#
# WHY TWO SEPARATE CONNECTIONS:
#   WebSocket: bidirectional, good for high-frequency frame upload
#   SSE (EventSource): server-push only, native browser API, auto-reconnects,
#   no extra extension permissions needed, perfect for low-frequency events
#
# WHY NOT GEMINI LIVE:
#   The native-audio Live models (the only ones available on AI Studio after
#   gemini-2.0-flash-live-001 was shut down Dec 2025) require AUDIO modality,
#   which severely degrades function calling. The standard generateContent API
#   supports function calling with image input reliably at the same 1fps rate.

import asyncio
import json
import os
import uuid
from datetime import datetime

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()

from google import genai
from google.genai import types

# ─── App setup ────────────────────────────────────────────────────────────────

app = FastAPI(title="Stream Watcher", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options={"api_version": "v1beta"},
)

MODEL = "gemini-2.5-flash"

# sessions[session_id] = {
#   "sse_queue": asyncio.Queue,
#   "prompt": str,
#   "stream_title": str,
#   "started_at": datetime,
#   "stop_event": asyncio.Event,
#   "processing": bool,   # True while a frame is being analysed — skip new frames
#   "frame_count": int,
# }
sessions: dict[str, dict] = {}

ORCHESTRATOR_URL = os.environ.get("ORCHESTRATOR_URL", "http://127.0.0.1:8080")


async def _post_orchestrator(path: str, body: dict) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{ORCHESTRATOR_URL.rstrip('/')}{path}", json=body)
            if r.status_code >= 400:
                print(f"[stream_watcher] orchestrator {path} → {r.status_code}", flush=True)
    except Exception as e:
        print(f"[stream_watcher] orchestrator error: {e}", flush=True)

# ─── Tool declaration ─────────────────────────────────────────────────────────

TRIGGER_EVENT_DECL = types.FunctionDeclaration(
    name="trigger_event",
    description=(
        "Call this when you observe a specific game event in the video stream. "
        "Only call when confidence >= 0.8."
    ),
    parameters=types.Schema(
        type=types.Type.OBJECT,
        properties={
            "event_type": types.Schema(
                type=types.Type.STRING,
                description="Short snake_case label, e.g. 'entered_nether'",
            ),
            "confidence": types.Schema(
                type=types.Type.NUMBER,
                description="Confidence score from 0.0 to 1.0",
            ),
            "description": types.Schema(
                type=types.Type.STRING,
                description="One sentence describing exactly what was seen on screen",
            ),
            "timestamp_iso": types.Schema(
                type=types.Type.STRING,
                description="ISO8601 UTC timestamp when the event was observed",
            ),
        },
        required=["event_type", "confidence", "description", "timestamp_iso"],
    ),
)

# ─── Hardcoded speedrun detection prompt ──────────────────────────────────────

SYSTEM_PROMPT = """You are watching a Minecraft speedrun on Twitch.
Call trigger_event() when you observe ANY of the following:

- speedrun_started    : a NEW run begins — fresh overworld, new world load, timer at 0 or just started,
                        player spawning in a fresh world, or title screen / world creation
- entered_nether      : player enters The Nether (purple fog, netherrack, lava seas)
- got_blaze_rods      : player picks up blaze rods or kills blazes in a Nether Fortress
- found_stronghold    : player enters a stronghold (stone brick corridors, iron bars)
- entered_end         : player enters The End (void sky, end stone, endermen)
- ender_dragon_killed : Ender Dragon death animation or credits screen appears
- speedrun_ended      : run timer stops, player resets the world, or a death/end screen
                        with a final time is visible

Rules:
- speedrun_started MUST fire when a new run/world begins (between consecutive attempts)
- speedrun_ended MUST fire when the current run ends (reset, death, completion)
- Only call trigger_event() when confidence >= 0.8
- Do not call for ambiguous or transitional frames
- Do not respond with any text — only call trigger_event() if an event is detected
- If nothing notable is happening, return nothing (empty response is correct)
- Never fire the same event_type twice in a row
"""

# ─── Per-frame analysis ───────────────────────────────────────────────────────

async def process_frame(session_id: str, jpeg_bytes: bytes) -> None:
    """Send one JPEG frame to Gemini and handle any trigger_event() response."""
    info = sessions[session_id]
    info["processing"] = True
    info["frame_count"] += 1
    frame_count = info["frame_count"]

    try:
        response = await client.aio.models.generate_content(
            model=MODEL,
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                        types.Part(text="Analyze this stream frame for game events."),
                    ],
                )
            ],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                tools=[types.Tool(function_declarations=[TRIGGER_EVENT_DECL])],
                tool_config=types.ToolConfig(
                    function_calling_config=types.FunctionCallingConfig(mode="AUTO")
                ),
            ),
        )

        candidate = response.candidates[0] if response.candidates else None
        if candidate and candidate.content and candidate.content.parts:
            for part in candidate.content.parts:
                if part.function_call and part.function_call.name == "trigger_event":
                    args = dict(part.function_call.args)
                    event_type = args.get("event_type")

                    # Allow boundary events to fire again between runs; block duplicates otherwise
                    if event_type not in ("speedrun_started", "speedrun_ended"):
                        if event_type in info["fired_events"]:
                            continue
                        info["fired_events"].add(event_type)
                    elif event_type == "speedrun_ended":
                        # Reset so next run can trigger speedrun_started + milestones again
                        info["fired_events"].clear()

                    # Keep last 10 events for LLM suggestions
                    rec = info.get("recent_events", [])
                    rec.append({"event_type": event_type, "description": args.get("description", "")})
                    info["recent_events"] = rec[-10:]

                    datapoint = {
                        "type": "event",
                        "event_type": event_type,
                        "confidence": args.get("confidence"),
                        "description": args.get("description"),
                        "timestamp_iso": args.get("timestamp_iso"),
                        "session_id": session_id,
                        "received_at": datetime.utcnow().isoformat(),
                    }
                    # Print to stdout — this is the oracle datapoint for downstream use
                    print(json.dumps(datapoint), flush=True)
                    info["sse_queue"].put_nowait(datapoint)

                    # Notify orchestrator (Node server) for market resolve / create
                    if event_type in ("speedrun_started", "speedrun_ended", "ender_dragon_killed"):
                        asyncio.create_task(
                            _post_orchestrator(
                                "/api/oracle/event",
                                {**datapoint, "stream_title": info.get("stream_title", "")},
                            )
                        )

        if frame_count % 60 == 0:
            info["sse_queue"].put_nowait(
                {"type": "system", "message": "FRAME_RECEIVED", "count": frame_count}
            )

    except Exception as exc:
        print(f"[stream_watcher] frame error for {session_id}: {exc}", flush=True)
        info["sse_queue"].put_nowait({"type": "error", "message": str(exc)})

    finally:
        info["processing"] = False

# ─── Models ───────────────────────────────────────────────────────────────────

class StartSessionRequest(BaseModel):
    stream_title: str = "Twitch Stream"

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "active_sessions": len(sessions)}


@app.post("/session/start")
async def session_start(req: StartSessionRequest):
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "sse_queue": asyncio.Queue(),
        "stream_title": req.stream_title,
        "fired_events": set(),
        "recent_events": [],  # last 10 for LLM suggestions
        "started_at": datetime.utcnow(),
        "stop_event": asyncio.Event(),
        "processing": False,
        "frame_count": 0,
    }
    sessions[session_id]["sse_queue"].put_nowait(
        {"type": "system", "message": "STREAM_STARTED"}
    )
    print(
        f"[stream_watcher] session started: {session_id} — {req.stream_title}",
        flush=True,
    )
    asyncio.create_task(
        _post_orchestrator(
            "/api/session/register",
            {"session_id": session_id, "stream_title": req.stream_title},
        )
    )
    return {"session_id": session_id}


@app.post("/session/stop/{session_id}")
async def session_stop(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    info = sessions.pop(session_id)
    info["stop_event"].set()
    info["sse_queue"].put_nowait({"type": "system", "message": "STREAM_STOPPED"})
    print(f"[stream_watcher] session stopped: {session_id}", flush=True)
    return {"ok": True}


@app.websocket("/stream/{session_id}")
async def stream_ws(websocket: WebSocket, session_id: str):
    if session_id not in sessions:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    try:
        while True:
            jpeg_bytes = await websocket.receive_bytes()
            info = sessions.get(session_id)
            if info is None:
                break

            # Skip frame if previous analysis is still running
            if not info["processing"]:
                asyncio.create_task(process_frame(session_id, jpeg_bytes))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[stream_watcher] ws error for {session_id}: {exc}", flush=True)


@app.get("/events/{session_id}")
async def events_sse(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    queue = sessions[session_id]["sse_queue"]

    async def generate():
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=25)
                yield f"data: {json.dumps(event)}\n\n"
                if (
                    event.get("type") == "system"
                    and event.get("message") == "STREAM_STOPPED"
                ):
                    break
            except asyncio.TimeoutError:
                # Keep-alive ping so the browser doesn't close the connection
                yield "data: {\"type\":\"ping\"}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/session/status/{session_id}")
async def session_status(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    info = sessions[session_id]
    return {
        "session_id": session_id,
        "stream_title": info["stream_title"],
        "started_at": info["started_at"].isoformat(),
        "frame_count": info["frame_count"],
        "processing": info["processing"],
    }


SUGGEST_PROMPT = """You are suggesting prediction markets for a live Twitch stream.
Given the stream title and recent game events, suggest 3-5 short, fun prediction market questions.
Each question should be a yes/no bet viewers might want to make (e.g. "Will the player enter the Nether before 5 minutes?").
Keep questions under 12 words. Return ONLY a JSON array of strings, no other text.
Example: ["Will the run finish under 15 min?", "Will they get 2 blaze rods first try?"]
"""


@app.get("/session/suggest-markets/{session_id}")
async def suggest_markets(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    info = sessions[session_id]
    stream_title = info.get("stream_title", "Twitch stream")
    recent = info.get("recent_events", [])
    context = f"Stream: {stream_title}. Recent events: " + ", ".join(
        f"{e.get('event_type', '')} ({e.get('description', '')})" for e in recent[-5:]
    ) if recent else f"Stream: {stream_title}."

    try:
        response = await client.aio.models.generate_content(
            model=MODEL,
            contents=[context + "\n\n" + SUGGEST_PROMPT],
        )
        text = ""
        if hasattr(response, "text") and response.text:
            text = response.text.strip()
        elif response.candidates:
            for part in (response.candidates[0].content.parts or []):
                if hasattr(part, "text") and part.text:
                    text = part.text.strip()
                    break
        # Extract JSON array
        start = text.find("[")
        end = text.rfind("]") + 1
        if start >= 0 and end > start:
            arr = json.loads(text[start:end])
            if isinstance(arr, list):
                return {"suggestions": [str(s) for s in arr[:5]]}
        return {"suggestions": []}
    except Exception as e:
        print(f"[stream_watcher] suggest-markets error: {e}", flush=True)
        return {"suggestions": []}
