// Stream Watcher — frame capture + WebSocket upload + SSE event receiver
// Vanilla ES module. No build step. No dependencies.

/**
 * Start watching the active Twitch tab.
 *
 * @param {string} sessionId  - Session ID from /session/start
 * @param {function} onEvent  - Called with each parsed SSE event object
 * @returns {function} stop   - Call to clean up all resources
 */
export async function startWatcher(sessionId, onEvent) {
  // ── 1. Get the active tab ──────────────────────────────────────────────────
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || !activeTab.url?.includes('twitch.tv')) {
    onEvent({ type: 'error', message: 'Not on a Twitch tab or capture denied' });
    return () => {};
  }

  // ── 2. Get a tab capture stream ID ────────────────────────────────────────
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: activeTab.id },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        }
      );
    });
  } catch (err) {
    onEvent({ type: 'error', message: `Capture failed: ${err.message}` });
    return () => {};
  }

  // ── 3. Open a MediaStream from the stream ID ───────────────────────────────
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: 1280,
          maxHeight: 720,
        },
      },
      audio: false,
    });
  } catch (err) {
    onEvent({ type: 'error', message: `Failed to capture tab: ${err.message}` });
    return () => {};
  }

  // ── 4. Attach stream to a hidden video element ─────────────────────────────
  const video = document.createElement('video');
  video.style.display = 'none';
  video.srcObject = stream;
  video.muted = true;
  document.body.appendChild(video);
  await video.play();

  // ── 5. Create canvas for frame capture ────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  // ── 6. Open WebSocket to backend ──────────────────────────────────────────
  const ws = new WebSocket(`ws://127.0.0.1:8421/stream/${sessionId}`);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('close', (evt) => {
    if (evt.code !== 1000) {
      onEvent({ type: 'error', message: 'Connection to backend lost' });
    }
  });

  ws.addEventListener('error', () => {
    onEvent({ type: 'error', message: 'Connection to backend lost' });
  });

  // ── 7. Open SSE event stream from backend ─────────────────────────────────
  const evtSource = new EventSource(`http://127.0.0.1:8421/events/${sessionId}`);

  evtSource.addEventListener('message', (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type !== 'ping') onEvent(data);
    } catch {
      // malformed frame — ignore
    }
  });

  evtSource.addEventListener('error', () => {
    onEvent({ type: 'error', message: 'Event stream disconnected' });
  });

  // ── 8. Capture a JPEG frame every second and send over WebSocket ──────────
  const intervalId = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;

    ctx.drawImage(video, 0, 0, 1280, 720);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(buf);
        });
      },
      'image/jpeg',
      0.8
    );
  }, 1000);

  // ── 9. Return stop function ───────────────────────────────────────────────
  return function stop() {
    clearInterval(intervalId);
    ws.close(1000);
    evtSource.close();
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    video.remove();
  };
}

export function stopWatcher(stopFn) {
  if (typeof stopFn === 'function') stopFn();
}
