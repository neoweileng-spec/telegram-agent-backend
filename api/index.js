export default async function handler(req, res) {
  // Health check
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  // Treat ANY POST to this function as Telegram webhook
  if (req.method === 'POST') {
    try {
      // Read raw body (Vercel doesn't auto-parse here)
      const raw = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => resolve(data || '{}'));
      });
      const update = JSON.parse(raw);

      const chatId = update?.message?.chat?.id;
      const text = update?.message?.text ?? '';

      // Echo back (only if token is present)
      if (chatId && process.env.TELEGRAM_TOKEN) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `You said: ${text}` })
        });
      }

      // Always return 200 so Telegram stops retrying
      return res.status(200).send('ok');
    } catch (_) {
      // Still ack to avoid endless retries
      return res.status(200).send('ok');
    }
  }

  // Anything else
  return res.status(404).send('Not Found');
}
