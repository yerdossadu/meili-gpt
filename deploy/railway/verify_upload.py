"""Validate a minimized learner mirror before sending it to Railway."""
import json
import re
import sqlite3
import sys
from pathlib import Path

package = Path(sys.argv[1]).resolve()
allowed = {'Dockerfile', 'launch.py', 'railway.json', 'requirements.txt', 'study', 'seed'}
assert {p.name for p in package.iterdir()} == allowed, 'Unexpected upload contents'
for path in package.rglob('*'):
    if not path.is_file():
        continue
    assert not any(p.startswith('.env') or p in {'.local', '.git', 'credentials.json', 'settings.json'} for p in path.relative_to(package).parts), 'Local credentials in upload'
    content = path.read_bytes()
    if b'\x00' not in content:
        assert not re.search(rb'\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', content), 'Credential pattern in upload'
db = sqlite3.connect(f'file:{(package / "seed/library.sqlite3").as_posix()}?mode=ro', uri=True)
assert db.execute('SELECT COUNT(*) FROM books').fetchone()[0] == 0
assert db.execute('SELECT COUNT(*) FROM book_assets').fetchone()[0] == 0
rows = db.execute('SELECT payload FROM lessons').fetchall()
assert rows and all(json.loads(r[0]).get('source') == 'forma' for r in rows)
app = (package / 'study/app.html').read_text(encoding='utf-8')
assert 'sheet.querySelector(\'[data-en]\')' in app, 'English switching fix missing'
for n in range(3, 8):
    page = json.loads((package / f'seed/forma/books/hsk1-v3/pages/{n:03}/page.json').read_text(encoding='utf-8'))
    assert page['page']['n'] == n
    assert 'data-en=' in page['platformPage']['forma']['html'], f'Missing English on page {n}'
    assert 'data-kz=' in page['platformPage']['forma']['html'], f'Missing Kazakh on page {n}'
    runtime = package / 'seed' / page['platformPage']['forma']['script'].lstrip('/')
    assert "lang === 'en'" in runtime.read_text(encoding='utf-8') or "lang==='en'" in runtime.read_text(encoding='utf-8')
payloads=[json.loads(r[0]) for r in rows]
for slug,kind in [('hsk5-upper','textbook'),('hsk5-workbook','workbook')]:
    for n in (13,14,15,16):
        page=json.loads((package / f'seed/forma/books/{slug}/pages/{n:03}/page.json').read_text(encoding='utf-8'))
        assert page['page']['n']==n
        published=page['platformPage']['forma']
        assert published['sourcePage']==n
        assert 'data-en=' in published['html'] and 'data-kz=' in published['html']
        assert any(p.get('kind')==kind and any(x.get('forma',{}).get('sourcePage')==n
                   and x['forma']['base']==published['base'] for x in p['pages']) for p in payloads)
        for key in ('css','script','scan'):
            assert (package / 'seed' / published[key].lstrip('/')).is_file(), f'Missing HSK5 {key}'
        if kind=='workbook':
            if n in (13,14):
                for q in range(23 if n==13 else 26,26 if n==13 else 29):
                    assert published['html'].count(f'data-question="{q}"')==4
            if n==16:
                for q in range(1,7):
                    assert published['html'].count(f'data-question="{q}"')==4, f'Missing WB HSK5 page 16 question {q} choices'
print('PASS: published lessons only; EN/KZ and HSK5 pages 13-16 with correct routing, assets and question markers; no local credentials.')
