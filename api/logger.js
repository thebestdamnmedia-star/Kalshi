const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const KALSHI_KEY_ID = process.env.KALSHI_KEY_ID;
  const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY;
  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  const timestamp = new Date().toISOString();
  const errors = [];
  let btc_spot = null;
  let snapshot_events = [];
  
  async function rSet(key, value) {
    const r = await fetch(UPSTASH_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value)]])
    });
    return r.ok;
  }
  
  async function rGet(key) {
    const r = await fetch(UPSTASH_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', key]])
    });
    const d = await r.json();
    try { return d[0] && d[0].result ? JSON.parse(d[0].result) : null; }
    catch { return null; }
  }
  
  async function kFetch(path) {
    const r = await fetch('https://api.elections.kalshi.com' + path, {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('Kalshi ' + r.status + ' on ' + path);
    return r.json();
  }
  
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 15 * 60;
    const fmt = ts => new Date(ts * 1000).toISOString().slice(0, 10);
    const url = 'https://api.polygon.io/v2/aggs/ticker/X:BTCUSD/range/1/minute/' + fmt(start) + '/' + fmt(end) + '?adjusted=true&sort=desc&limit=1&apiKey=' + POLYGON_KEY;
    const r = await fetch(url);
    const d = await r.json();
    if (d.results && d.results[0]) btc_spot = d.results[0].c;
    else errors.push('Polygon returned no BTC bar');
  } catch (e) {
    errors.push('Polygon error: ' + e.message);
  }
  
  const seriesToLog = ['KXBTCD', 'KXBTC15M'];
  const now = Date.now();
  const twoHrOut = now + 2 * 3600 * 1000;
  
  for (const series of seriesToLog) {
    try {
      const evtData = await kFetch('/trade-api/v2/events?series_ticker=' + series + '&status=open&limit=20');
      const events = (evtData.events || []).filter(e => {
        if (!e.strike_date) return false;
        const t = new Date(e.strike_date).getTime();
        return t > now && t <= twoHrOut;
      }).sort((a, b) => new Date(a.strike_date) - new Date(b.strike_date));
      
      for (const evt of events.slice(0, 3)) {
        try {
          const ladderData = await kFetch('/trade-api/v2/events/' + evt.event_ticker + '?with_nested_markets=true');
          const ev = ladderData.event || {};
          const markets = (ev.markets) || ladderData.markets || [];
          
          const strikes = markets.map(m => {
            let strike = null;
            if (m.cap_strike) strike = m.cap_strike;
            else if (m.ticker) {
              const match = m.ticker.match(/[BT](\d+)$/);
              if (match) strike = parseInt(match[1]);
            }
            return {
              t: m.ticker, s: strike, st: m.strike_type,
              yb: parseFloat(m.yes_bid_dollars || 0),
              ya: parseFloat(m.yes_ask_dollars || 0),
              nb: parseFloat(m.no_bid_dollars || 0),
              na: parseFloat(m.no_ask_dollars || 0),
              ybs: parseFloat(m.yes_bid_size_fp || 0),
              yas: parseFloat(m.yes_ask_size_fp || 0),
              v: parseFloat(m.volume_fp || 0),
              oi: parseFloat(m.open_interest_fp || 0)
            };
          });
          
          const minsToResolve = Math.round((new Date(evt.strike_date).getTime() - now) / 60000);
          
          snapshot_events.push({
            series: series,
            ticker: evt.event_ticker,
            strike_date: evt.strike_date,
            mins_to_resolve: minsToResolve,
            title: evt.title,
            strike_count: strikes.length,
            strikes: strikes
          });
        } catch (e) {
          errors.push('Ladder fetch ' + evt.event_ticker + ': ' + e.message);
        }
      }
    } catch (e) {
      errors.push('Events fetch ' + series + ': ' + e.message);
    }
  }
  
  const snapshot = {
    ts: timestamp, btc_spot: btc_spot,
    event_count: snapshot_events.length,
    events: snapshot_events, errors: errors
  };
  
  const key = 'ladder:' + timestamp;
  const writeOk = await rSet(key, snapshot);
  
  let index = await rGet('ladder:index') || [];
  index.push(timestamp);
  if (index.length > 200) index = index.slice(-200);
  await rSet('ladder:index', index);
  await rSet('ladder:latest', snapshot);
  
  return res.status(200).json({
    ok: writeOk, timestamp: timestamp, btc_spot: btc_spot,
    event_count: snapshot_events.length,
    total_strikes: snapshot_events.reduce((s, e) => s + e.strike_count, 0),
    errors: errors, key: key
  });
};

module.exports.config = { maxDuration: 60 };
