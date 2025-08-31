export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  // Only accept Telegram (still replies 'ok' on error to avoid retries)
  const secretOk =
    process.env.TELEGRAM_SECRET
      ? req.headers['x-telegram-bot-api-secret-token'] === process.env.TELEGRAM_SECRET
      : true;

  if (req.method === 'POST' && secretOk) {
    try {
      // Read raw Telegram update
      const raw = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => resolve(data || '{}'));
      });
      const update = JSON.parse(raw);
      const chatId = update?.message?.chat?.id;
      const userText = (update?.message?.text || '').trim();

      let aiText = 'Say something and I will reply.';

      if (chatId && userText && process.env.OLLAMA_URL) {
        // Call your local Ollama (via Cloudflare Tunnel)
        const resp = await fetch(`${process.env.OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // llama3.1:8b is a good default; stream=false returns one JSON object
          body: JSON.stringify({
            model: 'llama3.1:8b',
            prompt: userText,
            stream: false
          }),
          // simple guard in case the tunnel stalls
          signal: AbortSignal.timeout(30_000)
        });

        const data = await resp.json().catch(() => ({}));
        aiText = (data && data.response) ? String(data.response).slice(0, 3500) : aiText; // keep under Telegram limit
      }

      if (chatId && process.env.TELEGRAM_TOKEN) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: aiText })
        });
      }

      return res.status(200).send('ok');
    } catch (e) {
      // acknowledge to stop Telegram retries; log if needed
      console.error('WEBHOOK ERROR', e);
      return res.status(200).send('ok');
    }
  }

  return res.status(404).send('Not Found');
}
