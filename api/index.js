export default async function handler(req, res) {
  if (req.method === 'GET') {
    // test endpoint
    return res.status(200).send('Bot is running!');
  }
  if (req.method === 'POST' && req.url.endsWith('/webhook')) {
    // telegram webhook placeholder
    return res.status(200).send('ok');
  }
  return res.status(404).send('Not Found');
}
