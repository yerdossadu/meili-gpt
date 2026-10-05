import json
import os
import shutil
import sys
import tarfile
import tempfile
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import truststore


ROOT = Path(__file__).resolve().parent
OCR_TEMP = ROOT / ".ocr-tmp"
OCR_HOME = OCR_TEMP / "paddle-home"
OCR_TEMP.mkdir(parents=True, exist_ok=True)
OCR_HOME.mkdir(parents=True, exist_ok=True)
# Keep Paddle/PaddleX model caches inside Forma's ignored local runtime folder.
os.environ["USERPROFILE"] = str(OCR_HOME)
os.environ["HOME"] = str(OCR_HOME)
os.environ["XDG_CACHE_HOME"] = str(OCR_HOME / ".cache")
os.environ["TMP"] = str(OCR_TEMP)
os.environ["TEMP"] = str(OCR_TEMP)
os.environ["TMPDIR"] = str(OCR_TEMP)
tempfile.tempdir = str(OCR_TEMP)
os.environ["PADDLE_PDX_MODEL_SOURCE"] = "bos"
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
truststore.inject_into_ssl()
_original_temporary_directory = tempfile.TemporaryDirectory


class WorkspaceTemporaryDirectory(_original_temporary_directory):
    def cleanup(self):
        try:
            super().cleanup()
        except PermissionError:
            # Restricted Windows runs can create temp folders but deny their removal.
            pass


tempfile.TemporaryDirectory = WorkspaceTemporaryDirectory
_original_move = shutil.move
_original_rmtree = shutil.rmtree


def remove_workspace_temp(path, *args, **kwargs):
    try:
        return _original_rmtree(path, *args, **kwargs)
    except PermissionError:
        root = os.path.normcase(os.path.abspath(OCR_TEMP))
        target = os.path.normcase(os.path.abspath(os.fspath(path)))
        if os.path.commonpath([root, target]) == root:
            return None
        raise


def move_with_copy_fallback(source, destination, *args, **kwargs):
    try:
        return _original_move(source, destination, *args, **kwargs)
    except PermissionError:
        if os.path.isdir(source):
            os.makedirs(destination, exist_ok=True)
            shutil.copytree(source, destination, dirs_exist_ok=True)
            return destination
        copy_function = kwargs.get("copy_function", shutil.copy2)
        target = os.path.join(destination, os.path.basename(source)) if os.path.isdir(destination) else destination
        copy_function(source, target)
        return target


shutil.move = move_with_copy_fallback
shutil.rmtree = remove_workspace_temp

MODEL_CACHE = OCR_HOME / ".paddlex" / "official_models"
MODEL_HOST = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"
OCR_MODEL_NAMES = ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec")


def _safe_extract_model(archive_path, model_name):
    destination = MODEL_CACHE / model_name
    destination.mkdir(parents=True, exist_ok=True)
    root = os.path.normcase(os.path.abspath(destination))
    archive_root = f"{model_name}_infer"
    members = []
    with tarfile.open(archive_path, "r:*") as archive:
        for member in archive.getmembers():
            if member.issym() or member.islnk():
                raise RuntimeError("В архиве OCR-модели обнаружена ссылка; распаковка остановлена.")
            if member.name == archive_root:
                continue
            if not member.name.startswith(archive_root + "/"):
                raise RuntimeError("Неожиданная структура архива OCR-модели.")
            member.name = member.name[len(archive_root) + 1:]
            target = os.path.normcase(os.path.abspath(destination / member.name))
            if os.path.commonpath([root, target]) != root:
                raise RuntimeError("Путь в архиве OCR-модели выходит за пределы кэша.")
            members.append(member)
        archive.extractall(destination, members=members, filter="data")


def _ensure_ocr_models():
    try:
        import requests
    except ModuleNotFoundError as error:
        raise RuntimeError("Модуль requests не установлен. Запустите setup-ocr.bat.") from error
    MODEL_CACHE.mkdir(parents=True, exist_ok=True)
    for model_name in OCR_MODEL_NAMES:
        model_dir = MODEL_CACHE / model_name
        if model_dir.is_dir() and any(model_dir.iterdir()):
            continue
        archive_path = OCR_TEMP / f"{model_name}_infer.tar"
        url = f"{MODEL_HOST}/{model_name}_infer.tar"
        if not archive_path.is_file() or archive_path.stat().st_size == 0:
            with requests.get(url, stream=True, timeout=(20, 180)) as response:
                response.raise_for_status()
                expected_size = int(response.headers.get("content-length", "0") or 0)
                written = 0
                with open(archive_path, "wb") as archive_file:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            archive_file.write(chunk)
                            written += len(chunk)
                if expected_size and written != expected_size:
                    raise RuntimeError(f"Не удалось полностью скачать OCR-модель {model_name}.")
        _safe_extract_model(archive_path, model_name)
        if not model_dir.is_dir() or not any(model_dir.iterdir()):
            raise RuntimeError(f"Архив модели {model_name} не создал ожидаемую папку кэша.")
        try:
            archive_path.unlink()
        except OSError:
            pass

_ENGINE = None


def _result_json(result):
    value = getattr(result, "json", {})
    if callable(value):
        value = value()
    if isinstance(value, str):
        value = json.loads(value)
    return value if isinstance(value, dict) else {}


def _box_values(box):
    values = list(box)
    if len(values) == 4 and all(isinstance(value, (int, float)) for value in values):
        return [float(value) for value in values]
    points = [point for point in values if isinstance(point, (list, tuple)) and len(point) >= 2]
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def _get_engine():
    global _ENGINE
    if _ENGINE is None:
        _ensure_ocr_models()
        try:
            from paddleocr import PaddleOCR
        except ModuleNotFoundError as error:
            if error.name and (error.name.startswith("paddle") or error.name == "PIL"):
                raise RuntimeError("PaddleOCR не установлен. Запустите setup-ocr.bat и повторите распознавание.") from error
            raise
        with redirect_stdout(sys.stderr):
            _ENGINE = PaddleOCR(
                lang="ch",
                device="cpu",
                enable_mkldnn=False,
                cpu_threads=4,
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
    return _ENGINE


def extract(image_path, page_number, dpi):
    try:
        from PIL import Image
    except ModuleNotFoundError as error:
        raise RuntimeError("Pillow не установлен. Запустите setup-ocr.bat и повторите распознавание.") from error

    with Image.open(image_path) as image:
        width, height = image.size

    with redirect_stdout(sys.stderr):
        results = _get_engine().predict(str(image_path))
    lines = []
    for item in results:
        raw = _result_json(item)
        data = raw.get("res", raw)
        texts = data.get("rec_texts", [])
        boxes = data.get("rec_boxes", data.get("rec_polys", []))
        scores = data.get("rec_scores", [])
        for text, box, score in zip(texts, boxes, scores):
            text = str(text or "").strip()
            coords = _box_values(box)
            if not text or not coords:
                continue
            x0, y0, x1, y1 = coords
            x0, x1 = max(0, min(width, x0)), max(0, min(width, x1))
            y0, y1 = max(0, min(height, y0)), max(0, min(height, y1))
            if x1 <= x0 or y1 <= y0:
                continue
            lines.append({
                "id": len(lines),
                "text": text,
                "confidence": round(float(score), 4),
                "position": {
                    "x": round(x0 / width, 6),
                    "y": round(y0 / height, 6),
                    "width": round((x1 - x0) / width, 6),
                    "height": round((y1 - y0) / height, 6),
                },
            })

    return {
        "version": 11,
        "engine": "PaddleOCR",
        "model": "PP-OCRv5_mobile",
        "pageNumber": page_number,
        "dpi": dpi,
        "width": width,
        "height": height,
        "coordinateSpace": "normalized-0-1",
        "lines": lines,
    }


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            self._reply(404, {"error": "Not found"})
            return
        self._reply(200, {"available": True, "version": 11, "engine": "PaddleOCR", "device": "cpu", "mkldnn": False, "model": "PP-OCRv5_mobile"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/ocr":
            self._reply(404, {"error": "Not found"})
            return
        try:
            query = parse_qs(parsed.query)
            page_number = int(query.get("page", ["1"])[0])
            dpi = int(query.get("dpi", ["288"])[0])
            size = int(self.headers.get("Content-Length", "0"))
            if page_number < 1 or dpi < 72 or dpi > 600 or size < 1 or size > 120 * 1024 * 1024:
                raise ValueError("Неверные параметры страницы или размера изображения.")
            image_data = self.rfile.read(size)
            if len(image_data) != size:
                raise ValueError("Не удалось полностью получить изображение страницы.")
            with tempfile.NamedTemporaryFile(prefix="page-", suffix=".png", dir=OCR_TEMP, delete=False) as image_file:
                image_file.write(image_data)
                image_path = image_file.name
            try:
                self._reply(200, extract(image_path, page_number, dpi))
            finally:
                try:
                    os.remove(image_path)
                except OSError:
                    pass
        except Exception as error:
            message = str(error).strip() or "Не удалось распознать страницу."
            self._reply(503, {"error": message})

    def log_message(self, format_string, *args):
        sys.stderr.write("OCR service: " + format_string % args + "\n")


if __name__ == "__main__":
    host, port = "127.0.0.1", int(os.environ.get("FORMA_OCR_PORT", "4182"))
    HTTPServer((host, port), Handler).serve_forever()
