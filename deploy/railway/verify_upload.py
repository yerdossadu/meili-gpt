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
    for n in (13,14,15,16,17,18,19,20,21,22,23,24,25,26):
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
            if n in (25,26):
                for q in range(15 if n==25 else 19,19 if n==25 else 23):
                    assert published['html'].count(f'data-question="{q}"')==4
                if n==25:
                    assert 'data-cloze-numbers="15,16,17,18"' in published['html']
            if n in (23,24):
                for q in range(1 if n==23 else 7,7 if n==23 else 15):
                    assert published['html'].count(f'data-question="{q}"')==4
                assert f'data-track="03-{1 if n==23 else 2}"' in published['html']
            if n in (13,14):
                for q in range(23 if n==13 else 26,26 if n==13 else 29):
                    assert published['html'].count(f'data-question="{q}"')==4
            if n==16:
                for q in range(1,7):
                    assert published['html'].count(f'data-question="{q}"')==4, f'Missing WB HSK5 page 16 question {q} choices'
            if n in (17,18):
                for q in range(7 if n==17 else 15,15 if n==17 else 19):
                    assert published['html'].count(f'data-question="{q}"')==4, f'Missing WB HSK5 page {n} question {q} choices'
            if n in (19,20):
                for q in range(19 if n==19 else 23,23 if n==19 else 26):
                    assert published['html'].count(f'data-question="{q}"')==4, f'Missing WB HSK5 page {n} question {q} choices'
            if n==21:
                for q in range(26,29):
                    assert published['html'].count(f'data-question="{q}"')==4
            if n==22:
                assert 'data-hsk-speak="打工"' in published['html'] and 'data-hsk-speak="亮"' in published['html']
        elif n==21:
            assert 'data-insertion-question=' in published['html'] and published['html'].count('hsk-source-retelling')==3
        elif n==22:
            assert 'data-hsk-speak="脑袋"' in published['html'] and 'data-gap-answers=' in published['html']
        elif n==23:
            assert published['html'].count('data-cloze-question="family-')==14
            assert 'data-hsk-speak="爷爷"' in published['html']
        elif n==24:
            assert '11.打工' in published['html'] and '*33.扑' in published['html']
        elif n==25:
            assert published['html'].count('data-cloze-question="answer-')==3
            assert '34.卧室' in published['html'] and '39.流泪' in published['html']
        elif n==26:
            assert published['html'].count('data-cloze-question="answer-')==6
            assert 'data-hsk-speak="坚决"' in published['html'] and published['html'].count('role="cell"')==18
print('PASS: published lessons only; EN/KZ and HSK5 pages 13-26 with correct routing, assets and question markers; no local credentials.')
