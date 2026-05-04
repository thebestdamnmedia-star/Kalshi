module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    time: Date.now(),
    env: {
      KALSHI_KEY_ID: Boolean(process.env.KALSHI_KEY_ID),
      KALSHI_PRIVATE_KEY: Boolean(process.env.KALSHI_PRIVATE_KEY),
      POLYGON_API_KEY: Boolean(process.env.POLYGON_API_KEY),
      UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)
    }
  });
};
