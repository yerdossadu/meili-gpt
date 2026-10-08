"""Password-protected learner-only gateway; the local platform stays unchanged."""
import base64
import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, Response
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get('FAMILY_STATE_DIR', str(ROOT / '.local' / 'family-testing')))
UPSTREAM = os.environ.get('MEILI_UPSTREAM', 'http://127.0.0.1:8010')
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
lock = threading.Lock()

def credentials():
    if os.environ.get('FAMILY_TEST_USERNAME') and os.environ.get('FAMILY_TEST_PASSWORD'):
        return {'username': os.environ['FAMILY_TEST_USERNAME'], 'password': os.environ['FAMILY_TEST_PASSWORD']}
    return json.loads((STATE / 'credentials.json').read_text(encoding='utf-8-sig'))

@app.middleware('http')
async def protect(request: Request, call_next):
    if request.url.path == '/healthz':
        return Response('{"ok":true}', media_type='application/json', headers={'Cache-Control': 'no-store'})
    valid = False
    try:
        scheme, encoded = request.headers.get('authorization', '').split(' ', 1)
        user, password = base64.b64decode(encoded, validate=True).decode().split(':', 1)
        expected = credentials()
        valid = (scheme.lower() == 'basic' and
                 secrets.compare_digest(user.encode(), expected['username'].encode()) and
                 secrets.compare_digest(password.encode(), expected['password'].encode()))
    except (ValueError, UnicodeError, OSError):
        pass
    if not valid:
        response = Response('Enter the family testing login.', 401,
                            headers={'WWW-Authenticate': 'Basic realm="Meili testing", charset="UTF-8"'})
    else:
        response = await call_next(request)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response

FEEDBACK_PAGE = '''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Отзыв — Meili</title><style>body{font:18px/1.5 system-ui;margin:32px auto;padding:0 20px;max-width:650px;color:#253833;background:#f6f8f6}label{display:block;margin-top:20px}input,textarea,button{box-sizing:border-box;font:inherit;padding:12px;border:1px solid #aebdb5;border-radius:10px;width:100%}button{margin-top:20px;background:#265e4d;color:white;cursor:pointer}a{color:#265e4d}</style>
<a href="/">← Вернуться к занятиям</a><h1>Как прошли занятия?</h1><p>Напиши, что получилось, что было непонятно и что хочется улучшить. Отзыв сохранится на компьютере папы.</p>
<p><a href="/feedback/export">Скачать отправленные отзывы</a></p><form method="post" action="/feedback"><label>Учебник или тетрадь, урок и страница<input name="page" maxlength="300" placeholder="Например: рабочая тетрадь, страница 3"></label>
<label>Твои замечания<textarea name="message" rows="8" maxlength="6000" required></textarea></label><button>Отправить отзыв</button></form></html>'''

@app.get('/feedback')
def feedback_form():
    return HTMLResponse(FEEDBACK_PAGE)

@app.get('/feedback/export')
def feedback_export():
    path = STATE / 'feedback.jsonl'
    if not path.is_file():
        return Response('Отзывов пока нет.', status_code=404, media_type='text/plain; charset=utf-8')
    from fastapi.responses import FileResponse
    return FileResponse(path, media_type='application/x-ndjson', filename='meili-feedback.jsonl',
                        headers={'Cache-Control': 'private, no-store'})

@app.post('/feedback')
async def feedback_save(request: Request):
    origin = request.headers.get('origin', '')
    if not origin or urlsplit(origin).netloc != request.headers.get('host'):
        return Response('Invalid origin', 403)
    body = await limited_body(request, 32000)
    if body is None:
        return Response('Feedback too large', 413)
    from urllib.parse import parse_qs
    form = parse_qs(body.decode('utf-8', errors='replace'))
    message = form.get('message', [''])[0].strip()
    page = form.get('page', [''])[0].strip()
    if not message or len(message) > 6000 or len(page) > 300:
        return Response('Please write a message (up to 6000 characters).', 400)
    entry = {'time': datetime.now(timezone.utc).isoformat(), 'page': page, 'message': message}
    STATE.mkdir(parents=True, exist_ok=True)
    with lock, (STATE / 'feedback.jsonl').open('a', encoding='utf-8') as file:
        file.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return HTMLResponse('<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:20px system-ui;padding:32px"><h1>Спасибо! Отзыв сохранён.</h1><a href="/">Продолжить занятия</a> · <a href="/feedback">Ещё один отзыв</a></body></html>')

async def limited_body(request, maximum):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum:
            return None
    return bytes(body)

@app.api_route('/{path:path}', methods=['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
async def proxy(path: str, request: Request):
    route = '/' + path
    if any(part in ('.', '..') for part in path.split('/')) or '\\' in path:
        return Response('Not available', 404)
    reading = request.method in ('GET', 'HEAD') and (
        route in ('/', '/api/health', '/api/lessons', '/api/tts') or
        route.startswith(('/hanzi/', '/forma/')))
    practice = request.method == 'POST' and route in ('/api/tutor', '/api/practice/evaluate')
    if not (reading or practice):
        return Response('Only learner features are available in this test.', 403)
    body = await limited_body(request, 64000)
    if body is None:
        return Response('Request too large', 413)
    headers = {k: v for k, v in request.headers.items() if k.lower() in ('content-type', 'range')}
    try:
        upstream = await run_in_threadpool(requests.request, request.method,
            UPSTREAM + route, params=request.url.query, data=body,
            headers=headers, timeout=100, allow_redirects=False)
    except requests.RequestException:
        return Response('The local platform is offline. Please try again later.', 502)
    content = upstream.content
    response_headers = {k: v for k, v in upstream.headers.items()
                        if k.lower() in ('content-type', 'content-range', 'accept-ranges')}
    if route == '/' and request.method == 'GET' and upstream.status_code == 200:
        link = '<a href="/feedback" target="_blank" rel="noopener" style="position:fixed;right:16px;bottom:16px;z-index:99999;background:#265e4d;color:white;padding:10px 16px;border-radius:24px;font:15px system-ui;box-shadow:0 2px 12px #0003">Оставить отзыв</a>'
        content = content.replace(b'</body>', link.encode() + b'</body>')
    return Response(content, upstream.status_code, headers=response_headers)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8011, access_log=False)
