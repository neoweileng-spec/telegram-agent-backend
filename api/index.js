// /api/index.js (CommonJS)
// Freddy (SG) — multi-persona assistant with council + QA + short-term memory
// Works on Vercel serverless + Telegram webhook + Ollama (non-stream JSON).

/* =================== Config =================== */

// Keep total work under Telegram/Vercel ~10s
const TIME_BUDGET_MS = 9000;
const BOT_NAME = 'Freddy';

// Voice & localisation for Singapore
const SG_VOICE = `
You speak as ${BOT_NAME}, a young adult male Singaporean: friendly, helpful, knowledgeable, patient, energetic.
Sound human and conversational. Use first-person ("I", "me") and address the user naturally.
Localisation:
- Natural Singaporean English; very light Singlish only when casual (sparingly).
- British spelling (colour, organise).
- Currency S$; dates DD MMM YYYY.
Style:
- Short paragraphs and crisp bullets; avoid stiff corporate tone.
- Be decisive, practical, and kind; ask at most 1 clarifying question only if essential.
- No AI disclaimers unless asked. Focus on action and next steps.
`;

/* =================== In-memory state (ephemeral) =================== */

// chatId -> { qa, persona, council, councilRoles, profile, summary, history: [] }
const settings = new Map();
const MAX_TURNS = 8; // keep last N user/assistant turns (compact context)

/* =================== HTTP handler =================== */

async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Bot is running!');

  const secretOk = process.env.TELEGRAM_SECRET
    ? req.headers['x-telegram-bot-api-secret-token'] === process.env.TELEGRAM_SECRET
    : true;
  if (req.method !== 'POST' || !secretOk) return res.status(404).send('Not Found');

  try {
    const raw = await readRawBody(req);
    const update = JSON.parse(raw || '{}');

    const chatId = update?.message?.chat?.id;
    const userText = String(update?.message?.text || '').trim();

    // Start a time budget per webhook
    const deadline = Date.now() + TIME_BUDGET_MS;

    // Defaults per chat
    const cfg = settings.get(chatId) || {
      qa: false,
      persona: 'Assistant',
      council: false,
      councilRoles: ['Assistant', 'BrandExpert', 'Copywriter'], // first is lead
      profile: '',
      summary: '',
      history: [],
    };
    settings.set(chatId, cfg);

    let aiText = 'Say something and I will reply.';

    if (userText) {
      appendHistory(cfg, 'user', userText);
      await maybeAutosummarise(cfg, deadline);

      const low = userText.toLowerCase();

      // ---------- Controls (no LLM) ----------
      if (low === 'qa on') {
        cfg.qa = true; settings.set(chatId, cfg);
        aiText = 'QA reviewer is ON.';
      } else if (low === 'qa off') {
        cfg.qa = false; settings.set(chatId, cfg);
        aiText = 'QA reviewer is OFF.';
      } else if (low === 'council on') {
        cfg.council = true; settings.set(chatId, cfg);
        aiText = `Council is ON. Roles: ${cfg.councilRoles.join(', ')}`;
      } else if (low === 'council off') {
        cfg.council = false; settings.set(chatId, cfg);
        aiText = 'Council is OFF.';
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
      } else if (low.startsWith('remember:')) {
        cfg.profile = userText.split(':').slice(1).join(':').trim();
        settings.set(chatId, cfg);
        aiText = 'Got it — I’ll keep that in mind.';
      } else if (low === 'forget') {
        cfg.profile = ''; cfg.summary = ''; cfg.history = [];
        settings.set(chatId, cfg);
        aiText = 'Cleared conversation memory for this chat.';
      }

      // ---------- Greeting menu (exact greetings only) ----------
      else if (['hi','hello','hey','yo','sup','hai'].includes(low)) {
        aiText =
          `👋 hey! i’m ${BOT_NAME}.\n\n` +
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
          "…tell me what you need and I’ll sort it out.`;
      }

      // ---------- Fast brand helpers (no LLM) ----------
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

      // ---------- Assistant helpers (persona/council aware) ----------
      else if (low.startsWith('plan:')) {
        const ask = `Create a concise, prioritised plan:\n${userText.slice(5).trim()}`;
        aiText = await routeWithBudget({ cfg, ask, defaultRole: 'Assistant', deadline });
      } else if (low.startsWith('draft:')) {
        const ask = `Draft the requested artifact with clear sections:\n${userText.slice(6).trim()}`;
        aiText = await routeWithBudget({ cfg, ask, defaultRole: 'Copywriter', deadline });
      }

      // ---------- Default fuzzy path ----------
      else {
        const ask = userText;
        aiText = await routeWithBudget({ cfg, ask, defaultRole: cfg.persona, deadline });
      }
    }

    await sendTelegram(chatId, aiText);
    appendHistory(cfg, 'assistant', aiText);
    return res.status(200).send('ok');

  } catch (e) {
    console.error('WEBHOOK ERROR', e);
    // Always ack to stop Telegram retries
    return res.status(200).send('ok');
  }
}

module.exports = handler;

/* =================== Routing with time budget =================== */

async function routeWithBudget({ cfg, ask, defaultRole, deadline }) {
  try {
    if (cfg.council) {
      return await councilOrchestrate({ cfg, ask, roles: cfg.councilRoles, qa: cfg.qa, deadline });
    }
    return await generateWithQA({ cfg, role: defaultRole, ask, qa: cfg.qa, deadline });
  } catch (e) {
    console.error('ROUTE ERROR', e?.message || e);
    return 'I hit a snag generating the reply. Can try that again?';
  }
}

/* =================== Personas (Freddy voice) =================== */

const PERSONAS = {
  Assistant: `
${SG_VOICE}
You are a proactive personal assistant for a solo founder.
Goals: understand intent, reduce effort, deliver useful output in one message.
Scope: planning, briefs, SOPs, messages, posts, specs; plus brand/copy basics.
If external execution is needed, produce ready-to-use text/instructions.
Keep replies within ~10–15 lines unless asked; include next steps or options.`,

  BrandExpert: `
${SG_VOICE}
You are a brand and identity specialist.
Deliver colour palettes (HEX + usage), font pairings (Google Fonts, usage notes),
logo prompt ideas, website outlines with copy stubs.
Be concrete, minimal, and accessible; include contrast hints and practical guidance.`,

  Copywriter: `
${SG_VOICE}
You are a senior copywriter and comms strategist.
Write clear, scannable copy. Add subject lines/openers/CTAs when relevant.
Keep it punchy, benefits-forward, specific. Offer 2–3 options if helpful.`,

  ContractWriter: `
${SG_VOICE}
You are a contract/template drafter (not legal advice).
Produce short, plain-language templates and clause options.
Flag assumptions and Singapore-specific considerations (e.g., CPF, MOM) clearly.`,

  Reviewer: `
${SG_VOICE}
You are a meticulous peer reviewer. Given USER ASK + CONTEXT and DRAFT, return
a short, numbered list of concrete improvements (content gaps, structure, tone, risk).
No meta commentary, no full rewrite, no preambles—just bullets.`,

  Synthesizer: `
${SG_VOICE}
You are a synthesis expert. Merge the peer review points into a single final answer.
Output ONLY the improved final answer—no meta or references to reviewers.
Be clear, actionable, and concise (≤15 lines unless asked).`,

  QACritic: `
${SG_VOICE}
You are a strict QA reviewer. DO NOT reveal analysis.
Given the user's ask and FINAL reply, return:
- "APPROVE"  (if solid), or
- "REVISE"   on first line, followed by a clean, improved final reply only.
Check accuracy, clarity, completeness, tone, and next steps.`,

  Summarizer: `
${SG_VOICE}
Compress chat history into a brief context summary (≤10 lines).
Keep user goals, constraints, choices, names, and decisions. No fluff.`,
};

/* =================== Orchestrator core =================== */

// Single-call with system + context + deadline
async function callOllamaWithSystem(system, prompt, ctxText = '', deadline = Date.now() + 5000) {
  if (!process.env.OLLAMA_URL) return 'LLM not configured (missing OLLAMA_URL).';

  const composed = ctxText
    ? `CONTEXT:\n${ctxText}\n\nTASK:\n${prompt}\n\nRespond for the user.`
    : prompt;

  // compute remaining time (reserve ~300ms overhead)
  const remaining = Math.max(1500, Math.min(8000, deadline - Date.now() - 300));

  const payload = {
    model: 'llama3.1:8b',
    stream: false,
    system,
    prompt: composed,
    options: { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 4096 },
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), remaining);
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
    return data?.response ? String(data.response).slice(0, 3500) : 'The model returned no text.';
  } catch (e) {
    console.error('OLLAMA FETCH ERROR', e?.message || e);
    return 'The model request timed out. Please try again.';
  }
}

async function callOllamaRole(roleName, prompt, cfg, deadline) {
  const system = PERSONAS[roleName] || PERSONAS.Assistant;
  const ctx = buildContext(cfg);
  return callOllamaWithSystem(system, prompt, ctx, deadline);
}

// Single persona + optional QA, with context & budget
async function generateWithQA({ cfg, role, ask, qa, deadline }) {
  // allocate ~60% to draft
  const tLead = Date.now() + Math.max(1500, Math.floor((deadline - Date.now()) * 0.6));
  const draft = await callOllamaRole(role, ask, cfg, tLead);

  // skip QA if little time left
  if (!qa || deadline - Date.now() < 2000) return draft;

  const ctx = buildContext(cfg);
  const qaPrompt = `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nFINAL REPLY (to QA):\n${draft}\n\nFollow your instructions.`;
  const qaAns = await callOllamaWithSystem(PERSONAS.QACritic, qaPrompt, '', deadline);
  const head = qaAns.trim().split('\n')[0].toUpperCase();
  if (head.startsWith('REVISE')) {
    const lines = qaAns.split('\n'); lines.shift();
    const revised = lines.join('\n').trim() || draft;
    return revised.slice(0, 3500);
  }
  return draft;
}

// Council: Draft → Peer Reviews → Synthesis → (optional) QA, all with context & budget
async function councilOrchestrate({ cfg, ask, roles, qa, deadline }) {
  const distinct = roles.filter((r, i) => roles.indexOf(r) === i && PERSONAS[r]);
  const lead = distinct[0] || 'Assistant';
  const reviewers = distinct.slice(1);
  const ctx = buildContext(cfg);

  // 1) Lead draft (~50% of budget)
  const tLead = Date.now() + Math.max(1500, Math.floor((deadline - Date.now()) * 0.5));
  const draft = await callOllamaRole(lead, ask, cfg, tLead);

  // 2) Reviewers in parallel (~40% shared)
  let reviews = [];
  if (reviewers.length && (deadline - Date.now()) > 2500) {
    const per = Date.now() + Math.max(1200, Math.floor((deadline - Date.now()) * 0.4));
    const reviewPromises = reviewers.map(r =>
      callOllamaWithSystem(
        PERSONAS.Reviewer,
        `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nDRAFT:\n${draft}\n\nReturn only numbered improvement bullets.`,
        '',
        per
      )
    );
    const settled = await Promise.allSettled(reviewPromises);
    reviews = settled.map(p => (p.status === 'fulfilled' ? p.value : '')).filter(Boolean);
  }

  // 3) Synthesis (remaining time)
  if (deadline - Date.now() < 1500) return draft;
  const synthesisPrompt =
    `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nDRAFT:\n${draft}\n\nREVIEWS:\n${reviews.join('\n\n')}\n\n` +
    `Produce ONLY the final improved answer (≤15 lines).`;
  let finalAnswer = await callOllamaWithSystem(PERSONAS.Synthesizer, synthesisPrompt, '', deadline);

  // 4) Optional QA if time permits
  if (qa && (deadline - Date.now()) > 2000) {
    const qaPrompt = `USER ASK:\n${ask}\n\nCONTEXT:\n${ctx}\n\nFINAL REPLY (to QA):\n${finalAnswer}\n\nFollow your instructions.`;
    const qaAns = await callOllamaWithSystem(PERSONAS.QACritic, qaPrompt, '', deadline);
    const head = qaAns.trim().split('\n')[0].toUpperCase();
    if (head.startsWith('REVISE')) {
      const lines = qaAns.split('\n'); lines.shift();
      const revised = lines.join('\n').trim();
      if (revised) finalAnswer = revised.slice(0, 3500);
    }
  }

  return finalAnswer;
}

/* =================== Context & memory =================== */

function buildContext(cfg) {
  const lines = [];
  if (cfg.profile) lines.push(`USER PROFILE: ${cfg.profile}`);
  if (cfg.summary) lines.push(`SUMMARY: ${cfg.summary}`);
  if (cfg.history.length) {
    const recent = cfg.history.slice(-MAX_TURNS * 2);
    lines.push('RECENT MESSAGES:');
    for (const m of recent) lines.push(`${m.role.toUpperCase()}: ${m.content}`);
  }
  return lines.join('\n');
}

function appendHistory(cfg, role, content) {
  if (!content) return;
  cfg.history.push({ role, content: String(content).slice(0, 1200) });
  if (cfg.history.length > MAX_TURNS * 2) {
    cfg.history = cfg.history.slice(-MAX_TURNS * 2);
  }
}

async function maybeAutosummarise(cfg, deadline) {
  // Summarise only if history is long and there is time
  if (cfg.history.length < MAX_TURNS * 2 || (deadline - Date.now()) < 2500) return;
  const ctx = cfg.history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 4000);
  const sum = await callOllamaWithSystem(
    PERSONAS.Summarizer,
    `Chat so far:\n${ctx}\n\nReturn a compact context summary.`,
    '',
    Date.now() + 2000 // tiny budget for summary
  );
  if (sum && !sum.startsWith('I hit an error')) {
    cfg.summary = sum.slice(0, 1200);
    cfg.history = cfg.history.slice(-6); // keep last few turns after summary
  }
}

/* =================== Telegram send =================== */

async function sendTelegram(chatId, text) {
  if (!chatId || !process.env.TELEGRAM_TOKEN) return;
  const payload = { chat_id: chatId, text: String(text || '').slice(0, 3500) };
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/* =================== Utilities =================== */

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

/* =================== Local brand helpers (no LLM) =================== */

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
    `Minimal symbol, flat vector, ${brief}, single-colour mark`,
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
