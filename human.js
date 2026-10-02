const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'MAIN', 'main.json');

let data = {
  settings: {},
  intents: [],
  cheerful: { triggers: [], blockers: [], emoticons: [] },
};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = {
      settings: parsed.settings || {},
      intents: parsed.intents || [],
      cheerful: {
        triggers: parsed.cheerful?.triggers || [],
        blockers: parsed.cheerful?.blockers || [],
        emoticons: parsed.cheerful?.emoticons || [],
      },
    };
    console.log('Đã nạp MAIN/main.json');
  } catch (err) {
    console.error('Lỗi đọc MAIN/main.json:', err.message);
  }
}

load();
fs.watchFile(FILE, { interval: 3000 }, load); // sửa file là tự nạp lại

// Bỏ dấu, bỏ ký tự đặc biệt để so khớp "cam on" = "cảm ơn"
const norm = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function hasPhrase(n, phrase, prefixOnly = false) {
  const p = norm(phrase);
  if (!p) return false;
  return new RegExp(`(^| )${esc(p)}${prefixOnly ? '' : '( |$)'}`).test(n);
}

// Trả về câu mẫu nếu khớp, ngược lại null (để chuyển sang Groq)
function matchIntent(text) {
  const n = norm(text);
  if (!n) return null;
  for (const intent of data.intents) {
    if (!intent.replies?.length) continue;
    if (n.length > (intent.maxLength || 60)) continue;
    if ((intent.patterns || []).some((p) => hasPhrase(n, p))) {
      return pick(intent.replies);
    }
  }
  return null;
}

const EMOTICON_RE = /[:;=]-?[)}\]]+|[:;=]-?D\b/;

function isCheerful(text) {
  const n = norm(text);
  const { triggers, blockers } = data.cheerful;
  if (blockers.some((b) => hasPhrase(n, b))) return false;
  if (EMOTICON_RE.test(text)) return true;
  return triggers.some((t) => hasPhrase(n, t, true));
}

// Thêm ký hiệu vui vẻ cuối câu, chỉ khi người dùng đang vui
function decorate(reply, userText) {
  const { emoticons } = data.cheerful;
  if (!reply || !emoticons.length) return reply;

  const chance = data.settings.emoticonChance ?? 0.5;
  const maxLen = data.settings.emoticonMaxLength ?? 300;
  const text = reply.trimEnd();

  if (text.includes('```') || text.length > maxLen) return reply;
  if (/[:;=]-?[)}\]]+$/.test(text)) return reply;
  if (!isCheerful(userText)) return reply;
  if (Math.random() > chance) return reply;

  return `${text} ${pick(emoticons)}`;
}

module.exports = { matchIntent, decorate, isCheerful };