// /api/index.js
export default async function handler(req, res) {
  // Healthcheck endpoint
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  // Verify Telegram secret header (matches setWebhook&secret_token)
  const secretOk = process.env.TELEGRAM_SECRET
    ? req.headers['x-telegram-bot-api-secret-token'] === process.env.TELEGRAM_SECRET
    : true;

  if (req.method !== 'POST' || !secretOk) return res.status(404).send('Not Found');

  try {
    // Read raw body
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data || '{}'));
    });

    const update = JSON.parse(raw);
    const chatId = update?.message?.chat?.id;
    const userText = String(update?.message?.text || '').trim();

    let aiText = 'Say something and I will reply.'; // fallback

    if (userText) {
      const low = userText.toLowerCase();
      const isGreeting = ['hi','hello','hey','yo','sup','hai'].some(
        (g) => low === g || low.startsWith(g + ' ')
      );

      // ---- Greeting → assistant menu ----
      if (isGreeting) {
        aiText =
          "👋 hey! i’m your assistant.\n\n" +
          "base skills:\n" +
          "• brand colors: <vibe>\n" +
          "• font pairing for <personality>\n" +
          "• logo prompts: <brief>\n" +
          "• website outline: <name>\n\n" +
          "assistant skills:\n" +
          "• plan: <goal>\n" +
          "• draft: <thing>\n" +
          "• or ask me anything fuzzy — i’ll figure it out.";
      }
      // ---- Quick command routing ----
      else if (low.startsWith('brand colors:') || low.startsWith('palette:')) {
        const vibe = userText.split(':').slice(1).join(':').trim() || 'modern tech';
        aiText = makePalette(vibe);
      } else if (low.startsWith('font pairing for') || low.startsWith('fonts:')) {
        const persona =
          userText.split(':').slice(1).join(':').trim() ||
          low.replace('font pairing for', '').trim() ||
          'modern, trustworthy';
        aiText = suggestFonts(persona);
      } else if (low.startsWith('logo prompts') || low.startsWith('logo ideas') || low.startsWith('logo brief')) {
        const brief = userText.split(':').slice(1).join(':').trim() || 'Tech, minimal, bold';
        aiText = logoPrompts(brief);
      } else if (low.startsWith('website outline') || low.startsWith('sitemap') || low.startsWith('wireframe')) {
        const name = userText.split(':').slice(1).join(':').trim() || 'Your Brand';
        aiText = websiteOutline(name);
      }
      // ---- Assistant expansions ----
      else if (low.startsWith('plan:')) {
        aiText = await callOllama(`Create a concise, prioritized plan:\n${userText.slice(5).trim()}`);
      } else if (low.startsWith('draft:')) {
        aiText = await callOllama(`Draft the requested artifact with clear sections:\n${userText.slice(6).trim()}`);
      }
      // ---- Default fuzzy → LLM ----
      else {
        aiText = await callOllama(userText);
      }
    }

    // Send Telegram message
    if (chatId && process.env.TELEGRAM_TOKEN) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: aiText }),
      });
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error('WEBHOOK ERROR', e);
    return res.status(200).send('ok'); // always ack to stop retries
  }
}

/* ------------------- LLM ------------------- */

async function callOllama(prompt) {
  if (!process.env.OLLAMA_URL) return 'LLM not configured (missing OLLAMA_URL).';

  const payload = {
    model: 'llama3.1:8b',
    stream: false,
    system:
      "You are a proactive personal assistant for a solo founder. " +
      "Core values: clarity, momentum, practical execution. " +
      "Primary goals: understand intent, reduce effort, and deliver useful output in one message. " +
      "Base competencies: brand palettes, font pairing, logo prompts, website outlines/copy, simple contracts/templates. " +
      "Beyond base: draft plans, checklists, SOPs, briefs, posts, messages, and guides. " +
      "If user asks something external, produce text or instructions they can copy-paste. " +
      "Style: concise, friendly, direct. Prefer bullets/sections. " +
      "Fuzzy queries: ask at most 1 clarifying Q only if essential; otherwise make assumptions and continue. " +
      "Responses: ~10–15 lines max unless asked for more. " +
      "Always provide next steps or options.",
    prompt,
    options: {
      temperature: 0.7,
      top_p: 0.9,
      repeat_penalty: 1.1,
      num_ctx: 4096
    }
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    const resp = await fetch(`${process.env.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!resp.ok) {
      console.error('OLLAMA ERROR', resp.status, await resp.text().catch(() => ''));
      return `I hit an error talking to the model (status ${resp.status}). Try again.`;
    }

    const data = await resp.json().catch(() => ({}));
    if (data?.response) return String(data.response).slice(0, 3500);
    return 'The model returned no text. Try again with more detail.';
  } catch (e) {
    console.error('OLLAMA FETCH ERROR', e?.message || e);
    return 'The model request timed out. Please try again.';
  }
}

/* ------------------- Helpers ------------------- */

// Contrast heuristic
function contrastNote(hex) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16)/255,
        g = parseInt(h.slice(2,4),16)/255,
        b = parseInt(h.slice(4,6),16)/255;
  const L = 0.2126*r + 0.7152*g + 0.0722*b;
  const rec = L < 0.5 ? 'Use white text' : 'Use black text';
  return `${rec}`;
}

// Brand palettes
function makePalette(vibe) {
  const presets = {
    'modern tech': ['#111827','#0EA5E9','#22D3EE','#F1F5F9','#94A3B8'],
    'friendly fintech': ['#0B3D2E','#14B8A6','#A7F3D0','#F59E0B','#F8FAFC'],
    'minimal black & white': ['#0A0A0A','#1F2937','#6B7280','#E5E7EB','#FFFFFF'],
    'playful startup': ['#1D4ED8','#60A5FA','#10B981','#F59E0B','#FDE68A'],
    'calm premium': ['#0F172A','#334155','#94A3B8','#E2E8F0','#F8FAFC'],
  };
  const key = Object.keys(presets).find(k => vibe.toLowerCase().includes(k)) || 'modern tech';
  const cols = presets[key];
  let out = `🎨 Palette for "${vibe}":\n`;
  cols.forEach((hex,i) => { out += `${i+1}) ${hex} — ${contrastNote(hex)}\n`; });
  return out.trim();
}

// Font pairings
function suggestFonts(persona) {
  const pairs = [
    { name: 'Modern/Product', head: 'Inter', body: 'Inter', notes: 'Dashboards/apps. 700–900 headings, 400–500 body.' },
    { name: 'Tech + Editorial', head: 'Poppins', body: 'Source Serif 4', notes: 'Geometric + serif credibility.' },
    { name: 'Clean Corporate', head: 'IBM Plex Sans', body: 'IBM Plex Sans', notes: 'Neutral tone, readable docs.' },
  ];
  let out = `Font pairing ideas for "${persona}":\n`;
  for (const p of pairs) {
    out += `\n• ${p.name}\n  Headline: ${p.head}\n  Body: ${p.body}\n  Notes: ${p.notes}`;
  }
  return out.trim();
}

// Logo prompts
function logoPrompts(brief) {
  const lines = [
    `Minimal symbol, flat vector, ${brief}, single-color mark`,
    `Geometric animal/icon, ${brief}, bold lines, monochrome`,
    `Abstract forward shape, ${brief}, flat, solid fills`,
    `Wordmark with custom cut letter, ${brief}, display weight`,
    `Mascot simplified, ${brief}, brand icon, black on white`,
  ];
  return `Logo prompt ideas:\n• ${lines.join('\n• ')}`;
}

// Website outline
function websiteOutline(name) {
  return [
    `Sitemap for ${name}:`,
    `• Home • Solutions • Pricing • About • Blog • Contact`,
    ``,
    `Home sections:`,
    `1) Hero — one-liner + CTA`,
    `2) Problem → Solution — bullets`,
    `3) How it works — 3 steps`,
    `4) Use cases — 3 tiles`,
    `5) Social proof — testimonials/logos`,
    `6) Pricing teaser — link`,
    `7) Final CTA — start/contact`,
  ].join('\n');
}
