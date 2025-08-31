// /api/index.js

// ---- Per-chat runtime settings (ephemeral; replace with KV later) ----
const settings = new Map(); // key: chatId -> { qa: bool, persona: string, council: bool, councilRoles: string[] }

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  const secretOk = process.env.TELEGRAM_SECRET
    ? req.headers['x-telegram-bot-api-secret-token'] === process.env.TELEGRAM_SECRET
    : true;
  if (req.method !== 'POST' || !secretOk) return res.status(404).send('Not Found');

  try {
    const raw = await new Promise((resolve) => {
      let data = ''; req.on('data', c => data += c); req.on('end', () => resolve(data || '{}'));
    });
    const update = JSON.parse(raw);
    const chatId = update?.message?.chat?.id;
    const userText = String(update?.message?.text || '').trim();

    // default settings
    const cfg = settings.get(chatId) || {
      qa: false,
      persona: 'Assistant',
      council: false,
      councilRoles: ['Assistant','BrandExpert','Copywriter'] // first is lead by default
    };
    settings.set(chatId, cfg);

    let aiText = 'Say something and I will reply.';

    if (userText) {
      const low = userText.toLowerCase();

      // --- control commands (no LLM) ---
      if (low === 'qa on') {
        cfg.qa = true; settings.set(chatId, cfg);
        aiText = 'QA reviewer is now ON.';
      } else if (low === 'qa off') {
        cfg.qa = false; settings.set(chatId, cfg);
        aiText = 'QA reviewer is now OFF.';
      } else if (low === 'council on') {
        cfg.council = true; settings.set(chatId, cfg);
        aiText = `Council mode ON. Roles: ${cfg.councilRoles.join(', ')}`;
      } else if (low === 'council off') {
        cfg.council = false; settings.set(chatId, cfg);
        aiText = 'Council mode OFF.';
      } else if (low.startsWith('council roles:')) {
        const list = userText.split(':').slice(1).join(':').split(',').map(s => s.trim()).filter(Boolean);
        const unknown = list.filter(r => !PERSONAS[r]);
        if (list.length && unknown.length === 0) {
          cfg.councilRoles = list; settings.set(chatId, cfg);
          aiText = `Council roles set: ${cfg.councilRoles.join(', ')}`;
        } else {
          aiText = `Unknown role(s): ${unknown.join(', ')}. Valid: ${Object.keys(PERSONAS).join(', ')}`;
        }
      } else if (low.startsWith('persona:')) {
        const p = userText.split(':').slice(1).join(':').trim();
        if (PERSONAS[p]) { cfg.persona = p; settings.set(chatId, cfg); aiText = `Persona set to ${p}.`; }
        else aiText = `Unknown persona "${p}". Try: ${Object.keys(PERSONAS).join(', ')}`;
      }

      // --- greeting menu only if the entire message is exactly a greeting ---
      else if (['hi','hello','hey','yo','sup','hai'].includes(low)) {
        aiText =
          "👋 hey! i’m your assistant.\n\n" +
          "base skills:\n" +
          "• brand colors: <vibe>\n" +
          "• font pairing for <personality>\n" +
          "• logo prompts: <brief>\n" +
          "• website outline: <name>\n\n" +
          "assistant skills:\n" +
          "• plan: <goal>\n" +
          "• draft: <thing>\n\n" +
          "controls:\n" +
          "• qa on | qa off\n" +
          "• council on | council off\n" +
          "• council roles: Assistant, BrandExpert, Copywriter, ContractWriter\n" +
          "• persona: Assistant | BrandExpert | ContractWriter | Copywriter\n" +
          "…or ask me anything — I’ll figure it out.";
      }

      // --- fast local brand helpers (no LLM) ---
      else if (low.startsWith('brand colors:') || low.startsWith('palette:')) {
        const vibe = userText.split(':').slice(1).join(':').trim() || 'modern tech';
        aiText = makePalette(vibe);
      } else if (low.startsWith('font pairing for') || low.startsWith('fonts:')) {
        const persona = userText.split(':').slice(1).join(':').trim() || 'modern, trustworthy';
        aiText = suggestFonts(persona);
      } else if (low.startsWith('logo prompts') || low.startsWith('logo ideas') || low.startsWith('logo brief')) {
        const brief = userText.split(':').slice(1).join(':').trim() || 'Tech, minimal, bold';
        aiText = logoPrompts(brief);
      } else if (low.startsWith('website outline') || low.startsWith('sitemap') || low.startsWith('wireframe')) {
        const name = userText.split(':').slice(1).join(':').trim() || 'Your Brand';
        aiText = websiteOutline(name);
      }

      // --- assistant helpers routed to personas ---
      else if (low.startsWith('plan:')) {
        const prompt = `Create a concise, prioritized plan for: ${userText.slice(5).trim()}`;
        aiText = cfg.council
          ? await councilOrchestrate({ ask: prompt, roles: cfg.councilRoles, qa: cfg.qa })
          : await generateWithQA({ role: 'Assistant', prompt, qa: cfg.qa });
      } else if (low.startsWith('draft:')) {
        const prompt = `Draft the requested artifact with clear sections:\n${userText.slice(6).trim()}`;
        aiText = cfg.council
          ? await councilOrchestrate({ ask: prompt, roles: cfg.councilRoles, qa: cfg.qa })
          : await generateWithQA({ role: 'Copywriter', prompt, qa: cfg.qa });
      }

      // --- default fuzzy path ---
      else {
        const prompt = userText;
        aiText = cfg.council
          ? await councilOrchestrate({ ask: prompt, roles: cfg.councilRoles, qa: cfg.qa })
          : await generateWithQA({ role: cfg.persona, prompt, qa: cfg.qa });
      }
    }

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
    return res.status(200).send('ok');
  }
}

/* ------------------- Persona Orchestrator ------------------- */

// Registry of specialist system prompts
const PERSONAS = {
  Assistant: `
You are a proactive personal assistant for a solo founder.
Values: clarity, momentum, practical execution.
Goals: understand intent, reduce effort, deliver useful output in one message.
Scope: planning, briefs, SOPs, messages, posts, specs; plus brand/copy basics.
If external execution is needed, produce ready-to-use text/instructions.
Style: concise, friendly, direct. Prefer bullets/sections. 10–15 lines unless asked.
Fuzzy queries: ask at most 1 clarifying Q only if essential; otherwise make assumptions and proceed.
Always include next steps or options.`,

  BrandExpert: `
You are a brand and identity specialist.
Deliver color palettes (HEX + usage), font pairings (Google Fonts, usage notes),
logo prompt ideas, website outlines w/ copy stubs.
Be concrete, minimal, and accessible; provide contrast hints and practical guidance.`,

  Copywriter: `
You are a senior copywriter and comms strategist.
Write clear, scannable copy. Add subject lines/openers/CTAs when relevant.
Keep it punchy, benefits-forward, and specific. Offer 2–3 options if helpful.`,

  ContractWriter: `
You are a contract/template drafter (not legal advice).
Produce short, plain-language templates and clause options.
Flag assumptions and jurisdiction-sensitive items. Keep it pragmatic and editable by a founder.`,

  Reviewer: `
You are a meticulous peer reviewer. Task: Given USER ASK and DRAFT, return a
short, numbered list of concrete improvements (content gaps, structure, tone, risk).
No meta commentary, no full rewrite, no preambles—just bullets.`,

  Synthesizer: `
You are a synthesis expert. Merge the peer review points into a single final answer.
Output ONLY the improved final answer for the user—no meta, no references to reviewers.
Be clear, actionable, and concise (≤15 lines unless asked).`,

  QACritic: `
You are a strict QA reviewer. DO NOT reveal analysis.
Given the user's ask and FINAL reply, return:
- "APPROVE"  (if solid), or
- "REVISE"   on first line, followed by a clean, improved final reply only.
Check accuracy, clarity, completeness, tone, and next steps. No explanations.`,
};

// Core single-call with custom system
async function callOllamaWithSystem(system, prompt) {
  if (!process.env.OLLAMA_URL) return 'LLM not configured (missing OLLAMA_URL).';
  const payload = {
    model: 'llama3.1:8b',
    stream: false,
    system,
    prompt,
    options: { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 4096 },
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    const resp = await fetch(`${process.env.OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) {
      console.error('OLLAMA ERROR', resp.status, await resp.text().catch(()=>'')); 
      return `I hit an error talking to the model (status ${resp.status}). Try again.`;
    }
    const data = await resp.json().catch(()=> ({}));
    return data?.response ? String(data.response).slice(0, 3500) : 'The model returned no text.';
  } catch (e) {
    console.error('OLLAMA FETCH ERROR', e?.message || e); 
    return 'The model request timed out. Please try again.';
  }
}

async function callOllamaRole(roleName, prompt) {
  const system = PERSONAS[roleName] || PERSONAS.Assistant;
  return callOllamaWithSystem(system, prompt);
}

// Classic: single persona + optional QA
async function generateWithQA({ role, prompt, qa }) {
  const draft = await callOllamaRole(role, prompt);
  if (!qa) return draft;
  const qaPrompt = `USER ASK:\n${prompt}\n\nFINAL REPLY (to QA):\n${draft}\n\nFollow your instructions.`;
  const critique = await callOllamaWithSystem(PERSONAS.QACritic, qaPrompt);
  const head = critique.trim().split('\n')[0].toUpperCase();
  if (head.startsWith('APPROVE')) return draft;
  if (head.startsWith('REVISE')) {
    const lines = critique.split('\n'); lines.shift();
    const revised = lines.join('\n').trim() || draft;
    return revised.slice(0, 3500);
  }
  return draft;
}

// Council pipeline: Draft → Peer Reviews → Synthesis → (optional) QA
async function councilOrchestrate({ ask, roles, qa }) {
  const distinct = roles.filter((r, i) => roles.indexOf(r) === i && PERSONAS[r]);
  const lead = distinct[0] || 'Assistant';
  const reviewers = distinct.slice(1);

  // 1) Lead draft
  const draft = await callOllamaRole(lead, ask);

  // 2) Each reviewer returns numbered bullets of improvements
  const reviewPromises = reviewers.map(r => callOllamaWithSystem(
    PERSONAS.Reviewer,
    `USER ASK:\n${ask}\n\nDRAFT:\n${draft}\n\nReturn only numbered improvement bullets.`
  ));
  const reviews = reviewers.length ? await Promise.all(reviewPromises) : [];

  // 3) Synthesizer merges everything into the final answer
  const synthesisPrompt =
    `USER ASK:\n${ask}\n\nDRAFT:\n${draft}\n\nREVIEWS:\n${reviews.map((rv, i)=>`[${reviewers[i]}]\n${rv}`).join('\n\n')}\n\n` +
    `Produce ONLY the final improved answer for the user, in ≤15 lines.`;
  let finalAnswer = await callOllamaWithSystem(PERSONAS.Synthesizer, synthesisPrompt);

  // 4) Optional QA (hidden). Return only final text to user.
  if (qa) {
    const qaPrompt = `USER ASK:\n${ask}\n\nFINAL REPLY (to QA):\n${finalAnswer}\n\nFollow your instructions.`;
    const critique = await callOllamaWithSystem(PERSONAS.QACritic, qaPrompt);
    const head = critique.trim().split('\n')[0].toUpperCase();
    if (head.startsWith('REVISE')) {
      const lines = critique.split('\n'); lines.shift();
      const revised = lines.join('\n').trim();
      if (revised) finalAnswer = revised.slice(0, 3500);
    }
  }
  return finalAnswer;
}

/* ------------------- Local Helpers (no LLM) ------------------- */

function contrastNote(hex) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16)/255,
        g = parseInt(h.slice(2,4),16)/255,
        b = parseInt(h.slice(4,6),16)/255;
  const L = 0.2126*r + 0.7152*g + 0.0722*b;
  return L < 0.5 ? 'Use white text' : 'Use black text';
}
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
