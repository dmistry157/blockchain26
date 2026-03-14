import { notifyMessage } from '../modules/messaging.js';
import {
  saveConversation,
  findConversationByConversationId
} from '../modules/history-manager.js';
import { t, initializeLanguage } from '../modules/i18n.js';

// T008 & T065: Install event - setup context menus and configure side panel
const DEFAULT_SHORTCUT_SETTING = { keyboardShortcutEnabled: true };
let keyboardShortcutEnabled = true;

// T070: Track side panel state per window
const sidePanelState = new Map(); // windowId -> boolean (true = open, false = closed)

async function loadShortcutSetting() {
  try {
    const result = await chrome.storage.sync.get(DEFAULT_SHORTCUT_SETTING);
    keyboardShortcutEnabled = result.keyboardShortcutEnabled;
  } catch (error) {
    // Fallback to default if storage unavailable
    keyboardShortcutEnabled = true;
  }
}

// T070: Helper to toggle side panel
async function toggleSidePanel(windowId, action = null) {
  if (!windowId) {
    return;
  }

  const isOpen = sidePanelState.get(windowId) || false;

  if (!isOpen) {
    // Open the side panel
    try {
      await chrome.sidePanel.open({ windowId });
      sidePanelState.set(windowId, true);
    } catch (error) {
      // Silently fail - side panel may not be available
    }
  } else {
    // Close the side panel by sending message to sidebar
    try {
      await notifyMessage({ action: 'closeSidePanel', payload: {} });
      sidePanelState.set(windowId, false);
    } catch (error) {
      // Even if message fails, assume it's closed
      sidePanelState.set(windowId, false);
    }
  }
}

async function configureActionBehavior() {
  // Always handle action clicks ourselves so we can respect the toggle state.
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (error) {
    // Silently fail if API not available
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await createContextMenus();
  await loadShortcutSetting();
  await configureActionBehavior();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadShortcutSetting();
  await configureActionBehavior();
});

// T065-T068: Create/update context menus dynamically based on enabled providers
async function createContextMenus() {
  // Remove all existing menus
  await chrome.contextMenus.removeAll();

  // Initialize language before creating menus
  await initializeLanguage();

  // Get enabled providers from settings
  const settings = await chrome.storage.sync.get({
    enabledProviders: ['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek', 'copilot']
  });

  const enabledProviders = settings.enabledProviders;

  // Create main context menu item
  chrome.contextMenus.create({
    id: 'open-smarter-panel',
    title: t('contextMenuSendTo'),
    contexts: ['page', 'selection', 'link']
  });

  // Create submenu for each enabled provider
  const providerNames = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
    grok: 'Grok',
    deepseek: 'DeepSeek',
    google: 'Google',
    copilot: 'Microsoft Copilot'
  };

  enabledProviders.forEach(providerId => {
    chrome.contextMenus.create({
      id: `provider-${providerId}`,
      parentId: 'open-smarter-panel',
      title: providerNames[providerId] || providerId,
      contexts: ['page', 'selection', 'link']
    });
  });

  // Add Prompt Library option
  chrome.contextMenus.create({
    id: 'open-prompt-library',
    parentId: 'open-smarter-panel',
    title: t('contextMenuPromptLibrary'),
    contexts: ['page', 'selection', 'link']
  });
}

// T066: Listen for settings changes and update context menus
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.enabledProviders || changes.language) {
    createContextMenus();
  }
});

// T009 & T067-T068 & T070: Context menu click handler with state tracking
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab || !tab.windowId) {
      return;
    }

    if (info.menuItemId.startsWith('provider-')) {
      const providerId = info.menuItemId.replace('provider-', '');

      // Open side panel and track state
      await chrome.sidePanel.open({ windowId: tab.windowId });
      sidePanelState.set(tab.windowId, true);

      // Get source URL placement setting
      const settings = await chrome.storage.sync.get({ sourceUrlPlacement: 'end' });
      const placement = settings.sourceUrlPlacement;

      // Check if text is selected
      if (info.selectionText) {
        // Format content with source based on user preference
        let contentToSend;
        if (placement === 'none') {
          contentToSend = info.selectionText;
        } else if (placement === 'beginning') {
          contentToSend = `Source: ${info.pageUrl}\n\n${info.selectionText}`;
        } else {
          // default: 'end'
          contentToSend = `${info.selectionText}\n\nSource: ${info.pageUrl}`;
        }

        // Wait for sidebar to load, then send message to switch provider
        setTimeout(() => {
          notifyMessage({
            action: 'switchProvider',
            payload: { providerId, selectedText: contentToSend }
          }).catch(() => {
            // Sidebar may not be ready yet, silently ignore
          });
        }, 100);
      } else {
        // No text selected - extract page content
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'extractPageContent'
          });

          if (response && response.success) {
            // Send extracted content to sidebar
            setTimeout(() => {
              notifyMessage({
                action: 'switchProvider',
                payload: { providerId, selectedText: response.content }
              }).catch(() => {
                // Sidebar may not be ready yet, silently ignore
              });
            }, 100);
          } else {
            // Extraction failed - send empty to provider
            setTimeout(() => {
              notifyMessage({
                action: 'switchProvider',
                payload: { providerId, selectedText: '' }
              }).catch(() => {});
            }, 100);
          }
        } catch (error) {
          // Content script not ready or extraction failed
          // Send empty to provider
          setTimeout(() => {
            notifyMessage({
              action: 'switchProvider',
              payload: { providerId, selectedText: '' }
            }).catch(() => {});
          }, 100);
        }
      }
    } else if (info.menuItemId === 'open-prompt-library') {
      // Open side panel with prompt library and track state
      await chrome.sidePanel.open({ windowId: tab.windowId });
      sidePanelState.set(tab.windowId, true);

      // Get source URL placement setting
      const settings = await chrome.storage.sync.get({ sourceUrlPlacement: 'end' });
      const placement = settings.sourceUrlPlacement;

      // Check if text is selected
      if (info.selectionText) {
        // Format content with source based on user preference
        let contentToSend;
        if (placement === 'none') {
          contentToSend = info.selectionText;
        } else if (placement === 'beginning') {
          contentToSend = `Source: ${info.pageUrl}\n\n${info.selectionText}`;
        } else {
          // default: 'end'
          contentToSend = `${info.selectionText}\n\nSource: ${info.pageUrl}`;
        }

        // Wait for sidebar to load, then switch to prompt library
        setTimeout(() => {
          notifyMessage({
            action: 'openPromptLibrary',
            payload: { selectedText: contentToSend }
          }).catch(() => {
            // Sidebar may not be ready yet, ignore error
          });
        }, 100);
      } else {
        // No text selected - extract page content
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'extractPageContent'
          });

          if (response && response.success) {
            // Send extracted content to sidebar
            setTimeout(() => {
              notifyMessage({
                action: 'openPromptLibrary',
                payload: { selectedText: response.content }
              }).catch(() => {
                // Sidebar may not be ready yet, ignore error
              });
            }, 100);
          } else {
            // Extraction failed - send empty
            setTimeout(() => {
              notifyMessage({
                action: 'openPromptLibrary',
                payload: { selectedText: '' }
              }).catch(() => {});
            }, 100);
          }
        } catch (error) {
          // Content script not ready or extraction failed
          // Send empty
          setTimeout(() => {
            notifyMessage({
              action: 'openPromptLibrary',
              payload: { selectedText: '' }
            }).catch(() => {});
          }, 100);
        }
      }
    }
  } catch (error) {
    // Silently handle context menu errors
  }
});

// T010 & T070: Handle action clicks (toolbar or `_execute_action` command) with toggle
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.windowId) {
    return;
  }

  if (!keyboardShortcutEnabled) {
    return;
  }

  await toggleSidePanel(tab.windowId);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'sync') return;

  if (changes.keyboardShortcutEnabled) {
    keyboardShortcutEnabled = changes.keyboardShortcutEnabled.newValue !== false;
  }
});

// T070: Clean up state when windows are closed
chrome.windows.onRemoved.addListener((windowId) => {
  sidePanelState.delete(windowId);
});

// T070: Listen for sidebar close notifications, conversation saves, and duplicate checks
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sidePanelClosed') {
    // Get windowId from sender
    if (sender.tab && sender.tab.windowId) {
      sidePanelState.set(sender.tab.windowId, false);
    }
    sendResponse({ success: true });
  } else if (message.action === 'saveConversationFromPage') {
    // Handle conversation save from ChatGPT page
    handleSaveConversation(message.payload, sender).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'checkDuplicateConversation') {
    // Handle duplicate check request
    handleCheckDuplicate(message.payload).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'fetchLatestCommit') {
    // T073: Handle version check request from options page
    handleFetchLatestCommit().then(sendResponse);
    return true; // Keep channel open for async response
  }
  return true;
});

// T073: Handle version check by fetching latest commit from GitHub API
async function handleFetchLatestCommit() {
  try {
    const GITHUB_API_URL = 'https://api.github.com/repos/xiaolai/insidebar-ai/commits/main';

    const response = await fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      success: true,
      data: {
        sha: data.sha,
        shortSha: data.sha.substring(0, 7),
        date: data.commit.committer.date,
        message: data.commit.message
      }
    };
  } catch (error) {
    console.error('[Background] Error fetching latest commit:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Handle duplicate conversation check - now with direct database access
async function handleCheckDuplicate(payload) {
  try {
    const { conversationId } = payload;

    if (!conversationId) {
      return { isDuplicate: false };
    }

    // Query IndexedDB directly without requiring sidebar
    const existingConversation = await findConversationByConversationId(conversationId);

    if (existingConversation) {
      return {
        isDuplicate: true,
        existingConversation: existingConversation
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    console.error('[Background] Error checking duplicate:', error);
    // Propagate error instead of silently returning false
    throw error;
  }
}

// Handle saving conversation - now with direct database access
async function handleSaveConversation(conversationData, sender) {
  try {
    // Save directly to IndexedDB without requiring sidebar
    const savedConversation = await saveConversation(conversationData);

    // Notify sidebar to refresh chat history if it's open
    try {
      await notifyMessage({
        action: 'refreshChatHistory',
        payload: { conversationId: savedConversation.id }
      });
    } catch (error) {
      // Sidebar may not be open, that's okay
    }

    // Get user setting for auto-opening sidebar
    const settings = await chrome.storage.sync.get({
      autoOpenSidebarOnSave: false
    });

    // Optionally open sidebar and switch to chat history
    if (settings.autoOpenSidebarOnSave && sender.tab) {
      const windowId = sender.tab.windowId;
      const isOpen = sidePanelState.get(windowId) || false;

      if (!isOpen && windowId) {
        try {
          // This will work because it's within the user gesture flow
          await chrome.sidePanel.open({ windowId });
          sidePanelState.set(windowId, true);

          // Wait for sidebar to load, then switch to chat history
          setTimeout(() => {
            notifyMessage({
              action: 'switchToChatHistory',
              payload: { conversationId: savedConversation.id }
            }).catch(() => {
              // Sidebar may not be ready, ignore
            });
          }, 300);
        } catch (error) {
          // If sidebar opening fails, it's okay - the save already succeeded
          console.warn('[Background] Could not open sidebar after save:', error.message);
        }
      }
    }

    return { success: true, data: savedConversation };
  } catch (error) {
    console.error('[Background] Error saving conversation:', error);
    return { success: false, error: error.message };
  }
}

// T069 & T070: Listen for keyboard shortcuts with toggle support
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab || !tab.windowId) {
    return;
  }

  const windowId = tab.windowId;
  const isOpen = sidePanelState.get(windowId) || false;

  if (command === 'open-prompt-library') {
    if (!isOpen) {
      // Open and switch to Prompt Library
      try {
        await chrome.sidePanel.open({ windowId });
        sidePanelState.set(windowId, true);

        // Wait for sidebar to load, then switch to Prompt Library
        setTimeout(() => {
          notifyMessage({
            action: 'openPromptLibrary',
            payload: {}
          }).catch(() => {
            // Sidebar may not be ready yet, ignore error
          });
        }, 100);
      } catch (error) {
        // Silently handle errors
      }
    } else {
      // Close side panel (toggle off)
      try {
        await notifyMessage({ action: 'closeSidePanel', payload: {} });
        sidePanelState.set(windowId, false);
      } catch (error) {
        // Even if message fails, assume it's closed
        sidePanelState.set(windowId, false);
      }
    }
  } else if (command === 'toggle-focus') {
    // Toggle focus between sidebar and main page
    if (!isOpen) {
      // Sidebar not open - open it (it will auto-focus)
      try {
        await chrome.sidePanel.open({ windowId });
        sidePanelState.set(windowId, true);
      } catch (error) {
        // Silently handle errors
      }
    } else {
      // Sidebar is open - toggle focus between sidebar and page
      try {
        // Check if sidebar has focus
        const sidebarResponse = await notifyMessage({
          action: 'checkFocus',
          payload: {}
        });

        if (sidebarResponse && sidebarResponse.hasFocus) {
          // Sidebar has focus - switch to page input
          if (tab && tab.id) {
            try {
              await chrome.tabs.sendMessage(tab.id, { action: 'takeFocus' });
            } catch (error) {
              // Content script may not be available
            }
          }
        } else {
          // Page has focus (or unknown) - switch to sidebar
          await notifyMessage({
            action: 'takeFocus',
            payload: {}
          });
        }
      } catch (error) {
        // If sidebar messaging fails, try to focus sidebar anyway
        try {
          await notifyMessage({
            action: 'takeFocus',
            payload: {}
          });
        } catch (e) {
          // Silently handle errors
        }
      }
    }
  }
});

// ═══════════════════════════════════════════════════════
// RSS News Feed – polls every 10 seconds
// ═══════════════════════════════════════════════════════

const RSS_FEEDS = [
  { url: 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en', source: 'Google News', color: '#4285f4' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', source: 'BBC Business', color: '#bb1919' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', source: 'NY Times', color: '#567b95' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', source: 'CNBC', color: '#005594' },
];

const NEWS_STORAGE_KEY = 'newsFeedArticles';
const NEWS_POLL_INTERVAL = 10_000; // 10 seconds

function parseRSSItems(xmlText, feedMeta) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];

    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>\s*([\s\S]*?)\s*<\/link>/) || [])[1]
              || (block.match(/<link\s*\/>\s*(\S+)/) || [])[1]
              || '';
    const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    // Google News exposes <source> per item
    const sourceTag = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];

    const cleanTitle = title.replace(/<[^>]*>/g, '').trim();
    const cleanDesc = desc.replace(/<[^>]*>/g, '').trim().slice(0, 250);

    if (cleanTitle) {
      items.push({
        id: link.trim() || cleanTitle,
        title: cleanTitle,
        summary: cleanDesc,
        link: link.trim(),
        pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        source: sourceTag ? sourceTag.trim() : feedMeta.source,
        color: feedMeta.color,
      });
    }
  }
  return items;
}

async function fetchRSSFeed(feed) {
  try {
    const resp = await fetch(feed.url, {
      headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    return parseRSSItems(text, feed);
  } catch (err) {
    console.warn(`[News] Failed to fetch ${feed.source}:`, err.message);
    return [];
  }
}

async function pollNews() {
  try {
    const results = await Promise.allSettled(RSS_FEEDS.map(f => fetchRSSFeed(f)));
    const allItems = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // Newest first
    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // Deduplicate by normalised title prefix
    const seen = new Set();
    const unique = allItems.filter(item => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const articles = unique.slice(0, 50);

    // Detect new articles compared to cache
    const stored = await chrome.storage.local.get(NEWS_STORAGE_KEY);
    const oldIds = new Set((stored[NEWS_STORAGE_KEY] || []).map(a => a.id));
    const newCount = articles.filter(a => !oldIds.has(a.id)).length;

    // Persist
    await chrome.storage.local.set({ [NEWS_STORAGE_KEY]: articles });

    // Push to sidebar
    if (newCount > 0) {
      try {
        await notifyMessage({
          action: 'newNewsAvailable',
          payload: { articles, newCount }
        });
      } catch (_) { /* sidebar may be closed */ }
    }
  } catch (err) {
    console.error('[News] Poll error:', err);
  }
}

// Polling lifecycle
let newsInterval = null;

function startNewsPolling() {
  pollNews();
  if (newsInterval) clearInterval(newsInterval);
  newsInterval = setInterval(pollNews, NEWS_POLL_INTERVAL);
}

// Alarm-based keepalive so the SW restarts polling if it dies
chrome.alarms.create('newsKeepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'newsKeepalive' && !newsInterval) {
    startNewsPolling();
  }
});

startNewsPolling();
