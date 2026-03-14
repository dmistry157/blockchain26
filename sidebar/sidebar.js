// ── Portfolio (dummy) ──

const PORTFOLIO = {
  totalValue: 48_372.15,
  dayChange: 1_243.67,
  dayChangePercent: 2.64,
  holdings: [
    { ticker: 'AAPL', price: 198.12, change: +1.32 },
    { ticker: 'TSLA', price: 241.37, change: -0.85 },
    { ticker: 'NVDA', price: 875.28, change: +3.14 },
    { ticker: 'MSFT', price: 415.60, change: +0.47 },
  ],
};

// ── News (live from RSS via background) ──

const NEWS_STORAGE_KEY = 'newsFeedArticles';
let currentArticles = [];

// ── Helpers ──

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
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// ── Render portfolio ──

function renderPortfolio() {
  document.getElementById('portfolio-date').textContent =
    new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  document.getElementById('portfolio-value').textContent =
    formatCurrency(PORTFOLIO.totalValue);

  const changeEl = document.getElementById('portfolio-change');
  const sign = PORTFOLIO.dayChange >= 0 ? '+' : '';
  changeEl.querySelector('.change-amount').textContent =
    `${sign}${formatCurrency(PORTFOLIO.dayChange)}`;
  changeEl.querySelector('.change-percent').textContent =
    `(${sign}${PORTFOLIO.dayChangePercent.toFixed(2)}%)`;
  changeEl.classList.toggle('positive', PORTFOLIO.dayChange >= 0);
  changeEl.classList.toggle('negative', PORTFOLIO.dayChange < 0);

  document.getElementById('portfolio-holdings').innerHTML = PORTFOLIO.holdings.map(h => {
    const dir = h.change >= 0 ? 'up' : 'down';
    const arrow = h.change >= 0 ? '\u25B2' : '\u25BC';
    return `<div class="holding-chip">
      <span class="ticker">${esc(h.ticker)}</span>
      <span class="price">${formatCurrency(h.price)}</span>
      <span class="chip-change ${dir}">${arrow} ${Math.abs(h.change).toFixed(2)}%</span>
    </div>`;
  }).join('');
}

// ── Render news ──

function renderNews(articles, animateNew = false) {
  const feed = document.getElementById('news-feed');
  if (!articles.length) {
    feed.innerHTML = '<div class="news-loading">Loading news\u2026</div>';
    return;
  }

  feed.innerHTML = articles.map((a, i) => {
    const href = isHttpUrl(a.link) ? esc(a.link) : '#';
    const cls = animateNew && i === 0 ? ' slide-in' : '';
    return `<a class="news-card${cls}" href="${href}" target="_blank" rel="noopener noreferrer" data-pubdate="${esc(a.pubDate)}">
      <div class="news-card-source">
        <span class="source-dot" style="background:${esc(a.color)}"></span>
        <span>${esc(a.source)}</span>
        <span class="news-card-time">${timeAgo(a.pubDate)}</span>
      </div>
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.summary)}</p>
    </a>`;
  }).join('');
}

// ── Toast for new articles ──

function showToast(count) {
  let toast = document.getElementById('new-articles-toast');
  if (!toast) {
    toast = document.createElement('button');
    toast.id = 'new-articles-toast';
    document.getElementById('news').appendChild(toast);
    toast.addEventListener('click', () => {
      document.getElementById('news-feed').scrollTo({ top: 0, behavior: 'smooth' });
      toast.classList.remove('visible');
    });
  }
  toast.textContent = `\u2191 ${count} new article${count > 1 ? 's' : ''}`;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 6000);
}

// ── Message listener (from background service worker) ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'newNewsAvailable') {
    const { articles, newCount } = msg.payload;
    currentArticles = articles;
    const feed = document.getElementById('news-feed');
    const scrolledDown = feed.scrollTop > 120;
    renderNews(articles, true);
    if (scrolledDown && newCount > 0) showToast(newCount);
  }
  sendResponse({ received: true });
});

// ── Live-update relative timestamps every 30s ──

function refreshTimestamps() {
  document.querySelectorAll('[data-pubdate]').forEach(el => {
    const ts = el.querySelector('.news-card-time');
    if (ts) ts.textContent = timeAgo(el.dataset.pubdate);
  });
}

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  renderPortfolio();

  // Load cached articles immediately
  try {
    const stored = await chrome.storage.local.get(NEWS_STORAGE_KEY);
    currentArticles = stored[NEWS_STORAGE_KEY] || [];
    renderNews(currentArticles);
  } catch (_) {
    renderNews([]);
  }

  setInterval(refreshTimestamps, 30_000);
});
