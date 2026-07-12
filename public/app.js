// ==========================================================================
// BreakoutPulse - Frontend App Script
// ==========================================================================

let socket;
let currentConfig = {};
let alertHistory = [];
let activeSymbol = "AAPL";
let activeType = "stock";
let currentFilter = "all";

// DOM Elements
const wsStatusDot = document.getElementById('ws-status-dot');
const wsStatusText = document.getElementById('ws-status-text');
const watchlistContainer = document.getElementById('watchlist-container');
const alertsContainer = document.getElementById('alerts-container');
const activeChartTitle = document.getElementById('active-chart-title');
const activeChartBadge = document.getElementById('active-chart-badge');
const btnAddWatchlist = document.getElementById('btn-add-watchlist');
const watchlistInputGroup = document.getElementById('watchlist-input-group');
const inputTicker = document.getElementById('input-ticker');
const selectType = document.getElementById('select-type');
const btnSaveTicker = document.getElementById('btn-save-ticker');
const integrationsForm = document.getElementById('integrations-form');
const btnTestAlert = document.getElementById('btn-test-alert');

// Integrations inputs
const discordEnabled = document.getElementById('discord-enabled');
const discordWebhook = document.getElementById('discord-webhook');
const telegramEnabled = document.getElementById('telegram-enabled');
const telegramToken = document.getElementById('telegram-token');
const telegramChatId = document.getElementById('telegram-chatid');
const ntfyEnabled = document.getElementById('ntfy-enabled');
const ntfyTopic = document.getElementById('ntfy-topic');

// Sound checkbox & browser notification button/badge
const checkSound = document.getElementById('check-sound');
const btnEnableNotify = document.getElementById('btn-enable-notify');
const notifyStatusBadge = document.getElementById('notify-status-badge');
const notifyHintText = document.getElementById('notify-hint-text');

// Track whether browser notifications are enabled
let browserNotifyEnabled = false;

// Web Audio API Synthesizer Alert Sound
function playAlertSound() {
  if (!checkSound.checked) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    const playTone = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(0.12, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    
    // Play a premium, glowing upward chime (C major triad chord)
    const now = ctx.currentTime;
    playTone(523.25, now, 0.3);        // C5
    playTone(659.25, now + 0.08, 0.3);  // E5
    playTone(783.99, now + 0.16, 0.5);  // G5
  } catch (err) {
    console.error('Audio synthesis failed:', err);
  }
}

// Currency symbol helper — ₹ for Indian symbols, $ for everything else
function getCurrencySymbol(symbol) {
  if (!symbol) return '$';
  const s = symbol.toUpperCase().replace(/\s+/g, '');
  const indianPatterns = [
    'NIFTY', 'BANKNIFTY', 'NIFTYBANK', 'SENSEX',
    'NIFTYBEES', 'NIFTYMIDCAP', 'NIFTYIT', 'NIFTYPHARMA',
    'NIFTYFMCG', 'NIFTYAUTO', 'NIFTYMETAL', 'NIFTYREALTY',
    'NSEI', 'NSEBANK', 'BSESN'
  ];
  if (indianPatterns.some(p => s.includes(p))) return '₹';
  if (s.endsWith('.NS') || s.endsWith('.BO')) return '₹';
  if (s.startsWith('NSE:') || s.startsWith('BSE:')) return '₹';
  if (s === '^NSEI' || s === '^NSEBANK' || s === '^BSESN') return '₹';
  return '$';
}

// === Browser Notification Permission Button ===

function updateNotifyUI() {
  const perm = Notification.permission;
  if (perm === 'granted') {
    browserNotifyEnabled = true;
    notifyStatusBadge.textContent = '✓ Enabled';
    notifyStatusBadge.className = 'notify-badge badge-granted';
    btnEnableNotify.textContent = '✓ Browser Alerts Active';
    btnEnableNotify.classList.add('granted');
    if (notifyHintText) notifyHintText.style.display = 'none';
  } else if (perm === 'denied') {
    browserNotifyEnabled = false;
    notifyStatusBadge.textContent = '✗ Denied in Browser';
    notifyStatusBadge.className = 'notify-badge badge-blocked';
    btnEnableNotify.innerHTML = '<i class="fa-solid fa-bell-slash"></i> Notifications Blocked';
    btnEnableNotify.classList.remove('granted');
    if (notifyHintText) notifyHintText.innerHTML = '⚠️ You have blocked notifications. Click the 🔒 lock icon in your browser address bar → <b>Notifications → Allow</b>, then refresh.';
  } else {
    browserNotifyEnabled = false;
    notifyStatusBadge.textContent = 'Not Enabled';
    notifyStatusBadge.className = 'notify-badge badge-blocked';
    btnEnableNotify.innerHTML = '<i class="fa-solid fa-bell"></i> Enable Browser Alerts';
    btnEnableNotify.classList.remove('granted');
    if (notifyHintText) notifyHintText.style.display = '';
  }
}

if (btnEnableNotify) {
  btnEnableNotify.addEventListener('click', async () => {
    if (Notification.permission === 'granted') return; // already enabled
    try {
      const permission = await Notification.requestPermission();
      updateNotifyUI();
      if (permission === 'granted') {
        // Fire a test notification immediately to confirm
        new Notification('BreakoutPulse Alerts Active! 🚀', {
          body: 'You will now receive live trading breakout alerts in this browser.',
          icon: '/favicon.ico'
        });
      }
    } catch (err) {
      console.error('Notification permission error:', err);
    }
  });
}

// Check existing permission state on load
if (typeof Notification !== 'undefined') {
  updateNotifyUI();
}

function showDesktopNotification(alert) {
  if (!browserNotifyEnabled || Notification.permission !== 'granted') return;
  try {
    const dirEmoji = alert.direction === 'UP' ? '📈' : '📉';
    const curr = getCurrencySymbol(alert.symbol);
    const title = `${dirEmoji} ${alert.symbol} Breakout Alert!`;
    const options = {
      body: `Price: ${curr}${alert.price.toFixed(2)} (${alert.changePercent > 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%)\nSignal: ${alert.breakoutType.replace(/_/g, ' ')}\nSentiment: ${alert.sentimentLabel} | Confidence: ${alert.confidence}`,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: alert.symbol,
      renotify: true
    };
    new Notification(title, options);
  } catch (err) {
    console.error('Notification failed:', err);
  }
}

// === ntfy.sh Mobile Push ===
async function sendNtfyNotification(alert) {
  const topic = ntfyTopic ? ntfyTopic.value.trim() : '';
  if (!ntfyEnabled || !ntfyEnabled.checked || !topic) return;
  try {
    const dirEmoji = alert.direction === 'UP' ? '📈' : '📉';
    const curr = getCurrencySymbol(alert.symbol);
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title': `${dirEmoji} ${alert.symbol} ${alert.direction === 'UP' ? 'Bullish' : 'Bearish'} Breakout`,
        'Priority': alert.confidence === 'HIGH' ? 'urgent' : 'high',
        'Tags': alert.direction === 'UP' ? 'chart_increasing' : 'chart_decreasing'
      },
      body: `Price: ${curr}${alert.price.toFixed(2)} (${alert.changePercent > 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%)\nSignal: ${alert.breakoutType.replace(/_/g, ' ')}\nSentiment: ${alert.sentimentLabel}\nConfidence: ${alert.confidence}`
    });
    console.log(`ntfy push sent to topic: ${topic}`);
  } catch (err) {
    console.error('ntfy push failed:', err);
  }
}

// Initialize WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('WebSocket connected.');
    wsStatusDot.className = 'status-dot connected';
    wsStatusText.innerText = 'Connected';
  };
  
  socket.onclose = () => {
    console.log('WebSocket disconnected. Retrying in 5s...');
    wsStatusDot.className = 'status-dot disconnected';
    wsStatusText.innerText = 'Disconnected. Retrying...';
    setTimeout(connectWebSocket, 5000);
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket Error:', error);
  };
  
  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    switch (payload.type) {
      case 'CONFIG':
        currentConfig = payload.data;
        updateConfigUI();
        break;
      case 'HISTORY':
        alertHistory = payload.data;
        renderAlerts();
        break;
      case 'ALERT':
        alertHistory.unshift(payload.data);
        if (alertHistory.length > 500) alertHistory.pop();
        renderAlerts();
        playAlertSound();
        showDesktopNotification(payload.data);
        sendNtfyNotification(payload.data);
        // Automatically focus on the alert symbol chart if it's the active one
        if (payload.data.symbol === activeSymbol) {
          loadTradingViewChart(activeSymbol, activeType);
        }
        break;
    }
  };
}

// Load TradingView Widget
function loadTradingViewChart(symbol, type) {
  activeSymbol = symbol;
  activeType = type;
  activeChartTitle.innerText = symbol;
  activeChartBadge.innerText = type;
  activeChartBadge.className = `badge ${type}-badge`;

  // Standardize symbol for TradingView (Crypto often maps to exchange pairs, Indices map to exchange specific tickers)
  let tvSymbol = symbol.toUpperCase().replace(/\s+/g, '');
  if (tvSymbol === '^NSEI' || tvSymbol === 'NIFTY' || tvSymbol === 'NIFTY50' || tvSymbol === 'NIFTY50INDEX' || tvSymbol === 'NIFTYINDEX' || tvSymbol === 'NSE:NIFTY' || tvSymbol === 'NIFTYBEES' || tvSymbol === 'NSE:NIFTYBEES') {
    tvSymbol = 'NASDAQ:INDY';
  } else if (tvSymbol === '^BSESN' || tvSymbol === 'SENSEX') {
    tvSymbol = 'BSE:SENSEXBEES';
  } else if (tvSymbol === '^NSEBANK' || tvSymbol === 'BANKNIFTY' || tvSymbol === 'NIFTYBANK') {
    tvSymbol = 'NSE:BANKBEES';
  } else if (type === 'crypto') {
    tvSymbol = symbol.replace('-USD', 'USD'); // BTC-USD -> BTCUSD
  } else {
    tvSymbol = symbol; // Fallback to raw symbol
  }

  // Inject widget
  new TradingView.widget({
    "autosize": true,
    "symbol": tvSymbol,
    "interval": "15",
    "timezone": "Etc/UTC",
    "theme": "dark",
    "style": "1",
    "locale": "en",
    "enable_publishing": false,
    "hide_side_toolbar": false,
    "allow_symbol_change": true,
    "container_id": "tv-chart-container"
  });
}

// Render Watchlist
function renderWatchlist() {
  watchlistContainer.innerHTML = '';
  if (!currentConfig.watchlist || currentConfig.watchlist.length === 0) {
    watchlistContainer.innerHTML = '<div class="loader-placeholder">No items in watchlist</div>';
    return;
  }
  
  currentConfig.watchlist.forEach(asset => {
    const item = document.createElement('div');
    item.className = `watchlist-item ${asset.symbol === activeSymbol ? 'active' : ''}`;
    item.onclick = () => {
      document.querySelectorAll('.watchlist-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      loadTradingViewChart(asset.symbol, asset.type);
    };

    item.innerHTML = `
      <div class="item-left">
        <span class="item-ticker">${asset.symbol}</span>
        <span class="item-type-badge">${asset.type}</span>
      </div>
      <div class="item-right">
        <button class="item-delete" onclick="event.stopPropagation(); deleteWatchlistItem('${asset.symbol}')">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;
    watchlistContainer.appendChild(item);
  });
}

// Delete Watchlist Item
async function deleteWatchlistItem(symbol) {
  const updatedWatchlist = currentConfig.watchlist.filter(item => item.symbol !== symbol);
  const updatedConfig = { ...currentConfig, watchlist: updatedWatchlist };
  
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedConfig)
    });
    const result = await response.json();
    if (result.success) {
      currentConfig.watchlist = updatedWatchlist;
      renderWatchlist();
      console.log(`Removed ${symbol} from watchlist.`);
    }
  } catch (err) {
    console.error('Error deleting watchlist item:', err);
  }
}

// Add Watchlist Item
btnSaveTicker.onclick = async () => {
  const symbol = inputTicker.value.trim().toUpperCase();
  const type = selectType.value;
  if (!symbol) return;

  // Avoid duplicates
  if (currentConfig.watchlist.some(item => item.symbol === symbol)) {
    alert('Ticker is already in the watchlist.');
    return;
  }

  const updatedWatchlist = [...currentConfig.watchlist, { symbol, type, name: `${symbol} Quote` }];
  const updatedConfig = { ...currentConfig, watchlist: updatedWatchlist };

  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedConfig)
    });
    const result = await response.json();
    if (result.success) {
      currentConfig.watchlist = updatedWatchlist;
      renderWatchlist();
      inputTicker.value = '';
      watchlistInputGroup.classList.add('hidden');
      console.log(`Added ${symbol} to watchlist.`);
    }
  } catch (err) {
    console.error('Error adding watchlist item:', err);
  }
};

// Render Alerts Log Stream
function renderAlerts() {
  alertsContainer.innerHTML = '';
  
  const filteredAlerts = alertHistory.filter(alert => {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'high') return alert.confidence === 'HIGH';
    if (currentFilter === 'bullish') return alert.direction === 'UP';
    if (currentFilter === 'bearish') return alert.direction === 'DOWN';
    return true;
  });

  if (filteredAlerts.length === 0) {
    alertsContainer.innerHTML = `
      <div class="empty-alerts">
        <i class="fa-solid fa-satellite-dish pulse-icon"></i>
        <p>No alerts match the active filter. Scanning feeds...</p>
      </div>
    `;
    return;
  }

  filteredAlerts.forEach(alert => {
    const card = document.createElement('div');
    card.className = `alert-card dir-${alert.direction.toLowerCase()}`;
    card.onclick = () => {
      loadTradingViewChart(alert.symbol, alert.type);
    };

    const formattedTime = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const sign = alert.changePercent > 0 ? '+' : '';
    
    let catalystHtml = '';
    if (alert.catalystNews) {
      catalystHtml = `
        <div class="alert-catalyst mt-1">
          <div class="catalyst-header">
            <i class="fa-solid fa-newspaper"></i> Catalyst News Feed
          </div>
          <div class="catalyst-title">${alert.catalystNews.title}</div>
          <div class="catalyst-link-row">
            <a href="${alert.catalystNews.link}" target="_blank" class="catalyst-link" onclick="event.stopPropagation();">
              Read Catalyst Article <i class="fa-solid fa-external-link-square"></i>
            </a>
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="alert-card-header">
        <div class="alert-card-left">
          <span class="alert-symbol">${alert.symbol}</span>
          <span class="alert-type-lbl">${alert.type.toUpperCase()}</span>
          <span class="alert-indicator ${alert.direction.toLowerCase()}">
            <i class="fa-solid ${alert.direction === 'UP' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i>
            ${alert.direction === 'UP' ? 'BULLISH' : 'BEARISH'}
          </span>
        </div>
        <div class="alert-card-right">
          <div class="alert-price-row">
            <span class="alert-price">${getCurrencySymbol(alert.symbol)}${alert.price.toFixed(2)}</span>
            <span class="alert-change ${alert.direction.toLowerCase()}">${sign}${alert.changePercent.toFixed(2)}%</span>
          </div>
          <span class="alert-time">${formattedTime}</span>
        </div>
      </div>
      
      <div class="alert-details-row">
        <span class="detail-badge db-signal">
          <i class="fa-solid fa-bolt"></i> ${alert.breakoutType.replace(/_/g, ' ')}
        </span>
        <span class="detail-badge db-sentiment ${alert.sentimentLabel.toLowerCase()}">
          <i class="fa-solid fa-face-smile-beam"></i> News Sentiment: ${alert.sentimentLabel}
        </span>
        <span class="detail-badge db-confidence ${alert.confidence}">
          <i class="fa-solid fa-award"></i> Confidence: ${alert.confidence}
        </span>
      </div>

      ${catalystHtml}
    `;
    
    alertsContainer.appendChild(card);
  });
}

// Update settings UI values from configuration payload
function updateConfigUI() {
  discordEnabled.checked = currentConfig.discord?.enabled || false;
  discordWebhook.value = currentConfig.discord?.webhookUrl || '';
  
  telegramEnabled.checked = currentConfig.telegram?.enabled || false;
  telegramToken.value = currentConfig.telegram?.botToken || '';
  telegramChatId.value = currentConfig.telegram?.chatId || '';

  if (ntfyEnabled) ntfyEnabled.checked = currentConfig.ntfy?.enabled || false;
  if (ntfyTopic) ntfyTopic.value = currentConfig.ntfy?.topic || '';
  
  renderWatchlist();
  
  // Set default chart to the first item in watchlist on load
  if (currentConfig.watchlist && currentConfig.watchlist.length > 0 && activeSymbol === 'AAPL') {
    const first = currentConfig.watchlist[0];
    loadTradingViewChart(first.symbol, first.type);
  }
}

// Watchlist toggle group expansion
btnAddWatchlist.onclick = () => {
  watchlistInputGroup.classList.toggle('hidden');
  inputTicker.focus();
};

// Handle Integrations Form Save
integrationsForm.onsubmit = async (e) => {
  e.preventDefault();
  
  const updatedConfig = {
    ...currentConfig,
    discord: {
      enabled: discordEnabled.checked,
      webhookUrl: discordWebhook.value.trim()
    },
    telegram: {
      enabled: telegramEnabled.checked,
      botToken: telegramToken.value.trim(),
      chatId: telegramChatId.value.trim()
    },
    ntfy: {
      enabled: ntfyEnabled ? ntfyEnabled.checked : false,
      topic: ntfyTopic ? ntfyTopic.value.trim() : ''
    }
  };

  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedConfig)
    });
    const result = await response.json();
    if (result.success) {
      currentConfig = updatedConfig;
      // Show a success toast instead of a blocking alert()
      showToast('✅ Integrations saved successfully!');
      console.log('Saved integration settings.');
    }
  } catch (err) {
    console.error('Error saving configurations:', err);
    showToast('❌ Failed to save: ' + err.message, true);
  }
};

// Toast helper (non-blocking notification inside the page)
function showToast(message, isError = false) {
  let toast = document.getElementById('bp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bp-toast';
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      padding: 12px 20px; border-radius: 10px; font-family: Outfit, sans-serif;
      font-size: 14px; font-weight: 600; color: #0a0e17;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4); transition: all 0.3s ease;
      opacity: 0; transform: translateY(10px);
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background = isError ? '#ff3838' : '#00e676';
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 3000);
};

// Trigger test alert on request
btnTestAlert.onclick = async () => {
  try {
    const response = await fetch('/api/test-alert', { method: 'POST' });
    const result = await response.json();
    if (result.success) {
      console.log('Test alert fired.');
    }
  } catch (err) {
    console.error('Error firing test alert:', err);
  }
};

// Set up alert filter event listeners
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.filter-btn').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter');
    renderAlerts();
  };
});

// App Entry Point
connectWebSocket();
loadTradingViewChart(activeSymbol, activeType);
renderAlerts();
