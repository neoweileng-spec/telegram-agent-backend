export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  // Telegram will POST here:
  if (req.method === 'POST' && req.url.endsWith('/webhook')) {
    const update = req.body || {};
    const msg = update.message?.text || '';
    const chatId = update.message?.chat?.id;

    if (chatId && process.env.TELEGRAM_TOKEN) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ chat_id: chatId, text: `You said: ${msg}` })
      });
    }
    return res.status(200).send('ok');
  }

  return res.status(404).send('Not Found');
}
