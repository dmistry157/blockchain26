#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then
  export $(cat .env | xargs)
fi
if [ -f .venv/bin/activate ]; then
  source .venv/bin/activate
fi
echo "Starting Stream Watcher backend on port 8421..."
uvicorn stream_watcher:app --host 127.0.0.1 --port 8421 --reload
