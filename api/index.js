export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  if (req.method === 'POST') {
    try {
      // read raw body
      const raw = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => resolve(data || '{}'));
      });
      // log the incoming update to Vercel runtime logs
      console.log('TG UPDATE:', raw);

      const update = JSON.parse(raw);
      const chatId = update?.message?.chat?.id;
      const text = update?.message?.text ?? '';

      // simple reply
      if (chatId && process.env.TELEGRAM_TOKEN) {
        const replyText = text ? `You said: ${text}` : 'Hello! 👋';
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: replyText })
        });
      }

      return res.status(200).send('ok');
    } catch (e) {
      console.error('WEBHOOK ERROR:', e);
      return res.status(200).send('ok'); // ack to stop Telegram retries
    }
  }

  return res.status(404).send('Not Found');
}
