export default async function handler(req, res) {
  // 1) health check
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  // 2) Telegram webhook: robust JSON parsing (Vercel doesn't auto-parse here)
  if (req.method === 'POST' && req.url.endsWith('/webhook')) {
    try {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => resolve(data || '{}'));
      });
      const update = JSON.parse(body);

      const chatId = update?.message?.chat?.id;
      const text = update?.message?.text ?? '';

      // echo back
      if (chatId && process.env.TELEGRAM_TOKEN) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `You said: ${text}` })
        });
      }

      return res.status(200).send('ok');
    } catch (e) {
      console.error('webhook error', e);
      return res.status(200).send('ok'); // acknowledge so Telegram doesn't retry endlessly
    }
  }

  return res.status(404).send('Not Found');
}
