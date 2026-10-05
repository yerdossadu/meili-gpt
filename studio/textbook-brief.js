// Page brief and media prompts for the multimedia textbook.
//
// The converted page (PDF → Web layout) already holds everything a lesson
// clip needs, exactly as printed: the lesson and section, the situation line,
// the dialogue turn by turn with its speakers, the new words and the tasks.
// This file turns that layout into a brief, matches the speakers to the
// studio's characters, and builds image and video prompts from the brief —
// so the clip shows this page's situation, these speakers and these lines,
// not a model's retelling of the book.
(function () {
  'use strict';

  // ---- Pinyin → Russian (Palladius), for matching speaker names ----------
  const INITIAL = { b: 'б', p: 'п', m: 'м', f: 'ф', d: 'д', t: 'т', n: 'н', l: 'л', g: 'г', k: 'к', h: 'х', j: 'цз', q: 'ц', x: 'с', zh: 'чж', ch: 'ч', sh: 'ш', r: 'ж', z: 'цз', c: 'ц', s: 'с' };
  const FINAL = { a: 'а', o: 'о', e: 'э', ai: 'ай', ei: 'эй', ao: 'ао', ou: 'оу', an: 'ань', en: 'энь', ang: 'ан', eng: 'эн', ong: 'ун', er: 'эр', i: 'и', ia: 'я', ie: 'е', iao: 'яо', iu: 'ю', ian: 'янь', in: 'инь', iang: 'ян', ing: 'ин', iong: 'юн', u: 'у', ua: 'уа', uo: 'о', uai: 'уай', ui: 'уй', uan: 'уань', un: 'унь', uang: 'уан', v: 'юй', ve: 'юэ', ue: 'юэ', van: 'юань', vn: 'юнь' };
  const ZERO = { yi: 'и', ya: 'я', ye: 'е', yao: 'яо', you: 'ю', yan: 'янь', yin: 'инь', yang: 'ян', ying: 'ин', yong: 'юн', yu: 'юй', yue: 'юэ', yuan: 'юань', yun: 'юнь', wu: 'у', wa: 'ва', wo: 'во', wai: 'вай', wei: 'вэй', wan: 'вань', wen: 'вэнь', wang: 'ван', weng: 'вэн' };
  const SYLLABLE = /(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ueng|uai|uan|van|ian|iao|ang|eng|ing|ong|ai|ei|ao|ou|an|en|in|un|vn|ia|ie|iu|ua|uo|ui|ue|ve|er|a|o|e|i|u|v)(?![aeiouv]|ng?(?![aeiouv]))/y;
  const bare = s => String(s || '').normalize('NFD').replace(/ü/g, 'v').replace(/ü/g, 'v').replace(/[̀-ͯ]/g, '').toLowerCase();
  function syllableRu(ini, fin) {
    if (!ini) return FINAL[fin] || fin;
    if (ini === 'y' || ini === 'w') return ZERO[ini + fin] || ZERO[ini + fin.replace(/^[iu]/, '')] || FINAL[fin] || fin;
    // zhi chi shi ri zi ci si: the "i" is a different vowel.
    if (fin === 'i' && /^(zh|ch|sh|r)$/.test(ini)) return INITIAL[ini] + 'и';
    if (fin === 'i' && /^[zcs]$/.test(ini)) return INITIAL[ini] + 'ы';
    // ju qu xu: written u, said ü.
    if (/^[jqx]$/.test(ini) && /^u/.test(fin)) fin = 'v' + fin.slice(1);
    return INITIAL[ini] + (FINAL[fin] || fin);
  }
  // "Wáng Yīfēi" → "Ван Ифэй"; null when the text is not pinyin.
  function palladius(py) {
    const words = bare(py).split(/[^a-zv']+/).filter(Boolean);
    if (!words.length) return null;
    const out = [];
    for (const w of words) {
      let ru = '', at = 0;
      for (const part of w.split("'")) {
        SYLLABLE.lastIndex = 0; at = 0;
        while (at < part.length) {
          SYLLABLE.lastIndex = at;
          const m = SYLLABLE.exec(part);
          if (!m || m.index !== at) return null;
          ru += syllableRu(m[1] || '', m[2]);
          at += m[0].length;
        }
      }
      out.push(ru.charAt(0).toUpperCase() + ru.slice(1));
    }
    return out.join(' ');
  }

  // ---- Brief from the converted page --------------------------------------
  const text = v => String(v || '').replace(/\s+/g, ' ').trim();
  // `context` comes from the studio server (…/pages/:n/context): the lesson
  // the page belongs to, its objectives, and the situation line in force.
  function brief(layout, pageNumber, context = {}) {
    const blocks = layout?.blocks || [];
    const own = blocks.find(b => b.type === 'lesson'), ctx = context.lesson;
    const lesson = ctx && ctx.number ? { number: String(ctx.number), cn: text(ctx.title), en: '', ru: text(ctx.subtitle) } : own ? { number: text(own.number), cn: text(own.cn), en: text(own.en), ru: text(own.ru) } : null;
    const sections = blocks.filter(b => b.type === 'section').map(b => ({ cn: text(b.cn), en: text(b.en), ru: text(b.ru) }));
    const situation = blocks.find(b => b.type === 'para' && b.icon === 'pin');
    const tasks = blocks.filter(b => b.type === 'para' && b.icon === 'square').map(b => ({ cn: text(b.cn), en: text(b.en), ru: text(b.ru) }));
    // No dialogue printed here: the text's dialogue from the next page
    // (context.dialogue), else one written for the page (context.generated).
    const borrowed = !blocks.some(b => b.type === 'dialogue') && context.dialogue?.blocks?.length ? context.dialogue : null;
    const source = borrowed ? borrowed.blocks : blocks;
    const card = source.find(b => b.type === 'card');
    const cardLines = (card?.lines || []).map(l => ({ en: text(l.en), ru: text(l.ru) }));
    const dialogues = source.filter(b => b.type === 'dialogue');
    const turns = dialogues.flatMap(d => d.turns || []);
    // The translation card prints one line per turn ("Wang Yifei: Hello…").
    const lineOf = k => cardLines.length === turns.length ? cardLines[k] : null;
    // Spoken lines are Chinese only: Latin words in them («AI小语») would be read out in English.
    const say = s => text(s).replace(/[A-Za-z][A-Za-z.\-]*\s*/g, '').replace(/\s{2,}/g, ' ').trim(), sayPy = s => text(s).replace(/\bAI\s+/g, '');
    let dialogue = turns.map((t, k) => {
      const tr = lineOf(k);
      const strip = s => text(s).replace(/^[^:：]{1,40}[:：]\s*/, '');
      return {
        speaker: { cn: text(t.speaker?.cn), py: text(t.speaker?.py), ru: text(t.speaker?.ru) },
        hanzi: say(t.hz), pinyin: sayPy(t.py),
        translation: tr ? strip(tr.ru || tr.en) : '', english: tr ? strip(tr.en) : ''
      };
    });
    let dialogueSource = dialogue.length ? (borrowed ? 'page ' + borrowed.page : 'page') : '';
    if (!dialogue.length && Array.isArray(context.generated) && context.generated.length) {
      dialogue = context.generated.map(t => ({ speaker: { cn: text(t.speaker?.cn), py: text(t.speaker?.py), ru: text(t.speaker?.ru) }, hanzi: say(t.hanzi), pinyin: sayPy(t.pinyin), translation: text(t.translation), english: text(t.english) }));
      dialogueSource = 'generated';
    }
    const words = blocks.filter(b => b.type === 'words').flatMap(b => b.rows || []).filter(r => !r.group && r.hz)
      .map(r => ({ hz: text(r.hz), py: text(r.py), pos: text(r.pos_en || r.pos_ru), en: text(r.en), ru: text(r.ru) }));
    const tips = blocks.filter(b => b.type === 'tip').map(b => ({ cn: text(b.cn), en: text(b.en), ru: text(b.ru) }));
    const pictures = blocks.filter(b => b.type === 'image').map(b => text(b.alt)).filter(Boolean);
    const printed = blocks.filter(b => b.type === 'objectives').flatMap(b => b.items || []);
    const objectives = (printed.length ? printed : context.objectives || []).map(o => text(o.ru || o.en || o.cn)).filter(Boolean);
    // A text's situation is printed on its first page; later pages continue it.
    const where = situation || context.situation || null;
    return {
      pageNumber, lesson, sections,
      situation: where ? { cn: text(where.cn), en: text(where.en), ru: text(where.ru) } : null,
      dialogue, dialogueSource, words, tasks, tips, pictures, objectives
    };
  }

  // ---- Speakers → studio characters ----------------------------------------
  // Soft signs vary between spellings (Аньни / Анни): left out of the match.
  const key = s => bare(s).replace(/[ьъ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  // Group speakers ("学生们" students, "同学们") are a crowd, not one person.
  const isGroup = sp => /们$/.test(sp?.cn || '') || /men$/i.test(bare(sp?.py));
  function namesOf(c) { return [c.name, c.nameZh, c.nameRu, ...(c.aliases || [])].map(key).filter(n => n.length >= 2); }
  function speakerKeys(sp) {
    const ru = palladius(sp?.py);
    return [sp?.cn, sp?.py, sp?.ru, ru].map(key).filter(k => k.length >= 2);
  }
  function matchCharacter(sp, characters) {
    const keys = speakerKeys(sp);
    if (!keys.length) return null;
    return characters.find(c => namesOf(c).some(n => keys.includes(n)))
      || characters.find(c => namesOf(c).some(n => keys.some(k => k.length >= 3 && (n.includes(k) || k.includes(n))))) || null;
  }

  // ---- Prompts ------------------------------------------------------------
  const quote = s => '「' + s + '」';
  function cast(b, characterFor) {
    const seen = new Map();
    for (const t of b.dialogue) {
      const id = t.speaker.cn || t.speaker.py;
      if (!id || seen.has(id)) continue;
      const c = characterFor(t.speaker);
      // `label` for the card (Russian), `en` for the prompts (models read Latin
      // names best): the pinyin without tones, "Wang Yifei".
      const latin = bare(t.speaker.py).replace(/v/g, 'u').split(/[^a-z]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      const group = isGroup(t.speaker);
      // A group («学生们») is played by the course's own characters when the studio names them (their references are sent).
      const members = group ? (window.FormaGroupMembers?.(t.speaker) || []) : [];
      seen.set(id, { speaker: t.speaker, character: c, group, members, label: c?.name || t.speaker.ru || palladius(t.speaker.py) || t.speaker.cn, en: group ? 'The students' : latin || c?.name || t.speaker.cn });
    }
    return [...seen.values()];
  }
  function lookOf(m) {
    if (m.group && m.members?.length) return 'these classmates, each with their own reference image (keep every face, hair, age and clothing): ' + m.members.map(c => c.name + ' — ' + [[c.genderEn && 'the ' + c.genderEn, c.ageEn].filter(Boolean).join(', '), c.lookEn].filter(Boolean).join('; ')).join(' | ');
    if (m.group) return 'a small group of students of mixed appearance, casual clothes, seated at classroom desks';
    const c = m.character;
    // Gender, age and look come first: models tell people apart by them, not by names (Li Wen / Bai Jiayue are both neutral to a model).
    return text([[c?.genderEn && 'the ' + c.genderEn, c?.ageEn].filter(Boolean).join(', '), c?.lookEn || c?.visualDescription, c?.role && 'role: ' + c.role].filter(Boolean).join('; ')) || 'appearance as in the reference image';
  }
  const tagOf = m => (!m.group && m.character?.genderEn) ? ' (the ' + m.character.genderEn + ')' : '';
  function prompts(b, { characterFor = () => null, style = '', language = '' } = {}) {
    const people = cast(b, characterFor);
    const who = sp => people.find(m => m.speaker.cn === sp.cn && m.speaker.py === sp.py) || { en: sp.cn };
    const setting = (b.situation ? (b.situation.en || b.situation.ru || b.situation.cn) : 'a classroom').replace(/[.。\s]+$/, '');
    const lessonLine = b.lesson ? `HSK 1, lesson ${b.lesson.number} «${b.lesson.cn}»${b.lesson.en || b.lesson.ru ? ' (' + (b.lesson.en || b.lesson.ru) + ')' : ''}` : 'HSK 1';
    const focus = b.words.map(w => w.hz + (w.en ? ' (' + w.en + ')' : '')).join(', ');
    // About 3 s a line plus a beat at each end; at least 10 s for a lesson clip.
    const seconds = Math.max(10, Math.min(20, 2 + b.dialogue.length * 3));
    // «Who is who» — one firm line, repeated wherever people are named.
    const known = [...people.filter(m => !m.group && m.character?.genderEn).map(m => ({ en: m.en, c: m.character })), ...people.filter(m => m.group).flatMap(m => (m.members || []).filter(c => c.genderEn).map(c => ({ en: c.name, c })))];
    const whoLine = known.length > 1 ? 'Who is who (never swap them): ' + known.map(m => `${m.en} is the ${m.c.genderEn}${m.c.lookEn ? ' (' + m.c.lookEn + ')' : ''}`).join('; ') + '.' : '';
    // The same voice for a character in every clip (from its card).
    const voiced = [...people.filter(m => !m.group && m.character).map(m => ({ en: m.en, c: m.character })), ...people.filter(m => m.group).flatMap(m => (m.members || []).map(c => ({ en: c.name, c })))].map(m => ({ en: m.en, v: window.FormaVoiceOf?.(m.c) })).filter(m => m.v);
    const voiceLine = voiced.length ? 'Voices (keep each exactly the same as in the other clips of this course): ' + voiced.map(m => `${m.en} — ${m.v}`).join('; ') + '.' : '';
    const castLines = people.map((m, k) => `${k + 1}. ${m.en}${m.speaker.cn ? ' (' + m.speaker.cn + ')' : ''}: ${lookOf(m)}${m.character && !m.group ? '; keep the face and clothing of the matching reference image' : ''}`);
    const beats = b.dialogue.map((t, k) => ({ t: k * 3, speaker: who(t.speaker).en, tag: tagOf(who(t.speaker)), says: t.hanzi, meaningNotShown: t.english || t.translation }));
    // The meaning helps the acting; models must not caption it (or the line) on screen.
    // A group line is said together by the group's members, named.
    // Whom a line is said to: the one who spoke before (the first line: the one who answers).
    const addressee = k => { const other = b.dialogue[k > 0 ? k - 1 : 1]; if (!other || (other.speaker.cn === b.dialogue[k].speaker.cn)) return ''; const m = who(other.speaker); return m.group ? 'the students' : m.en; };
    const chorus = k => { const m = who(b.dialogue[k].speaker); if (!(m.group && m.members?.length)) return ''; const men = m.members.filter(c => /^(man|boy)$/.test(c.genderEn || '')), women = m.members.filter(c => /^(woman|girl)$/.test(c.genderEn || '')); return `The students (${m.members.map(c => c.name).join(', ')}) say together${men.length && women.length ? ' — a mixed chorus: ' + men.map(c => c.name).join(', ') + '’s male voice clearly heard with the women’s' : ''}`; };
    const beatLines = beats.map((x, k) => `${k + 1}. ${chorus(k) || x.speaker + x.tag + ' says'} ${quote(x.says)} aloud${addressee(k) ? ' to ' + addressee(k) + ', facing them' : ''}${x.meaningNotShown ? ` (meaning, for acting only — never shown: ${x.meaningNotShown})` : ''}; the others react naturally.`);
    const keyMoment = beats[0] ? `${beats[0].speaker} saying ${quote(beats[0].says)}` : 'the characters meeting';

    const imagePrompt = [
      `Educational illustration for ${lessonLine}, page ${b.pageNumber}.`,
      `Setting: ${setting}.`,
      people.length ? `Characters:\n${castLines.join('\n')}` : '',
      whoLine,
      `Moment: ${keyMoment}, the others listening and reacting; faces and gestures clearly visible.`,
      focus ? `The scene illustrates: ${focus}.` : '',
      'No text, letters, captions, speech bubbles or logos in the image.',
      style ? `Visual style: ${style}` : ''
    ].filter(Boolean).join('\n');

    const videoPrompt = [
      `Short live scene for ${lessonLine}, page ${b.pageNumber}, about ${seconds} seconds.`,
      `Setting: ${setting}.`,
      people.length ? `Characters (keep identity from the reference images):\n${castLines.join('\n')}` : '',
      whoLine,
      voiceLine,
      beats.length ? `Action, in this order, one line at a time (about 3 seconds each):\n${beatLines.join('\n')}` : '',
      beats.length ? 'Spoken language: Mandarin Chinese only, say exactly the quoted lines above in this order, nothing else; do not translate them; no English, no pinyin, no Russian speech; never voice translations, pinyin or these instructions.' : '',
      beats.length > 1 ? `All ${beats.length} lines must be heard, none skipped, cut or merged, each by its own speaker: ${beats.map(x => x.speaker).join(' → ')}. Keep the pace brisk enough to fit them all.` : '',
      'Begin with the characters in place, end with a natural reaction after the last line. Anyone not visible in the first frame walks in naturally or the camera turns to them — nobody appears out of thin air, fades in or materialises. No subtitles or on-screen text.',
      focus ? `Learning focus of the page: ${focus}.` : '',
      language ? `Language rule: ${language}` : '',
      style ? `Visual style: ${style}` : ''
    ].filter(Boolean).join('\n\n');

    // The clip's opening frame: everyone in place just before the first line,
    // so the video can start from it (image-to-video) and stay on model.
    const first = beats[0], listeners = people.filter(m => m.en !== first?.speaker).map(m => m.en.replace(/^The /, 'the '));
    const startFramePrompt = [
      `Opening frame of a short live-action lesson clip for ${lessonLine}, page ${b.pageNumber}.`,
      `Setting: ${setting}.`,
      people.length ? `Characters, all in place:\n${castLines.join('\n')}` : '',
      whoLine,
      first ? `Moment: just before ${first.speaker} says ${quote(first.says)} — ${first.speaker} is about to speak${listeners.length ? ', facing ' + listeners.join(' and ') : ''}; the others are attentive. Mouths closed or just opening, natural poses.` : 'Moment: the characters meeting, natural poses.',
      'Camera: eye level, medium shot with every character fully in frame, room for movement; sharp faces.',
      'A single photographic still. No text, letters, subtitles, speech bubbles, captions or logos anywhere.',
      style ? `Visual style: ${style}` : ''
    ].filter(Boolean).join('\n');
    // With the textbook drawing as the first reference the drawing decides the
    // composition; the text only names who is who, so nothing contradicts it.
    const startFrameFromArtPrompt = [
      'Reference image 1 is the textbook drawing of this exact scene. Recreate it as a photograph.',
      'Copy from the drawing exactly: framing and crop, camera angle, number of people, who stands or sits where, their poses, gestures, gaze direction, facial expressions, clothing, furniture, objects and background. Exactly as many people as in the drawing — no extra people, no copies of anyone. Do not add or remove people or objects, do not move anyone, do not invent a different room.',
      'Change only the rendering: drawing → real photographic still.',
      // Names with gender and age only: the drawing, not the reference, dresses them.
      known.length > 1 ? 'Who is who (never swap them): ' + known.map(m => `${m.en} is the ${m.c.genderEn}${m.c.ageEn ? ', ' + m.c.ageEn : ''}`).join('; ') + '.' : '',
      people.length ? `Who is who in the drawing: ${people.map(m => (m.group && m.members?.length ? `the students — ${m.members.map(c => c.name).join(', ')}` : m.en) + (m.speaker.cn ? ` (${m.speaker.cn})` : '')).join(', ')}.\nThe pictures after the drawing are FACE references only: give each person of the drawing the face, hair and age of their reference, once. Everything else — clothing, pose, placement, the room — stays as in the drawing.${people.some(m => !m.group && window.FormaFixedOutfit?.(m.character)) ? ' Exception: ' + people.filter(m => !m.group && window.FormaFixedOutfit?.(m.character)).map(m => m.en + ' always wears the outfit of her/his reference (' + (m.character.lookEn || 'as in the reference') + '), not the clothes of the drawing').join('; ') + '.' : ''}` : '',
      'No text, letters, subtitles, speech bubbles, captions or logos anywhere, even if the drawing has them.',
      style ? `Visual style: ${style}` : ''
    ].filter(Boolean).join('\n');

    const videoPromptJson = {
      lesson: lessonLine, page: b.pageNumber, setting, durationSeconds: seconds,
      // A group is listed by its members, each with its own reference; its lines are said together.
      characters: people.flatMap(m => m.group && m.members?.length
        ? [{ name: 'The students', chinese: m.speaker.cn || '', group: true, members: m.members.map(c => ({ name: c.name, gender: c.genderEn || '', age: c.ageEn || '', appearance: c.lookEn || '', voice: window.FormaVoiceOf?.(c) || '', reference: true })) }]
        : [{ name: m.en, chinese: m.speaker.cn || '', gender: m.character?.genderEn || '', age: m.character?.ageEn || '', group: m.group, appearance: lookOf(m), voice: m.character ? window.FormaVoiceOf?.(m.character) || '' : '', reference: Boolean(m.character && !m.group) }]),
      // The executed JSON carries no translations: only the lines to be spoken, in order, by whom.
      beats: beats.map((x, k) => ({ t: x.t, speaker: chorus(k) ? 'The students (together)' : x.speaker, to: addressee(k), says: x.says })),
      spokenRule: 'Speak ONLY these Mandarin lines, verbatim and in this order; do not translate, add or voice anything else (no English, pinyin or Russian).',
      camera: 'Medium shot of the speakers; close-up on each speaker for their line; one wider shot at the end',
      spokenLanguage: 'Mandarin Chinese (Simplified hanzi lines verbatim)', onScreenText: 'none',
      learningFocus: b.words.map(w => w.hz)
    };
    return { imagePrompt, videoPrompt, videoPromptJson, startFramePrompt, startFrameFromArtPrompt, people, seconds };
  }

  // Card fields (the studio's page card) from a brief.
  function cardFields(b, characterFor) {
    const people = cast(b, characterFor);
    const who = sp => people.find(m => m.speaker.cn === sp.cn && m.speaker.py === sp.py)?.label || sp.cn;
    const goal = [b.objectives.length ? 'Цели урока: ' + b.objectives.join(' ') : '', b.words.length ? 'Новые слова: ' + b.words.map(w => w.hz + ' ' + w.py + ' — ' + (w.ru || w.en)).join('; ') : ''].filter(Boolean).join('\n');
    return {
      dialogue: b.dialogue.map(t => ({ character: who(t.speaker), hanzi: t.hanzi, pinyin: t.pinyin, translation: t.translation || t.english })),
      characters: people.map(m => m.label + (m.speaker.cn ? ' (' + m.speaker.cn + ')' : '') + (m.group ? ' — группа учеников' : m.character ? '' : ' — нет карточки персонажа')).join('; '),
      scene: b.situation ? (b.situation.ru || b.situation.en || b.situation.cn) : '',
      learningGoal: goal,
      summary: [b.lesson ? 'Урок ' + b.lesson.number + ' «' + b.lesson.cn + '»' + (b.lesson.ru ? ' (' + b.lesson.ru + ')' : '') : '', b.sections.map(s => s.cn + (s.ru || s.en ? ' — ' + (s.ru || s.en) : '')).join(', ')].filter(Boolean).join(' · ')
    };
  }

  window.FormaBrief = { palladius, brief, matchCharacter, isGroup, prompts, cardFields };
})();
