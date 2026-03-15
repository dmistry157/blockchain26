// ─── Dashboard: Portfolio (dummy) ─────────────────────────────────────────────

const PORTFOLIO = {
  totalValue: 48_372.15,
  dayChange: 1_243.67,
  dayChangePercent: 2.64,
  holdings: [
    { ticker: 'AAPL', price: 198.12, change: 1.32 },
    { ticker: 'TSLA', price: 241.37, change: -0.85 },
    { ticker: 'NVDA', price: 875.28, change: 3.14 },
    { ticker: 'MSFT', price: 415.60, change: 0.47 },
  ],
};

const NEWS_STORAGE_KEY = 'newsFeedArticles';
let currentArticles = [];

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatCurrency(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function timeAgo(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function renderPortfolio() {
  const dateEl = document.getElementById('portfolio-date');
  const valueEl = document.getElementById('portfolio-value');
  const changeEl = document.getElementById('portfolio-change');
  const holdingsEl = document.getElementById('portfolio-holdings');
  if (!dateEl || !valueEl) return;

  dateEl.textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  valueEl.textContent = formatCurrency(PORTFOLIO.totalValue);
  if (changeEl) {
    const sign = PORTFOLIO.dayChange >= 0 ? '+' : '';
    changeEl.querySelector('.change-amount').textContent = sign + formatCurrency(PORTFOLIO.dayChange);
    changeEl.querySelector('.change-percent').textContent = '(' + sign + PORTFOLIO.dayChangePercent.toFixed(2) + '%)';
    changeEl.classList.toggle('positive', PORTFOLIO.dayChange >= 0);
    changeEl.classList.toggle('negative', PORTFOLIO.dayChange < 0);
  }
  if (holdingsEl) {
    holdingsEl.innerHTML = PORTFOLIO.holdings.map(h => {
      const dir = h.change >= 0 ? 'up' : 'down';
      const arrow = h.change >= 0 ? '\u25B2' : '\u25BC';
      return '<div class="holding-chip"><span class="ticker">' + esc(h.ticker) + '</span><span class="price">' + formatCurrency(h.price) + '</span><span class="chip-change ' + dir + '">' + arrow + ' ' + Math.abs(h.change).toFixed(2) + '%</span></div>';
    }).join('');
  }
}

function renderNews(articles, animateNew) {
  const feed = document.getElementById('news-feed');
  if (!feed) return;
  if (!articles || !articles.length) {
    feed.innerHTML = '<div class="news-loading">Loading news…</div>';
    return;
  }
  feed.innerHTML = articles.map((a, i) => {
    const href = isHttpUrl(a.link) ? esc(a.link) : '#';
    const cls = animateNew && i === 0 ? ' slide-in' : '';
    return '<a class="news-card' + cls + '" href="' + href + '" target="_blank" rel="noopener noreferrer" data-pubdate="' + esc(a.pubDate) + '"><div class="news-card-source"><span class="source-dot" style="background:' + esc(a.color || '#71717a') + '"></span><span>' + esc(a.source) + '</span><span class="news-card-time">' + timeAgo(a.pubDate) + '</span></div><h3>' + esc(a.title) + '</h3><p>' + esc(a.summary) + '</p></a>';
  }).join('');
}

function showToast(count) {
  let toast = document.getElementById('new-articles-toast');
  if (!toast) {
    toast = document.createElement('button');
    toast.id = 'new-articles-toast';
    const news = document.getElementById('news');
    if (news) news.appendChild(toast);
    toast.addEventListener('click', () => {
      const feed = document.getElementById('news-feed');
      if (feed) feed.scrollTo({ top: 0, behavior: 'smooth' });
      toast.classList.remove('visible');
    });
  }
  toast.textContent = '\u2191 ' + count + ' new article' + (count > 1 ? 's' : '');
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 6000);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'newNewsAvailable') {
      const payload = msg.payload || {};
      currentArticles = payload.articles || [];
      const feed = document.getElementById('news-feed');
      const scrolledDown = feed && feed.scrollTop > 120;
      renderNews(currentArticles, true);
      if (scrolledDown && (payload.newCount || 0) > 0) showToast(payload.newCount);
    }
    sendResponse({ received: true });
  });
}

function refreshTimestamps() {
  document.querySelectorAll('[data-pubdate]').forEach(el => {
    const ts = el.querySelector('.news-card-time');
    if (ts) ts.textContent = timeAgo(el.dataset.pubdate);
  });
}

// ─── Trade: prediction market ─────────────────────────────────────────────────

const API_BASE = (typeof window !== 'undefined' && window.location?.hostname === 'localhost')
  ? window.location.origin
  : 'http://localhost:8080';

const XRPL_STORAGE_KEY = 'speedrunfi_xrplWallet';
let currentXrplMarketId = 'default';

let userId = 'user_' + Math.random().toString(36).slice(2, 10);
let currentMarket = null;
let xrplWallet = null;

// Hardcoded baseline — average speedrun time (streamer-specific, replace later)
const BASELINE_SECONDS = 870;
const BASELINE_DISPLAY = '14:30';
const BASELINE_PROBABILITY = 0.55;

try {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get('speedrunfi_userId').then(stored => {
      if (stored.speedrunfi_userId) userId = stored.speedrunfi_userId;
      else chrome.storage.local.set({ speedrunfi_userId: userId });
    });
  }
} catch (_) {}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  const data = res.ok ? await res.json().catch(() => ({})) : null;
  if (!res.ok) throw new Error(data?.error || res.statusText || 'Request failed');
  return data;
}

async function fetchCurrentMarket() {
  try {
    const m = await apiFetch('/api/xrpl/current-market');
    currentXrplMarketId = m.marketId || currentXrplMarketId;
    const q = document.getElementById('market-question');
    if (q) q.textContent = m.question || 'Speedrun Market';
    return m;
  } catch (_) {
    return { marketId: currentXrplMarketId, question: 'Speedrun Market' };
  }
}

async function bootstrapXrpl() {
  const m = await fetchCurrentMarket();
  await apiFetch('/api/xrpl/bootstrap', { method: 'POST', body: JSON.stringify({ marketId: m.marketId || currentXrplMarketId, question: m.question || 'Speedrun Market' }) });
}

async function connectXrpl(secret) {
  const { address } = await apiFetch('/api/xrpl/derive-address', { method: 'POST', body: JSON.stringify({ secret }) });
  xrplWallet = { address, secret };
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [XRPL_STORAGE_KEY]: xrplWallet });
  }
  await bootstrapXrpl();
  await issueCredit();
  await fetchXrplBalances();
  renderXrplUI(true);
  setConnectionStatus('XRPL', '#22c55e');
  updateStatus('Connected to XRPL Devnet', 'success');
}

async function issueCredit() {
  if (!xrplWallet) return;
  try {
    await apiFetch('/api/xrpl/issue-credit', {
      method: 'POST',
      body: JSON.stringify({ viewerSecret: xrplWallet.secret, marketId: DEFAULT_MARKET_ID, creditAmount: 1000 }),
    });
  } catch (e) {
    if (!/already|trust/i.test(e.message)) updateStatus('Credit issue: ' + e.message, 'error');
  }
}

async function fetchXrplBalances() {
  if (!xrplWallet) return;
  try {
    const bal = await apiFetch(`/api/xrpl/balances/${encodeURIComponent(xrplWallet.address)}/${currentXrplMarketId}`);
    const creditEl = document.getElementById('xrpl-balance-credit');
    const yesEl = document.getElementById('xrpl-balance-yes');
    const noEl = document.getElementById('xrpl-balance-no');
    const mainEl = document.getElementById('balance-value');
    if (creditEl) creditEl.textContent = parseFloat(bal.CREDIT || 0).toLocaleString();
    if (yesEl) yesEl.textContent = parseFloat(bal.YES || 0).toLocaleString();
    if (noEl) noEl.textContent = parseFloat(bal.NO || 0).toLocaleString();
    if (mainEl) mainEl.textContent = parseFloat(bal.CREDIT || 0).toLocaleString() + ' CR';
  } catch (e) {
    updateStatus('Balance fetch failed: ' + e.message, 'error');
  }
}

function renderXrplUI(connected) {
  const connectEl = document.getElementById('xrpl-connect');
  const connEl = document.getElementById('xrpl-connected');
  const addrEl = document.getElementById('xrpl-address');
  if (!connectEl || !connEl) return;
  connectEl.style.display = connected ? 'none' : 'flex';
  connEl.style.display = connected ? 'flex' : 'none';
  if (connected && xrplWallet && addrEl) {
    addrEl.textContent = xrplWallet.address.slice(0, 8) + '...' + xrplWallet.address.slice(-6);
  }
}

async function fetchSuggestions() {
  const list = document.getElementById('suggested-list');
  if (!list) return;
  try {
    const data = await apiFetch('/api/suggestions');
    const items = data.suggestions || [];
    list.innerHTML = items.length
      ? items.map((q) => '<div class="suggested-chip">' + esc(q) + '</div>').join('')
      : '<div class="suggested-chip" style="color:#26262c">No suggestions yet — start watching a stream</div>';
  } catch (_) {
    list.innerHTML = '<div class="suggested-chip" style="color:#26262c">Suggestions unavailable</div>';
  }
}

function disconnectXrpl() {
  xrplWallet = null;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.remove(XRPL_STORAGE_KEY);
  }
  renderXrplUI(false);
  setConnectionStatus('Connecting...', '#6b6b7b');
  connect();
}

function setConnectionStatus(text, color) {
  const el = document.getElementById('conn-status');
  if (el) { el.textContent = text; el.style.color = color; }
}

let chart = null;
let yesSeries = null;

function initChart() {
  if (chart) return;
  const container = document.getElementById('chart-container');
  if (!container) return;
  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div style="color:#6b6b7b;padding:20px;font-size:11px">Chart failed to load</div>';
    return;
  }
  const w = Math.max(container.clientWidth, 280);
  const h = Math.max(container.clientHeight, 160);
  chart = LightweightCharts.createChart(container, {
    width: w,
    height: h,
    layout: { background: { color: '#000000' }, textColor: '#6b6b7b', fontSize: 10 },
    grid: { vertLines: { color: '#1f1f23' }, horzLines: { color: '#1f1f23' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#26262c' },
    timeScale: { borderColor: '#26262c', timeVisible: true, secondsVisible: true },
  });
  yesSeries = chart.addLineSeries({
    color: '#ffffff',
    lineWidth: 1.5,
    priceFormat: { type: 'custom', formatter: val => (val * 100).toFixed(0) + '%' },
  });
  new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  }).observe(container);

  seedChartWithBaseline();
}

let ws = null;
let reconnectTimer = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setConnectionStatus('Connecting...', '#6b6b7b');
  try {
    ws = new WebSocket('ws://localhost:8080');
  } catch (err) {
    setConnectionStatus('WS failed: ' + err.message, '#6b6b7b');
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    setConnectionStatus('Connected', '#22c55e');
    updateStatus('Connected to server', 'success');
    ws.send(JSON.stringify({ action: 'register', userId }));
  };
  ws.onclose = () => {
    setConnectionStatus('Disconnected', '#6b6b7b');
    updateStatus('Disconnected — reconnecting...', 'error');
    scheduleReconnect();
  };
  ws.onerror = () => setConnectionStatus('Connection error', '#6b6b7b');
  ws.onmessage = event => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to parse WS message:', err);
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      updateBalance(msg.balance);
      if (msg.oracleTime != null) updateOracleTime(msg.oracleTime);
      if (msg.markets && msg.markets.length > 0) {
        currentMarket = msg.markets[0];
        const q = document.getElementById('market-question');
        if (q) q.textContent = currentMarket.question || 'Speedrun Market';
      }
      if (msg.orderBook) {
        renderOrderBook(msg.orderBook);
        const mid = midFromBook(msg.orderBook);
        if (mid != null) addChartPoint(mid);
      }
      break;
    case 'orderBookUpdate':
      renderOrderBook(msg.book);
      const mid = midFromBook(msg.book);
      if (mid != null) addChartPoint(mid);
      if (msg.fills && msg.fills.length > 0) {
        const lastFill = msg.fills[msg.fills.length - 1];
        updateStatus('Trade filled @ ' + (lastFill.price * 100).toFixed(0) + '¢', 'success');
      }
      break;
    case 'oracleUpdate':
      updateOracleTime(msg.oracleTime);
      break;
    case 'balanceUpdate':
      updateBalance(msg.balance);
      break;
    case 'orderAccepted':
      updateStatus('Order accepted (' + msg.fills + ' fills)', 'success');
      break;
    case 'marketCreated':
      currentMarket = msg.market;
      currentXrplMarketId = msg.market?.id || currentXrplMarketId;
      const q2 = document.getElementById('market-question');
      if (q2) q2.textContent = msg.market?.question || 'Speedrun Market';
      updateStatus('New market: ' + (msg.market?.question || ''), 'success');
      if (xrplWallet) {
        issueCredit();
        fetchXrplBalances();
      }
      fetchSuggestions();
      break;
    case 'marketResolved':
      updateStatus('Market resolved: ' + msg.market.outcome, 'success');
      break;
    case 'registered':
      break;
    case 'error':
      updateStatus(msg.message, 'error');
      break;
    default:
      if (msg.type) console.log('Unknown message type:', msg.type);
  }
}

function updateBalance(balance) {
  const el = document.getElementById('balance-value');
  if (el) el.textContent = '$' + Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function updateOracleTime(seconds) {
  const el = document.getElementById('oracle-value');
  if (el) el.textContent = seconds + 's';
}

function midFromBook(book) {
  if (!book) return null;
  const buys = book.buys || [];
  const sells = book.sells || [];
  const bestBid = buys.length ? buys[0].price : null;
  const bestAsk = sells.length ? sells[0].price : null;
  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  if (bestBid != null) return bestBid;
  if (bestAsk != null) return bestAsk;
  return null;
}

function addChartPoint(yesPrice) {
  if (!yesSeries) return;
  const t = Math.floor(Date.now() / 1000);
  yesSeries.update({ time: t, value: yesPrice });
}

function seedChartWithBaseline() {
  if (!yesSeries) return;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 120; i >= 0; i -= 4) {
    yesSeries.update({ time: now - i, value: BASELINE_PROBABILITY });
  }
}

function updateStatus(text, type) {
  const el = document.getElementById('order-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'order-status ' + type;
  if (type === 'success') setTimeout(() => { el.textContent = ''; el.className = 'order-status'; }, 4000);
}

function renderOrderBook(book) {
  const bidsEl = document.getElementById('bids-list');
  const asksEl = document.getElementById('asks-list');
  if (!bidsEl || !asksEl || !book) return;
  const buys = book.buys || [];
  const sells = book.sells || [];
  bidsEl.innerHTML = buys.length ? buys.slice(0, 8).map(b => '<div class="book-row bid-row"><span>' + (b.price * 100).toFixed(0) + '¢</span><span>' + (b.remainingAmount || b.amount) + '</span></div>').join('') : '<div class="book-empty">No bids</div>';
  asksEl.innerHTML = sells.length ? sells.slice(0, 8).map(a => '<div class="book-row ask-row"><span>' + (a.price * 100).toFixed(0) + '¢</span><span>' + (a.remainingAmount || a.amount) + '</span></div>').join('') : '<div class="book-empty">No asks</div>';
}

async function placeOrderXrpl(orderSide) {
  if (!xrplWallet) {
    updateStatus('Connect XRPL wallet first', 'error');
    return;
  }
  const priceInput = parseFloat(document.getElementById('target-price').value);
  const amount = parseInt(document.getElementById('quantity').value, 10);
  const checkedRadio = document.querySelector('input[name="outcome"]:checked');
  const side = checkedRadio ? checkedRadio.value : 'YES';
  if (!priceInput || priceInput <= 0 || priceInput >= 100) {
    updateStatus('Price must be 1–99 (cents)', 'error');
    return;
  }
  if (!amount || amount <= 0) {
    updateStatus('Enter a valid quantity', 'error');
    return;
  }
  const price = priceInput / 100;
  try {
    updateStatus('Submitting to XRPL...', 'success');
    await apiFetch('/api/xrpl/trade', {
      method: 'POST',
      body: JSON.stringify({
        viewerSecret: xrplWallet.secret,
        marketId: currentXrplMarketId,
        side,
        orderSide,
        amount,
        price,
      }),
    });
    updateStatus(orderSide + ' order submitted on-chain', 'success');
    await fetchXrplBalances();
  } catch (e) {
    updateStatus(e.message || 'Trade failed', 'error');
  }
}

function placeOrder(orderSide) {
  if (xrplWallet) {
    placeOrderXrpl(orderSide);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    updateStatus('Connect XRPL wallet or wait for server', 'error');
    return;
  }
  const priceInput = parseFloat(document.getElementById('target-price').value);
  const amount = parseInt(document.getElementById('quantity').value, 10);
  const checkedRadio = document.querySelector('input[name="outcome"]:checked');
  const side = checkedRadio ? checkedRadio.value : 'YES';
  if (!priceInput || priceInput <= 0 || priceInput >= 100) {
    updateStatus('Price must be 1–99 (cents)', 'error');
    return;
  }
  if (!amount || amount <= 0) {
    updateStatus('Enter a valid quantity', 'error');
    return;
  }
  const price = priceInput / 100;
  ws.send(JSON.stringify({
    action: 'placeOrder',
    userId,
    marketId: currentMarket ? currentMarket.id : 'default',
    side,
    orderSide,
    price,
    amount,
  }));
  updateStatus('Sending ' + orderSide + ' ' + amount + 'x ' + side + ' @ ' + priceInput + '¢...', 'success');
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  renderPortfolio();
  try {
    const stored = typeof chrome !== 'undefined' && chrome.storage?.local
      ? await chrome.storage.local.get(NEWS_STORAGE_KEY)
      : {};
    currentArticles = stored[NEWS_STORAGE_KEY] || [];
    renderNews(currentArticles);
  } catch (_) {
    renderNews([]);
  }
  setInterval(refreshTimestamps, 30_000);

  window.addEventListener('tradeTabShown', () => {
    try { initChart(); } catch (err) { console.error('Chart init failed:', err); }
    fetchSuggestions();
  });

  if (document.getElementById('chart-container')) {
    const buyBtn = document.getElementById('btn-buy');
    const sellBtn = document.getElementById('btn-sell');
    if (buyBtn) buyBtn.addEventListener('click', () => placeOrder('BUY'));
    if (sellBtn) sellBtn.addEventListener('click', () => placeOrder('SELL'));

    const fundBtn = document.getElementById('btn-fund-wallet');
    const importBtn = document.getElementById('btn-import-secret');
    const disconnectBtn = document.getElementById('btn-disconnect');
    const secretInput = document.getElementById('xrpl-secret');

    if (fundBtn) {
      fundBtn.addEventListener('click', async () => {
        try {
          fundBtn.disabled = true;
          updateStatus('Creating testnet wallet...', 'success');
          const { address, secret } = await apiFetch('/testnet/fund', { method: 'POST' });
          xrplWallet = { address, secret };
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            await chrome.storage.local.set({ [XRPL_STORAGE_KEY]: xrplWallet });
          }
          await bootstrapXrpl();
          await issueCredit();
          await fetchXrplBalances();
          renderXrplUI(true);
          setConnectionStatus('XRPL', '#22c55e');
          updateStatus('Wallet funded! 1000 CREDIT issued.', 'success');
        } catch (e) {
          updateStatus(e.message || 'Fund failed', 'error');
        } finally {
          fundBtn.disabled = false;
        }
      });
    }
    if (importBtn && secretInput) {
      importBtn.addEventListener('click', async () => {
        const secret = (secretInput.value || '').trim();
        if (!secret) {
          updateStatus('Paste your wallet secret', 'error');
          return;
        }
        try {
          importBtn.disabled = true;
          await connectXrpl(secret);
          secretInput.value = '';
        } catch (e) {
          updateStatus(e.message || 'Import failed', 'error');
        } finally {
          importBtn.disabled = false;
        }
      });
    }
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', disconnectXrpl);
    }

    connect(); // Always connect for marketCreated / marketResolved broadcasts
    try {
      const stored = typeof chrome !== 'undefined' && chrome.storage?.local
        ? await chrome.storage.local.get(XRPL_STORAGE_KEY)
        : {};
      const saved = stored[XRPL_STORAGE_KEY];
      if (saved?.address && saved?.secret) {
        xrplWallet = saved;
        await fetchCurrentMarket();
        await bootstrapXrpl().catch(() => {});
        await fetchXrplBalances();
        renderXrplUI(true);
        setConnectionStatus('XRPL', '#22c55e');
      }
    } catch (_) {}
  }
});
