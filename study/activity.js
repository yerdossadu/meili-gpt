(function (root) {
  'use strict';
  function createActivity(storage, now = () => new Date()) {
    const key = 'meili_gpt_activity_v1';
    function dateKey(date = now()) {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Qyzylorda', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
      const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
      return `${values.year}-${values.month}-${values.day}`;
    }
    function history() {
      try {
        const value = JSON.parse(storage.getItem(key) || '{}');
        if (!value || Array.isArray(value) || typeof value !== 'object') return {};
        return Object.fromEntries(Object.entries(value).filter(([day, item]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && item && Number.isFinite(item.seconds) && item.seconds >= 0 && Array.isArray(item.words)));
      } catch (_) { return {}; }
    }
    function record(seconds = 0, word) {
      const data = history(), day = dateKey();
      const item = data[day] || { seconds: 0, words: [] };
      item.seconds += Math.max(0, Number(seconds) || 0);
      if (word && !item.words.includes(word)) item.words.push(word);
      data[day] = item;
      const kept = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).slice(-370));
      try { storage.setItem(key, JSON.stringify(kept)); } catch (_) { /* Session stays usable if browser storage is full. */ }
    }
    function series(mode = 'week') {
      const data = history(), day = dateKey(), anchor = new Date(day + 'T12:00:00Z');
      const dayString = d => d.toISOString().slice(0, 10);
      const addDays = (d, count) => new Date(d.getTime() + count * 86400000);
      if (mode === 'week') {
        const monday = addDays(anchor, -((anchor.getUTCDay() + 6) % 7));
        return ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, i) => {
          const date = dayString(addDays(monday, i)), item = data[date] || { seconds: 0, words: [] };
          return { date, label: `${label} ${date.slice(8)}`, time: Math.round(item.seconds / 60), words: item.words.length };
        });
      }
      const year = anchor.getUTCFullYear(), month = anchor.getUTCMonth(), days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const prefix = day.slice(0, 7);
      return Array.from({ length: Math.ceil(days / 7) }, (_, i) => {
        const start = i * 7 + 1, end = Math.min(start + 6, days); let seconds = 0; const words = new Set();
        for (let d = start; d <= end; d++) {
          const item = data[`${prefix}-${String(d).padStart(2, '0')}`];
          if (item) { seconds += item.seconds; item.words.forEach(w => words.add(w)); }
        }
        return { label: `${start}–${end}`, time: Math.round(seconds / 60), words: words.size };
      });
    }
    return { dateKey, history, record, series };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createActivity };
  else root.MeiliActivity = createActivity(root.localStorage);
})(typeof window === 'undefined' ? {} : window);
