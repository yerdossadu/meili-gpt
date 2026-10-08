FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    CHAO_DATA_DIR=/var/data FAMILY_STATE_DIR=/var/data/family-testing \
    MEILI_UPSTREAM=http://127.0.0.1:8011 OCR_LANG=chi_sim+rus+eng

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY study/server.py study/testing_gateway.py study/lesson_validation.py study/layout.py study/forma.py study/app.html study/manager.html ./study/
COPY study/hanzi ./study/hanzi
COPY launch.py ./launch.py
COPY seed/ ./seed/
RUN python -c "import pathlib,sqlite3; p=pathlib.Path('/app/seed/library.sqlite3'); assert p.is_file(), 'published lesson database missing from build'; c=sqlite3.connect(p); assert c.execute('select count(*) from lessons').fetchone()[0] == 7; assert c.execute('select count(*) from books').fetchone()[0] == 0; assert (pathlib.Path('/app/seed/forma/books')).is_dir(); print('Verified 7 published lessons and book assets in image')"
RUN mkdir -p /var/data
CMD ["python", "/app/launch.py"]
