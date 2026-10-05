// Builds library/character-refs/ for Forma Studio from the desktop folder «Референсы персонажей»:
// portrait + six-view sheet per character, and manifest.json with the texts that feed generation.
// node build-refs.cjs <srcFolder> <studioDir>
const fs = require('fs'), path = require('path');
const [src, studio] = process.argv.slice(2);
const out = path.join(studio, 'library', 'character-refs');
const SKIP = new Set(['Продавщица посуды', 'Официантка кафе']);   // the user asked not to add them yet
// Who is who for the video director (from the context documents).
const PEOPLE = {
  'Анни': { zh: '安妮', gender: 'woman', age: 'early 20s' },
  'Бай Цзяюэ': { zh: '白家月', gender: 'woman', age: 'early 20s' },
  'Ван Исюэ': { zh: '', gender: 'woman', age: 'early 30s' },
  'Ван Ифэй': { zh: '王一飞', gender: 'woman', age: 'about 30' },
  'Доктор Ху': { zh: '', gender: 'man', age: 'younger than 40' },
  'Ли Вэнь': { zh: '李文', gender: 'man', age: 'early 20s' },
  'Лю Мин': { zh: '', gender: 'man', age: 'about 40' },
  'Лю Сяомин': { zh: '', gender: 'boy', age: '5' },
  'Лю Сяосюэ': { zh: '', gender: 'girl', age: '12' },
  'Официант': { zh: '', gender: 'man', age: 'young adult' },
  'Продавец': { zh: '', gender: 'man', age: 'adult' },
  'Сяоюй': { zh: '小语', gender: 'woman', age: 'young adult' },
  'Чэнь Тяньчжун': { zh: '陈天中', gender: 'man', age: 'early 20s' },
  'Ян Тунлэ': { zh: '', gender: 'man', age: 'early 30s' }
};
// Looks not spelled out as «Context:» in their prompts, written from the approved descriptions.
const MANUAL = {
  'Сяоюй': 'Xiaoyu, a real young woman filmed in live action (she plays the course’s AI tutor; never animated or digital-looking): long loose dark wavy hair; pearl-white structured jacket with an asymmetric high collar, thin ice-blue piping, small silver clasp and a small cyan AI insignia on her LEFT chest; light silver-gray trousers, white flat shoes; compact pearl-white headset on her RIGHT ear with a cyan light and a thin silver mic boom ending in a small white capsule by the right corner of her mouth.',
  'Лю Сяосюэ': 'Liu Xiaoxue, Chinese schoolgirl from Beijing, EXACTLY 12 years old (finishing primary school, not a teenager), black ponytail, no makeup; white-and-navy zip-front Chinese school tracksuit jacket, white T-shirt, navy trousers with white side stripes, white sneakers.'
};
const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim() : '';
// Whole sentences only: a description cut mid-phrase («светло-серые…») reads as a broken card.
const clip = (s, n) => { if (s.length <= n) return s; const cut = s.slice(0, n), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf(';')); return end > n / 3 ? cut.slice(0, end + 1).trim() : s; };
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const characters = [];
for (const name of fs.readdirSync(src)) {
  const dir = path.join(src, name);
  if (!fs.statSync(dir).isDirectory() || SKIP.has(name)) continue;
  const portrait = path.join(dir, `${name} — портрет.png`), sheet = path.join(dir, `${name} — референсы для видео.png`);
  if (!fs.existsSync(portrait)) { console.log('нет портрета:', name); continue; }
  const slug = 'c' + String(characters.length + 1).padStart(2, '0');
  fs.copyFileSync(portrait, path.join(out, slug + '-portrait.png'));
  if (fs.existsSync(sheet)) fs.copyFileSync(sheet, path.join(out, slug + '-sheet.png'));
  const ctx = read(path.join(dir, 'Контекст персонажа.txt'));
  const refPrompt = read(path.join(dir, 'Промпт референса.txt')), portraitPrompt = read(path.join(dir, 'Промпт портрета.txt'));
  const template = read(path.join(dir, 'Шаблон промпта для видео.txt'));
  // Textbook facts (Russian): the «Контекст учебника» paragraph, else the whole note without the boilerplate.
  let role = (ctx.match(/Контекст учебника:\s*([\s\S]*?)\n\s*\n/) || [])[1] || ctx.split('\n\nИсточник')[0];
  role = role.replace(/^[^\n]*\n(?=\S)/, m => (m.trim() === name ? '' : m)).trim();
  const source = (ctx.match(/Источник:\s*([^\n]+)/) || [])[1] || '';
  // Approved design changes («Одежда обновлена…», «Новый дизайн…»).
  const updates = (ctx.match(/(?:^|\n)((?:Одежда обновлена|Новый дизайн)[^\n]+)/g) || []).map(s => s.trim());
  // Canonical English look and the outfit used for the reference sheet.
  const canon = MANUAL[name] || (refPrompt.match(/(?:Canonical context|Context):\s*([\s\S]*?)(?=\s(?:Preserve|Outfit across|Clothing across|Wardrobe consistently|Correct age|Create |Landscape|Clean landscape|Input face)\b)/) || [])[1]
    || portraitPrompt.replace(/^(Use case:[^.]*\.|Photorealistic portrait:)\s*/i, '').split(/\s(?:One person only|Front-facing|Create a)/)[0];
  const outfit = (refPrompt.match(/(?:Outfit across all views|Clothing across every panel|Wardrobe consistently|Outfit):\s*([^.]+\.)/) || [])[1] || '';
  // Extra rules written into the video template after the standard lines.
  const extra = template.split('Продолжительность: [укажи].')[1]?.trim() || '';
  const special = name === 'Сяоюй' ? (template.match(/Гарнитура всегда[^\n]+/) || [''])[0] : '';
  const p = PEOPLE[name] || { zh: '', gender: '', age: '' };
  characters.push({
    key: slug, name, nameZh: p.zh, portrait: `${slug}-portrait.png`, sheet: fs.existsSync(sheet) ? `${slug}-sheet.png` : '',
    role: clip(role, 700), source,
    visualDescription: [canon.trim(), outfit && 'Usual outfit (reference sheet): ' + outfit.trim()].filter(Boolean).join(' '),
    updates, videoRules: [special, extra].filter(Boolean).join('\n').trim(),
    genderEn: p.gender, ageEn: p.age, lookEn: (s => { const cut = s.slice(0, 640), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.'), cut.lastIndexOf(';')); return (s.length <= 640 ? s : end > 80 ? cut.slice(0, end + 1) : cut.replace(/[,;\s]+\S*$/, '')).trim(); })(canon.replace(/\s+/g, ' ').trim()),   // whole sentences, never cut mid-phrase
    referencePrompt: portraitPrompt, sheetPrompt: refPrompt
  });
}
const general = read(path.join(src, 'Как использовать референсы.txt')).split('\n\n').filter(p => !/^Обновлено|Генерация выполнена|Работа референсов/.test(p)).join('\n');
const manifest = { version: new Date().toISOString(), source: src, general, characters };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('персонажей:', characters.length);
for (const c of characters) console.log(c.key, c.name, '| лист:', !!c.sheet, '| роль:', c.role.slice(0, 60), '| look:', c.lookEn.slice(0, 70), '| правила:', c.videoRules.slice(0, 50));
