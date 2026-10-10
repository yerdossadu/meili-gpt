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
if not lessons:
    raise SystemExit('No published textbook/workbook lessons found.')
# Q-001 remains open. Keep the verified online WB HSK1 page rather than
# shipping the known overlapping-card revision from the current local mirror.
preserved = None
old_page = output / 'forma/books/hsk1-v3-workbook/pages/003/page.json'
local_page = source / 'forma/books/hsk1-v3-workbook/pages/003/page.json'
if local_page.exists():
    import re
    local = json.loads(local_page.read_text(encoding='utf-8'))
    html = local['platformPage']['forma']['html']
    frames = re.findall(r'<figure\b[^>]*class="[^"]*hsk-photo[^>]*style="([^"]*)"', html)
    bounds = []
    for style in frames:
        left = re.search(r'left:([\d.]+)%', style)
        width = re.search(r'width:([\d.]+)%', style)
        if left and width:
            bounds.append((float(left[1]), float(width[1])))
    bounds.sort()
    if len(bounds) == 4 and any(a[0]+a[1] > b[0]+.1 for a,b in zip(bounds,bounds[1:])):
        if not old_page.exists():
            raise SystemExit('WB HSK1 page 3 overlaps and no verified deployment copy exists.')
        preserved = json.loads(old_page.read_text(encoding='utf-8'))
        if preserved.get('conversionId') != '9f1a4b3d-0e20-4a07-8ec0-c5960cb85964':
            raise SystemExit('Unexpected fallback revision for Q-001; refusing to replace online page.')
        # Read into memory before rebuilding the package; never alter local data.
        preserved_files = {p.relative_to(output / 'forma'):p.read_bytes()
                           for p in old_page.parent.rglob('*') if p.is_file()}
        for key in ('css','script'):
            rel = Path(preserved['platformPage']['forma'][key].removeprefix('/forma/'))
            preserved_files[rel] = (output / 'forma' / rel).read_bytes()
        refreshed=[]
        for row in lessons:
            values=list(row)
            if row[0] == 'forma-hsk1-v3-workbook-001':
                payload=json.loads(row[4])
                payload['pages']=[preserved['platformPage'] if p.get('forma',{}).get('sourcePage')==3 else p
                                  for p in payload['pages']]
                values[4]=json.dumps(payload,ensure_ascii=False)
            refreshed.append(tuple(values))
        lessons=refreshed
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
if preserved:
    for rel,content in preserved_files.items():
        destination=output / 'forma' / rel
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_bytes(content)
    print('Q-001: preserved verified WB HSK1 source page 3; local revision untouched.')
shutil.copytree(source / 'tts', output / 'tts')
pages = sum(len(json.loads(r[4]).get('pages', [])) for r in lessons)
print(json.dumps({'lessons': len(lessons), 'published_pages': pages, 'database_tables': sorted(tables),
                  'published_asset_files': sum(1 for f in (output / 'forma').rglob('*') if f.is_file()),
                  'database_size_bytes': (output / 'library.sqlite3').stat().st_size}, ensure_ascii=True))
