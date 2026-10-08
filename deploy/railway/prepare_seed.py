"""Build a minimized Railway seed from published Meili lesson data only."""
import json
import shutil
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / 'data' / 'study'
output = Path(__file__).resolve().parent / 'seed'
db_path = source / 'library.sqlite3'
with sqlite3.connect(db_path) as check:
    tables = {r[0] for r in check.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    allowed = {'books', 'lessons', 'book_assets'}
    if not tables <= allowed or 'lessons' not in tables:
        raise SystemExit('Unexpected database tables; refusing to include the full database.')
    counts = {t: check.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    if counts.get('books') or counts.get('book_assets'):
        raise SystemExit('Database contains user book records; create a sanitized lessons-only database.')
    rows = list(check.execute('SELECT id,book_id,title,level,payload,created_at,sort_key FROM lessons'))
lessons = []
for lesson_id, book_id, title, level, payload, created_at, sort_key in rows:
    data = json.loads(payload)
    if data.get('source') != 'forma' or data.get('kind') not in ('textbook', 'workbook'):
        raise SystemExit(f'Non-published or unrecognized lesson found: {lesson_id}')
    lessons.append((lesson_id, book_id, title, level, payload, created_at, sort_key))
if len(lessons) != 7:
    raise SystemExit(f'Expected 7 published textbook/workbook lessons; found {len(lessons)}')
if output.exists():
    if output.resolve() != (root / 'railway-study' / 'seed').resolve():
        raise SystemExit('Unexpected seed destination; refusing recursive cleanup.')
    shutil.rmtree(output)
output.mkdir(parents=True)
target = sqlite3.connect(output / 'library.sqlite3')
target.executescript('''
CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, level TEXT NOT NULL, filename TEXT NOT NULL, status TEXT NOT NULL, page_count INTEGER DEFAULT 0, error TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE lessons (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, title TEXT NOT NULL, level TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, sort_key TEXT DEFAULT '');
CREATE TABLE book_assets (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, filename TEXT NOT NULL, stored_name TEXT NOT NULL, media_type TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
''')
target.executemany('INSERT INTO lessons(id,book_id,title,level,payload,created_at,sort_key) VALUES(?,?,?,?,?,?,?)', lessons)
target.commit()
target.close()
shutil.copytree(source / 'forma', output / 'forma')
shutil.copytree(source / 'tts', output / 'tts')
pages = sum(len(json.loads(r[4]).get('pages', [])) for r in lessons)
print(json.dumps({'lessons': len(lessons), 'published_pages': pages, 'database_tables': sorted(tables),
                  'published_asset_files': sum(1 for f in (output / 'forma').rglob('*') if f.is_file()),
                  'database_size_bytes': (output / 'library.sqlite3').stat().st_size}, ensure_ascii=True))
