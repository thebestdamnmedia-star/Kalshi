const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  const UPSTASH_URL        = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN      = process.env.UPSTASH_REDIS_REST_TOKEN;
  const POLYGON_KEY        = process.env.POLYGON_API_KEY;
  const KALSHI_KEY_ID      = process.env.KALSHI_KEY_ID;
  const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: true, message: 'Invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: true, message: 'Missing or invalid body' });
  }

  if (body._storage) {
    try {
      const { action, key, value } = body;
      let command;
      if (action === 'set')         command = ['SET', key, JSON.stringify(value)];
      else if (action === 'get')    command = ['GET', key];
      else if (action === 'delete') command = ['DEL', key];
      else if (action === 'list')   command = ['KEYS', key || '*'];
      else return res.status(400).json({ error: true, message: 'Unknown storage action' });
      const r = await fetch(UPSTASH_URL + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify([command])
      });
      const data = await r.json();
      return res.status(200).json({ ok: true, result: data[0] && data[0].result });
    } catch (err) {
      return res.status(500).json({ error: true, source: 'upstash', message: err.message });
    }
  }

  if (body._polygon) {
    try {
      const url = body.url;
      if (!url || !url.startsWith('https://api.polygon.io/')) {
        return res.status(400).json({ error: true, message: 'Invalid Polygon URL' });
      }
      const sep = url.includes('?') ? '&' : '?';
      const r = await fetch(url + sep + 'apiKey=' + POLYGON_KEY);
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: true, source: 'polygon', message: data.error || 'Polygon error' });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: true, source: 'polygon', message: err.message });
    }
  }

  if (body._kalshi) {
    try {
      const url = body.url;
      const method = (body.method || 'GET').toUpperCase();
      const payload = body.payload;
      const signed = body.signed === true;

      const allowed = url && (
        url.startsWith('https://api.elections.kalshi.com/') ||
        url.startsWith('https://api.kalshi.com/') ||
        url.startsWith('https://trading-api.kalshi.com/') ||
        url.startsWith('https://demo-api.kalshi.co/')
      );
      if (!allowed) {
        return res.status(400).json({ error: true, message: 'Invalid Kalshi URL' });
      }

      const opts = {
        method: method,
        headers: { 'Accept': 'application/json' }
      };

      if (signed) {
        if (!KALSHI_KEY_ID || !KALSHI_PRIVATE_KEY) {
          return res.status(401).json({ error: true, source: 'kalshi', message: 'KALSHI_KEY_ID and KALSHI_PRIVATE_KEY required' });
        }
        const timestamp = Date.now().toString();
        const urlObj = new URL(url);
        const pathToSign = urlObj.pathname;
        const message = timestamp + method + pathToSign;

        let signature;
        try {
          const signer = crypto.createSign('RSA-SHA256');
          signer.update(message);
          signer.end();
          signature = signer.sign({
            key: KALSHI_PRIVATE_KEY,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32
          }).toString('base64');
        } catch (sigErr) {
          return res.status(500).json({ error: true, source: 'kalshi', message: 'Sign failed: ' + sigErr.message });
        }

        opts.headers['KALSHI-ACCESS-KEY'] = KALSHI_KEY_ID;
        opts.headers['KALSHI-ACCESS-SIGNATURE'] = signature;
        opts.headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
      }

      if (payload && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(payload);
      }

      const r = await fetch(url, opts);
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) {
        return res.status(r.status).json({
          error: true, source: 'kalshi', status: r.status,
          message: (data && data.error && data.error.message) || (data && data.message) || text.slice(0, 200),
          signed: signed
        });
      }
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: true, source: 'kalshi', message: err.message });
    }
  }

  return res.status(400).json({ error: true, message: 'No handler matched. Set _kalshi, _polygon, or _storage flag.' });
};

module.exports.config = { maxDuration: 60 };
