// Polyfill for Node.js < 18.14.0 getSetCookie issue
if (typeof globalThis.Headers !== 'undefined' && !globalThis.Headers.prototype.getSetCookie) {
  globalThis.Headers.prototype.getSetCookie = function() {
    const val = this.get('set-cookie');
    return val ? [val] : [];
  };
}

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const RSSParser = require('rss-parser');
const Sentiment = require('sentiment');
const yahooFinance = require('yahoo-finance2').default;
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function getYahooSymbol(symbol) {
  const sym = symbol.toUpperCase().replace(/\s+/g, '');
  if (sym === 'NIFTY' || sym === 'NIFTY50' || sym === 'NIFTY50INDEX' || sym === 'NIFTYINDEX' || sym === 'NSE:NIFTY') return '^NSEI';
  if (sym === 'SENSEX' || sym === 'BSE:SENSEX') return '^BSESN';
  if (sym === 'BANKNIFTY' || sym === 'NIFTYBANK' || sym === 'NSE:BANKNIFTY') return '^NSEBANK';
  // Already correct Yahoo format (e.g. RELIANCE.NS, ^NSEI)
  return symbol;
}

// Currency symbol helper — ₹ for Indian symbols, $ for everything else
function getCurrencySymbol(symbol) {
  if (!symbol) return '$';
  const s = symbol.toUpperCase().replace(/\s+/g, '');
  const indianPatterns = [
    'NIFTY', 'BANKNIFTY', 'NIFTYBANK', 'SENSEX',
    'NIFTYBEES', 'NIFTYMIDCAP', 'NIFTYIT', 'NIFTYPHARMA',
    'NIFTYFMCG', 'NIFTYAUTO', 'NIFTYMETAL', 'NIFTYREALTY'
  ];
  if (indianPatterns.some(p => s.includes(p))) return '₹';
  if (s.endsWith('.NS') || s.endsWith('.BO')) return '₹';
  if (s.startsWith('NSE:') || s.startsWith('BSE:')) return '₹';
  if (s === '^NSEI' || s === '^NSEBANK' || s === '^BSESN') return '₹';
  return '$';
}

// Custom quote fetcher using public Yahoo Chart v8 API
async function fetchYahooQuote(symbol) {
  try {
    const querySymbol = getYahooSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${querySymbol}?interval=1d&range=1d`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });

    if (response.data && response.data.chart && response.data.chart.result && response.data.chart.result.length > 0) {
      const result = response.data.chart.result[0];
      const meta = result.meta;
      const quote = result.indicators.quote[0];

      const currentPrice = meta.regularMarketPrice || (quote.close ? quote.close[quote.close.length - 1] : null);
      const prevClose = meta.previousClose || meta.chartPreviousClose || (quote.open ? quote.open[0] : currentPrice);
      
      const dayHigh = quote.high ? Math.max(...quote.high.filter(v => v !== null)) : currentPrice;
      const dayLow = quote.low ? Math.min(...quote.low.filter(v => v !== null)) : currentPrice;
      const openPrice = quote.open ? quote.open[0] : currentPrice;
      const volume = quote.volume ? quote.volume.reduce((a, b) => (a || 0) + (b || 0), 0) : 0;
      const avgVolume = meta.averageDailyVolume3Month || volume;

      const change = currentPrice - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;

      return {
        regularMarketPrice: currentPrice,
        regularMarketChangePercent: changePercent,
        regularMarketDayHigh: dayHigh || currentPrice,
        regularMarketDayLow: dayLow || currentPrice,
        regularMarketOpen: openPrice || currentPrice,
        regularMarketVolume: volume,
        averageDailyVolume3Month: avgVolume
      };
    }
  } catch (err) {
    console.error(`Error fetching Yahoo quote for ${symbol}:`, err.message);
  }
  return null;
}

// Custom ticker news fetcher using Google News RSS
async function fetchTickerNews(symbol, name) {
  try {
    const parser = new RSSParser();
    // For Indian .NS/.BO stocks, search by company name for better results
    let searchQuery;
    if (symbol.endsWith('.NS') || symbol.endsWith('.BO')) {
      // Use company name for Indian stocks (e.g. "Reliance Industries NSE")
      const shortName = (name || symbol).split(' ').slice(0, 3).join(' ');
      searchQuery = encodeURIComponent(`${shortName} NSE stock`);
    } else if (symbol.startsWith('^')) {
      // Index — search by index name
      const indexName = name || symbol;
      searchQuery = encodeURIComponent(`${indexName} today`);
    } else {
      const cleanSymbol = symbol.split('-')[0];
      searchQuery = encodeURIComponent(`${cleanSymbol} stock market`);
    }
    const url = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;
    const feed = await parser.parseURL(url);
    if (feed.items && feed.items.length > 0) {
      const latest = feed.items[0];
      return {
        title: latest.title,
        summary: latest.contentSnippet || latest.title,
        link: latest.link
      };
    }
  } catch (err) {
    console.error(`Error fetching news from Google for ${symbol}:`, err.message);
  }
  return null;
}



const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Load Configuration
let config = {
  scanIntervalMs: 60000,
  watchlist: [],
  customKeywords: {},
  discord: { enabled: false, webhookUrl: "" },
  telegram: { enabled: false, botToken: "", chatId: "" },
  ntfy: { enabled: false, topic: "" }
};

const configPath = path.join(__dirname, 'config.json');
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log('Configuration loaded from config.json');
    } else {
      console.log('No config.json found, using defaults.');
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }

  // Override with environment variables if set (for cloud hosting like Render)
  if (process.env.NTFY_TOPIC) {
    config.ntfy = { enabled: true, topic: process.env.NTFY_TOPIC };
    console.log(`ntfy topic loaded from env: ${process.env.NTFY_TOPIC}`);
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    config.telegram = {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID
    };
    console.log('Telegram config loaded from env.');
  }
  if (process.env.DISCORD_WEBHOOK_URL) {
    config.discord = { enabled: true, webhookUrl: process.env.DISCORD_WEBHOOK_URL };
    console.log('Discord config loaded from env.');
  }
}
loadConfig();


// Initialize Sentiment Analyzer with custom financial market lexicon
const sentimentAnalyzer = new Sentiment();
const getSentimentOptions = () => ({
  extras: config.customKeywords || {}
});

// In-Memory Database for dashboard
const alertHistory = [];
const parsedArticles = new Set(); // Keep track of article URLs to avoid duplicates
const ORBStore = {}; // Tracks opening range high/low for ORB breakouts per ticker

// Setup middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Express API Endpoints
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  try {
    config = { ...config, ...req.body };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    res.json({ success: true, message: 'Configuration updated successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/alerts', (req, res) => {
  res.json(alertHistory.slice(-100).reverse()); // Return last 100 alerts, newest first
});

app.post('/api/test-alert', async (req, res) => {
  try {
    const testAlert = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      symbol: "TEST",
      type: "stock",
      price: 150.00,
      changePercent: 5.4,
      breakoutType: "TEST_CATALYST",
      direction: "UP",
      sentimentScore: 3.5,
      sentimentLabel: "Bullish",
      catalystNews: {
        title: "Test Breakout Pulse Alert: System connected successfully!",
        summary: "This is a simulated news catalyst showing positive sentiment.",
        link: "https://finance.yahoo.com"
      },
      confidence: "HIGH"
    };

    broadcastAlert(testAlert);
    await dispatchExternalAlert(testAlert);
    res.json({ success: true, message: 'Test alert fired.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket broadcasting
function broadcastAlert(alert) {
  alertHistory.push(alert);
  if (alertHistory.length > 500) alertHistory.shift(); // Cap storage

  const payload = JSON.stringify({ type: 'ALERT', data: alert });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Send external notification (Discord/Telegram)
async function dispatchExternalAlert(alert) {
  const directionEmoji = alert.direction === 'UP' ? '🟢' : '🔴';
  const confidenceColor = alert.direction === 'UP' ? 3066993 : 15158332; // Green or Red
  const curr = getCurrencySymbol(alert.symbol);
  
  // Format message
  let messageText = `**[${alert.confidence} CONFIDENCE BREAKOUT]**\n`;
  messageText += `${directionEmoji} **${alert.symbol}** (${alert.type.toUpperCase()}) | Price: **${curr}${alert.price.toFixed(2)}** (${alert.changePercent > 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%)\n`;
  messageText += `⚡ Signal: **${alert.breakoutType.replace('_', ' ')}** (${alert.direction})\n`;
  messageText += `📊 News Sentiment: **${alert.sentimentLabel}** (Score: ${alert.sentimentScore})\n\n`;
  
  if (alert.catalystNews) {
    messageText += `📰 **News Catalyst**: *${alert.catalystNews.title}*\n`;
    messageText += `🔗 Read more: ${alert.catalystNews.link}\n`;
  }

  // Discord Webhook
  const discordUrl = process.env.DISCORD_WEBHOOK_URL || config.discord.webhookUrl;
  if (config.discord.enabled && discordUrl) {
    try {
      await axios.post(discordUrl, {
        username: "BreakoutPulse Bot",
        embeds: [{
          title: `${alert.symbol} ${alert.direction === 'UP' ? 'Bullish Breakout 📈' : 'Bearish Breakdown 📉'}`,
          description: messageText,
          color: confidenceColor,
          timestamp: new Date().toISOString(),
          footer: { text: "Powered by BreakoutPulse" }
        }]
      });
      console.log(`Discord alert sent for ${alert.symbol}`);
    } catch (err) {
      console.error('Failed to send Discord notification:', err.message);
    }
  }

  // Telegram Alert
  const tgToken = process.env.TELEGRAM_BOT_TOKEN || config.telegram.botToken;
  const tgChatId = process.env.TELEGRAM_CHAT_ID || config.telegram.chatId;
  if (config.telegram.enabled && tgToken && tgChatId) {
    try {
      const url = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      // Clean markdown for Telegram HTML format
      const tgText = `<b>[${alert.confidence} CONFIDENCE BREAKOUT]</b>\n` +
        `${directionEmoji} <b>${alert.symbol}</b> (${alert.type.toUpperCase()}) | Price: <b>${curr}${alert.price.toFixed(2)}</b> (${alert.changePercent > 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%)\n` +
        `⚡ Signal: <b>${alert.breakoutType.replace('_', ' ')}</b> (${alert.direction})\n` +
        `📊 News Sentiment: <b>${alert.sentimentLabel}</b> (Score: ${alert.sentimentScore})\n\n` +
        (alert.catalystNews ? `📰 <b>News Catalyst</b>: <i>${alert.catalystNews.title}</i>\n🔗 <a href="${alert.catalystNews.link}">Read more</a>` : '');

      await axios.post(url, {
        chat_id: tgChatId,
        text: tgText,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      });
      console.log(`Telegram alert sent for ${alert.symbol}`);
    } catch (err) {
      console.error('Failed to send Telegram notification:', err.message);
    }
  }

  // ntfy.sh Mobile Push Notification
  const ntfyTopic = config.ntfy && config.ntfy.topic ? config.ntfy.topic.trim() : '';
  if (config.ntfy && config.ntfy.enabled && ntfyTopic) {
    try {
      const dirEmoji = alert.direction === 'UP' ? '📈' : '📉';
      const ntfyTitle = `${dirEmoji} ${alert.symbol} ${alert.direction === 'UP' ? 'Bullish' : 'Bearish'} Breakout`;
      const ntfyBody = `Price: ${curr}${alert.price.toFixed(2)} (${alert.changePercent > 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%)\n` +
        `Signal: ${alert.breakoutType.replace(/_/g, ' ')}\n` +
        `Sentiment: ${alert.sentimentLabel} | Confidence: ${alert.confidence}` +
        (alert.catalystNews ? `\nNews: ${alert.catalystNews.title}` : '');

      await axios.post(`https://ntfy.sh/${ntfyTopic}`, ntfyBody, {
        headers: {
          'Title': ntfyTitle,
          'Priority': alert.confidence === 'HIGH' ? 'urgent' : 'high',
          'Tags': alert.direction === 'UP' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle',
          'Content-Type': 'text/plain'
        }
      });
      console.log(`ntfy.sh push sent to topic: ${ntfyTopic} for ${alert.symbol}`);
    } catch (err) {
      console.error('Failed to send ntfy.sh notification:', err.message);
    }
  }
}

// core breakout metrics calculator
async function analyzeTickerPrice(symbol, type, newsCatalyst = null) {
  try {
    console.log(`Scanning technicals for ${symbol}...`);
    const quote = await fetchYahooQuote(symbol);
    if (!quote) return;

    const currentPrice = quote.regularMarketPrice;
    const changePercent = quote.regularMarketChangePercent;
    const dayHigh = quote.regularMarketDayHigh;
    const dayLow = quote.regularMarketDayLow;
    const openPrice = quote.regularMarketOpen;
    const volume = quote.regularMarketVolume;
    const avgVolume = quote.averageDailyVolume3Month;

    if (!currentPrice || !dayHigh || !dayLow) return;

    let breakoutType = null;
    let direction = null;

    // 1. Technical Breakout Check
    // Near 24h/Daily High/Low (within 0.5%) or breaching it
    const highThreshold = dayHigh * 0.995;
    const lowThreshold = dayLow * 1.005;

    if (currentPrice >= dayHigh) {
      breakoutType = "DAILY_HIGH_BREAKOUT";
      direction = "UP";
    } else if (currentPrice <= dayLow) {
      breakoutType = "DAILY_LOW_BREAKDOWN";
      direction = "DOWN";
    } else if (currentPrice >= highThreshold) {
      breakoutType = "NEAR_DAILY_HIGH";
      direction = "UP";
    } else if (currentPrice <= lowThreshold) {
      breakoutType = "NEAR_DAILY_LOW";
      direction = "DOWN";
    }

    // 2. Volume expansion check
    const isVolumeSpike = avgVolume && volume > (avgVolume * 1.5);
    if (isVolumeSpike && breakoutType) {
      breakoutType += "_WITH_VOLUME";
    }

    // 3. Opening Range Breakout (ORB) Logic (Simulated using market open)
    if (openPrice && currentPrice) {
      if (!ORBStore[symbol]) {
        // Mocking the 15m ORB range around the open price (e.g. ±1% for stocks, ±2% for crypto)
        const rangePercent = type === 'crypto' ? 0.02 : 0.01;
        ORBStore[symbol] = {
          orbHigh: openPrice * (1 + rangePercent),
          orbLow: openPrice * (1 - rangePercent)
        };
      }
      const { orbHigh, orbLow } = ORBStore[symbol];
      if (currentPrice > orbHigh && breakoutType !== "DAILY_HIGH_BREAKOUT") {
        breakoutType = "ORB_UPSIDE_BREAKOUT";
        direction = "UP";
      } else if (currentPrice < orbLow && breakoutType !== "DAILY_LOW_BREAKDOWN") {
        breakoutType = "ORB_DOWNSIDE_BREAKOUT";
        direction = "DOWN";
      }
    }

    // If no technical signal and no news catalyst, don't trigger anything
    if (!breakoutType && !newsCatalyst) return;

    // Determine Sentiment if news is present
    let sentimentScore = 0;
    let sentimentLabel = "Neutral";
    if (newsCatalyst) {
      const sentResult = sentimentAnalyzer.analyze(
        (newsCatalyst.title + ' ' + (newsCatalyst.summary || '')),
        getSentimentOptions()
      );
      sentimentScore = sentResult.score;
      if (sentimentScore > 1.5) sentimentLabel = "Bullish";
      else if (sentimentScore < -1.5) sentimentLabel = "Bearish";
    }

    // Correlate news sentiment with price direction
    let confidence = "MEDIUM";
    if (breakoutType && newsCatalyst) {
      const isSentimentAligned = 
        (direction === "UP" && sentimentLabel === "Bullish") || 
        (direction === "DOWN" && sentimentLabel === "Bearish");
      confidence = isSentimentAligned ? "HIGH" : "MEDIUM";
    } else if (newsCatalyst && !breakoutType) {
      breakoutType = "NEWS_CATALYST_ONLY";
      direction = sentimentScore > 0 ? "UP" : sentimentScore < 0 ? "DOWN" : "NEUTRAL";
      confidence = Math.abs(sentimentScore) > 3 ? "MEDIUM" : "LOW";
      if (direction === "NEUTRAL") return; // Ignore neutral news-only events
    } else if (breakoutType && !newsCatalyst) {
      confidence = "LOW"; // Technical breakout but no fresh news catalyst
    }

    // Deduplicate alerts to avoid spamming the same breakout signal within 10 minutes
    const tenMinsAgo = Date.now() - 10 * 60 * 1000;
    const isDuplicate = alertHistory.some(a => 
      a.symbol === symbol && 
      a.breakoutType === breakoutType && 
      new Date(a.timestamp).getTime() > tenMinsAgo
    );

    if (isDuplicate) {
      console.log(`Skipping duplicate alert for ${symbol} : ${breakoutType}`);
      return;
    }

    // Create and broadcast alert
    const newAlert = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      symbol,
      type,
      price: currentPrice,
      changePercent,
      breakoutType,
      direction,
      sentimentScore,
      sentimentLabel,
      catalystNews: newsCatalyst,
      confidence
    };

    console.log(`🚀 [ALERT ALERT] ${symbol} | Direction: ${direction} | Confidence: ${confidence}`);
    broadcastAlert(newAlert);
    await dispatchExternalAlert(newAlert);

  } catch (error) {
    console.error(`Error analyzing ticker ${symbol}:`, error.message);
  }
}

// News Scanner Engine (RSS + multiple Indian & Global feeds)
async function scanMarketNews() {
  console.log('Scanning general market news feed...');
  const parser = new RSSParser();

  // All RSS feeds: Global + Indian financial news
  const newsFeeds = [
    // Global
    { url: 'https://finance.yahoo.com/news/rssindex', label: 'Yahoo Finance' },
    // Indian financial news
    { url: 'https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2143429.cms', label: 'ET Markets Stocks' },
    { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', label: 'ET Markets Top News' },
    { url: 'https://www.business-standard.com/rss/markets-106.rss', label: 'Business Standard Markets' },
    { url: 'https://www.moneycontrol.com/rss/marketreports.xml', label: 'Moneycontrol Markets' },
    { url: 'https://www.livemint.com/rss/markets', label: 'Livemint Markets' },
    { url: 'https://www.thehindubusinessline.com/markets/?service=rss', label: 'Hindu BusinessLine' }
  ];

  for (const feedSource of newsFeeds) {
    try {
      const feed = await parser.parseURL(feedSource.url);
      for (const item of feed.items) {
        if (parsedArticles.has(item.link)) continue;
        parsedArticles.add(item.link);
        if (parsedArticles.size > 3000) {
          const keys = Array.from(parsedArticles);
          parsedArticles.delete(keys[0]);
        }

        // Match against every watchlist item
        for (const asset of config.watchlist) {
          // Build smart regex: match ticker base (RELIANCE from RELIANCE.NS) OR first 2 words of company name
          const tickerBase = asset.symbol.replace(/\.(NS|BO)$/i, '').replace(/[\^\-]/g, ' ').trim();
          const nameWords = (asset.name || '').split(' ').slice(0, 2).join('\\s*');
          let pattern;
          try {
            pattern = new RegExp(`\\b(${tickerBase}|${nameWords})\\b`, 'i');
          } catch (e) {
            pattern = new RegExp(tickerBase, 'i');
          }
          const content = item.title + ' ' + (item.contentSnippet || '');

          if (pattern.test(content)) {
            console.log(`[${feedSource.label}] Mention of ${asset.symbol}: "${item.title}"`);
            const newsCatalyst = {
              title: item.title,
              summary: item.contentSnippet || item.title,
              link: item.link
            };
            await analyzeTickerPrice(asset.symbol, asset.type, newsCatalyst);
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning ${feedSource.label}:`, err.message);
    }
  }
}

// Periodic Ticker-specific scan
async function scanWatchlistTechnicals() {
  console.log('Running scheduled watchlist scan...');
  for (const asset of config.watchlist) {
    try {
      // Pass company name for better Indian stock news search
      const freshNews = await fetchTickerNews(asset.symbol, asset.name);
      await analyzeTickerPrice(asset.symbol, asset.type, freshNews);
    } catch (err) {
      console.error(`Error scanning watchlist asset ${asset.symbol}:`, err.message);
    }
  }
}

// Background scheduler
let mainInterval;
function startScanner() {
  // Initial scan
  scanMarketNews();
  scanWatchlistTechnicals();

  // Periodic scan
  mainInterval = setInterval(async () => {
    await scanMarketNews();
    await scanWatchlistTechnicals();
  }, config.scanIntervalMs || 60000);
}

// Stop engine gracefully on restart
process.on('SIGINT', () => {
  clearInterval(mainInterval);
  process.exit();
});

// Websocket logic
wss.on('connection', ws => {
  console.log('New client dashboard connected.');
  // Send existing config & history
  ws.send(JSON.stringify({ type: 'CONFIG', data: config }));
  ws.send(JSON.stringify({ type: 'HISTORY', data: alertHistory }));

  ws.on('message', message => {
    try {
      const payload = JSON.parse(message);
      if (payload.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch (err) {
      console.error('WS Error parsing client message:', err.message);
    }
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 BreakoutPulse server running on http://localhost:${PORT}`);
  console.log(`=======================================================`);
  startScanner();
});
