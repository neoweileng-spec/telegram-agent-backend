// /api/index.js

// ---- Per-chat runtime settings & memory (ephemeral; replace with KV later) ----
const settings = new Map(); // chatId -> { qa, persona, council, councilRoles, profile, summary, history: [] }
const MAX_TURNS = 8;        // keep last N user/assistant messages (per role message = 1 turn)

// ---------- HTTP handler ----------
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

    // Defaults per chat
    const cfg = settings.get(chatId) || {
      qa: false,
      persona: 'Assistant',
      council: false,
      councilRoles: ['Assistant','BrandExpert','Copywriter'],
      profile: '',          // your company/product/tone
      summary: '',          // rolling summary
      history: [],          // [{role:'user'|'assistant', content:string}]
    };
    settings.set(chatId, cfg);

    let aiText = 'Say something and I will reply.';
    if (userText) {
      appendHistory(cfg, 'user', userText);        // record user message first
      await maybeAutosummarise(cfg);               // compress if history long

      const low = userText.toLowerCase();

      // ----- Local controls (no LLM) -----
      if (low === 'qa on')          { cfg.qa = true;  settings.set(chatId, cfg); aiText = 'QA reviewer is ON.'; }
      else if (low === 'qa off')    { cfg.qa = false; settings.set(chatId, cfg); aiText = 'QA reviewer is OFF.'; }
      else if (low === 'council on'){ cfg.council = true; settings.set(chatId, cfg); aiText = `Council ON. Roles: ${cfg.councilRoles.join(', ')}`; }
      else if (low === 'council off'){ cfg.council = false; settings.set(chatId, cfg); aiText = 'Council OFF.'; }
      else if (low.startsWith('council roles:')) {
        const list = userText.split(':').slice(1).join(':').split(',').map(s => s.trim()).filter(Boolean);
        const unknown = list.filter(r => !PERSONAS[r]);
        aiText = unknown.length ? `Unknown role(s): ${unknown.join(', ')}. Valid: ${Object.keys(PERSONAS).join(', ')}` :
          (cfg.councilRoles = list, settings.set(chatId, cfg), `Council roles set: ${cfg.councilRoles.join(', ')}`);
      } else if (low.startsWith('persona:')) {
        const p = userText.split(':').slice(1).join(':').trim();
        aiText = PERSONAS[p] ? (cfg.persona = p, settings.set(chatId, cfg), `Persona set to ${p}.`) :
          `Unknown persona "${p}". Try: ${Object.keys(PERSONAS).join(', ')}`;
      } else if (low.startsWith('remember:')) {
        cfg.profile = userText.split(':').slice(1).join(':').trim();
        settings.set(chatId, cfg);
        aiText = 'Got it — I’ll keep that in mind.';
      } else if (low === 'forget') {
        cfg.profile = ''; cfg.summary = ''; cfg.history = [];
        settings.set(chatId, cfg);
        aiText = 'Cleared conversation memory for this chat.';
      }

      // ----- Greeting menu (only if message is exactly a greeting) -----
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
          "• remember: <company/product/tone>\n" +
          "• forget\n" +
          "• qa on | qa off\n" +
          "• council on | council off\n" +
          "• council roles: Assistant, BrandExpert, Copywriter, ContractWriter\n" +
          "• persona: Assistant | BrandExpert | ContractWriter | Copywriter\n" +
          "…or just tell me what you need.";
      }

      // ----- Fast brand helpers (no LLM) -----
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

      // ----- Assistant helpers (persona/council aware, with context) -----
      else if (low.startsWith('plan:')) {
        const ask = `Create a concise, prioritised plan:\n${userText.slice(5).trim()}`;
        aiText = cfg.council
          ? await councilOrchestrate({ cfg, ask, qa: cfg.qa })
          : await generateWithQA({ cfg, role: 'Assistant', ask, qa: cfg.qa });
      } else if (low.startsWith('draft:')) {
        const ask = `Draft the requested artifact with clear sections:\n${userText.slice(6).trim()}`;
        aiText = cfg.council
          ? await councilOrchestrate({ cfg, ask, qa: cfg.qa })
          : await generateWithQA({ cfg, role: 'Copywriter', ask, qa: cfg.qa });
      }

      // ----- Default fuzzy path (persona/council aware, with context) -----
      else {
        const ask = userText;
        aiText = cfg.council
          ? await councilOrchestrate({ cfg, ask, qa: cfg.qa })
          : await generateWithQA({ cfg, role: cfg.persona, ask, qa: cfg.qa });
      }
    }

    // Send + record assistant reply
    await sendTelegram(chatId, aiText);
    appendHistory(cfg, 'assistant', aiText);
    return res.status(200).send('ok');

  } catch (e) {
    console.error('WEBHOOK ERROR', e);
    return res.status(200).send('ok');
  }
}

// ---------- Telegram send ----------
async function sendTelegram(chatId, text) {
  if (!chatId || !process.env.TELEGRAM_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/* =================== Orchestrator with CONTEXT =================== */

// Personas with SG-localisation
const PERSONAS = {
  Assistant: `
You are a proactive personal assistant for a solo founder.
Values: clarity, momentum, practical execution.
Goals: understand intent, reduce effort, deliver useful output in one message.
Scope: planning, briefs, SOPs, messages, posts, specs; plus brand/copy basics.
If external execution is needed, produce ready-to-use text/instructions.
Style: concise, friendly, direct. Prefer bullets/sections. 10–15 lines unless asked.
Fuzzy queries: ask at most 1 clarifying Q only if essential; otherwise make assumptions and proceed.
Always include next steps or options.

Localisation (Singapore):
- Natural Singaporean English; light Singlish only when casual.
- British spelling; currency S$; dates DD MMM YYYY.`,

  BrandExpert: `
You are a brand and identity specialist.
Deliver colour palettes (HEX + usage), font pairings (Google Fonts, usage notes),
logo prompt ideas, website outlines w/ copy stubs.
Be concrete, minimal, accessible; give contrast hints and practical guidance.

Localisation (Singapore): British spelling, S$, DD MMM YYYY; natural SG tone.`,

  Copywriter: `
You are a senior copywriter and comms strategist.
Write clear, scannable copy. Add subject lines/openers/CTAs when relevant.
Keep it punchy, benefits-forward, and specific. Offer 2–3 options if helpful.

Localisation (Singapore): British spelling, S$, DD MMM YYYY; natural SG tone.`,

  ContractWriter: `
You are a contract/template drafter (not legal advice).
Produce short, plain-language templates and clause options.
Flag assumptions and jurisdiction-sensitive items. Keep it pragmatic.

Localisation (Singapore): neutral professional SG English; British spelling; S$; DD MMM YYYY.
If topic involves CPF or MOM, note common practices and that this is not legal advice.`,

  Reviewer: `
You are a meticulous peer reviewer. Given USER ASK + CONTEXT and DRAFT, return
a short, numbered list of concrete improvements (content gaps, structure, tone, risk).
No meta commentary, no full rewrite, no preambles—just bullets.`,

  Synthesizer: `
You are a synthesis expert. Merge the peer review points into a single final answer.
Output ONLY the improved final answer for the user—no meta/references to reviewers.
Be clear, actionable, concise (≤15 lines unless asked).`,

  QACritic: `
You are a strict QA reviewer. DO NOT reveal analysis.
Given the user's ask and FINAL reply, return:
- "APPROVE"  (if solid), or
- "REVISE"   on first line, followed by a clean, improved final reply only.
Check accuracy, clarity, completeness, tone, and next steps.`,

  Summarizer: `
You compress chat history into a brief context summary (≤10 lines).
Keep user goals, constraints, choices, names, and decisions. No fluff.`,
};

// Build a compact context string from profile, summary, and recent turns
function buildContext(cfg) {
  const lines = [];
  if (cfg.profile) lines.push(`USER PROFILE: ${cfg.profile}`);
  if (cfg.summary) lines.push(`SUMMARY: ${cfg.summary}`);
  if (cfg.history.length) {
    const recent = cfg.history.slice(-MAX_TURNS * 2); // user+assistant
    lines.push('RECENT MESSAGES:');
    for (const m of recent) {
      lines.push(`${m.role.toUpperCase()}: ${m.content}`);
    }
  }
  return lines.join('\n');
}

// Append to rolling history and trim
function appendHistory(cfg, role, content) {
  if (!content) return;
  cfg.history.push({ role, content: String(content).slice(0, 1200) }); // cap each entry
  // Keep at most MAX_TURNS*2 messages (user+assistant)
  if (cfg.history.length > MAX_TURNS * 2) {
    cfg.history = cfg.history.slice(-MAX_TURNS * 2);
  }
}

// Summarise when history grows (uses LLM once in a while)
async function maybeAutosummarise(cfg) {
  if (cfg.history.length < MAX_TURNS * 2) return;
  // Summarise only if we don't already have a fresh summary this run
  const ctx = cfg.history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 4000);
  const sum = await callOllamaWithSystem(PERSONAS.Summarizer, `Chat so far:\n${ctx}\n\nReturn a compact context summary.`);
  if (sum && !sum.startsWith('I hit an error')) {
    cfg.summary = sum.slice(0, 1200);
    // After summarising, keep just the last few turns
    cfg.history = cfg.history.slice(-6);
  }
}

// Single-call with system + context
async function callOllamaWithSystem(system, prompt, ctxText = '') {
  if (!process.env.OLLAMA_URL) return 'LLM not configured (missing OLLAMA_URL).';
  const composed = ctxText
    ? `CONTEXT:\n${ctxText}\n\nTASK:\n${prompt}\n\nRespond for the user.`
    : prompt;

  const payload = {
    model: 'llama3.1:8b',
    stream: false,
    system,
    prompt: composed,
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

async function callOllamaRole(roleName, prompt, cfg) {
  const system = PERSONAS[roleName] || PERSONAS.Assistant;
  const ctx = buildContext(cfg);
  return callOllamaWithSystem(system, prompt, ctx);
}

// Single persona + optional QA, with context
async function generateWithQA({ cfg, role, ask, qa }) {
  const draft = await callOllamaRole(role, ask, cfg);
  if (!qa) return draft;

  const ctx = buildContext(cfg);
  const qaPrompt = `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nFINAL REPLY (to QA):\n${draft}\n\nFollow your instructions.`;
  const critique = await callOllamaWithSystem(PERSONAS.QACritic, qaPrompt, '');
  const head = critique.trim().split('\n')[0].toUpperCase();
  if (head.startsWith('APPROVE')) return draft;
  if (head.startsWith('REVISE')) {
    const lines = critique.split('\n'); lines.shift();
    const revised = lines.join('\n').trim() || draft;
    return revised.slice(0, 3500);
  }
  return draft;
}

// Council: Draft → Peer Reviews → Synthesis → (optional) QA, all with context
async function councilOrchestrate({ cfg, ask, roles, qa }) {
  const distinct = roles.filter((r, i) => roles.indexOf(r) === i && PERSONAS[r]);
  const lead = distinct[0] || 'Assistant';
  const reviewers = distinct.slice(1);
  const ctx = buildContext(cfg);

  // 1) Lead draft with context
  const draft = await callOllamaRole(lead, ask, cfg);

  // 2) Peer reviews see context + draft
  const reviewPromises = reviewers.map(r => callOllamaWithSystem(
    PERSONAS.Reviewer,
    `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nDRAFT:\n${draft}\n\nReturn only numbered improvement bullets.`,
    ''
  ));
  const reviews = reviewers.length ? await Promise.all(reviewPromises) : [];

  // 3) Synthesizer merges into final answer (with context)
  const synthesisPrompt =
    `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nDRAFT:\n${draft}\n\nREVIEWS:\n${reviews.map((rv,i)=>`[${reviewers[i]}]\n${rv}`).join('\n\n')}\n\n` +
    `Produce ONLY the final improved answer (≤15 lines).`;
  let finalAnswer = await callOllamaWithSystem(PERSONAS.Synthesizer, synthesisPrompt, '');

  // 4) Optional QA with context
  if (qa) {
    const qaPrompt = `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nFINAL REPLY (to QA):\n${finalAnswer}\n\nFollow your instructions.`;
    const critique = await callOllamaWithSystem(PERSONAS.QACritic, qaPrompt, '');
    const head = critique.trim().split('\n')[0].toUpperCase();
    if (head.startsWith('REVISE')) {
      const lines = critique.split('\n'); lines.shift();
      const revised = lines.join('\n').trim();
      if (revised) finalAnswer = revised.slice(0, 3500);
    }
  }
  return finalAnswer;
}

/* =================== Local helpers (no LLM) =================== */

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
  for (const p of pairs) out += `\n• ${p.name}\n  Headline: ${p.head}\n  Body: ${p.body}\n  Notes: ${p.notes}`;
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
