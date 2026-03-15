// Stream Watcher UI — fully automatic, no user input required
import { startWatcher, stopWatcher } from './watcher.js';

const BACKEND = 'http://127.0.0.1:8421';
const MAX_LOG_CARDS = 50;

// Events that mean the run is over — triggers auto-stop
const AUTO_STOP_EVENTS = new Set([
  'speedrun_ended', 'run_ended', 'run_finished', 'run_reset',
  'ender_dragon_killed', 'credits_rolling',
]);

let sessionId = null;
let stopFn    = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusBadge = document.getElementById('status-badge');
const idleHint    = document.getElementById('idle-hint');
const btnStop     = document.getElementById('btn-stop');
const btnClear    = document.getElementById('btn-clear');
const eventLog    = document.getElementById('event-log');
const logEmpty    = document.getElementById('log-empty');

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state) {
  statusBadge.className = `status-badge ${state}`;
  statusBadge.textContent = state.toUpperCase();
  idleHint.classList.toggle('hidden', state !== 'idle');
  btnStop.disabled = (state !== 'watching');
}

// ── Log helpers ───────────────────────────────────────────────────────────────
function trimLog() {
  const cards = eventLog.querySelectorAll('.event-card, .log-system, .log-error');
  while (cards.length > MAX_LOG_CARDS) cards[cards.length - 1].remove();
}

function prependEl(el) {
  if (logEmpty) logEmpty.style.display = 'none';
  eventLog.insertBefore(el, eventLog.firstChild);
  trimLog();
}

function addEventCard(data) {
  const pct = Math.round((data.confidence ?? 0) * 100);
  const card = document.createElement('div');
  card.className = 'event-card';
  card.innerHTML = `
    <div class="event-card-header">
      <span class="event-type-badge">${esc(data.event_type ?? 'event')}</span>
      <span class="event-confidence${pct < 90 ? ' low' : ''}">${pct}%</span>
    </div>
    <div class="event-description">${esc(data.description ?? '')}</div>
  `;
  prependEl(card);
}

function addSystemLine(msg) {
  const el = document.createElement('div');
  el.className = 'log-system';
  el.textContent = `— ${msg}`;
  prependEl(el);
}

function addErrorLine(msg) {
  const el = document.createElement('div');
  el.className = 'log-error';
  el.textContent = `✕ ${msg}`;
  prependEl(el);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// ── Event handler ─────────────────────────────────────────────────────────────
function handleEvent(data) {
  switch (data.type) {
    case 'event':
      addEventCard(data);
      if (AUTO_STOP_EVENTS.has(data.event_type) && stopFn) {
        addSystemLine('Run ended — stopping automatically.');
        handleStop();
      }
      break;
    case 'system':
      if (data.message !== 'STREAM_STARTED') {
        addSystemLine(data.message + (data.count != null ? ` (${data.count} frames)` : ''));
      }
      break;
    case 'error':
      addErrorLine(data.message);
      handleStop();
      break;
  }
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
async function handleStart() {
  setStatus('connecting');

  try {
    const res = await fetch(`${BACKEND}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream_title: 'Twitch Stream' }),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    const { session_id } = await res.json();
    sessionId = session_id;
  } catch (err) {
    addErrorLine(`Could not reach backend: ${err.message}`);
    setStatus('error');
    return;
  }

  stopFn = await startWatcher(sessionId, handleEvent);
  setStatus('watching');
}

async function handleStop() {
  stopWatcher(stopFn);
  stopFn = null;

  if (sessionId) {
    fetch(`${BACKEND}/session/stop/${sessionId}`, { method: 'POST' }).catch(() => {});
    sessionId = null;
  }

  setStatus('idle');
}

// ── Auto-start ────────────────────────────────────────────────────────────────
async function maybeAutoStart() {
  if (stopFn) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('twitch.tv')) return;
  handleStart();
}

// Trigger A: sidebar opens on a Twitch tab
window.addEventListener('load', () => maybeAutoStart());

// Trigger B: user navigates to Twitch while sidebar is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'twitchTabDetected') maybeAutoStart();
});

// ── Buttons ───────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', handleStop);
btnClear.addEventListener('click', () => {
  eventLog.innerHTML = '<div class="log-empty" id="log-empty">No events yet.</div>';
});
