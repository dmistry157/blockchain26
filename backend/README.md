# Stream Watcher (VLM + Gemini)

Watches a Twitch tab via the extension, captures frames, and sends them to Gemini for game-event detection (e.g. speedrun milestones). Used by the **Watch** tab in the sidebar.

## Setup

```bash
cd backend
cp .env.example .env
# Edit .env and set GEMINI_API_KEY=your-key
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

## Run

```bash
./start.sh
# Or: uvicorn stream_watcher:app --host 127.0.0.1 --port 8421 --reload
```

Runs on **http://127.0.0.1:8421**. The extension’s Watch tab connects here (WebSocket for frame upload, SSE for events).

## Full stack

- **Node server** (repo root): `node server.js` → port 8080 (prediction market + WebSocket for **Trade** tab).
- **Stream watcher**: `./backend/start.sh` → port 8421 (Gemini VLM for **Watch** tab).
