// Simple health check endpoint
// Hit https://your-project.vercel.app/api/health to verify deploy worked
// No body, no params, no auth — just a heartbeat

module.exports = async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);

const checks = {
timestamp: new Date().toISOString(),
node: process.version,
env: {
KALSHI_KEY_ID: !!process.env.KALSHI_KEY_ID,
KALSHI_PRIVATE_KEY: !!process.env.KALSHI_PRIVATE_KEY,
POLYGON_API_KEY: !!process.env.POLYGON_API_KEY,
UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
},
status: ‘alive’
};

return res.status(200).json(checks);
};
