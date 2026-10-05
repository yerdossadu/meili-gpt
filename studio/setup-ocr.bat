@echo off
setlocal
cd /d "%~dp0"
set "FORMA_BASE_PYTHON=C:\Users\finecompKZ\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
set "FORMA_OCR_PYTHON=%~dp0ocr-runtime\Scripts\python.exe"
set "TMP=%~dp0.ocr-tmp"
set "TEMP=%~dp0.ocr-tmp"
if not exist "%TMP%" mkdir "%TMP%"

if not exist "%FORMA_BASE_PYTHON%" (
  echo Forma bundled Python runtime was not found:
  echo %FORMA_BASE_PYTHON%
  pause
  exit /b 1
)

if not exist "%FORMA_OCR_PYTHON%" (
  echo Creating an isolated OCR environment...
  "%FORMA_BASE_PYTHON%" -m venv --without-pip "%~dp0ocr-runtime"
  if errorlevel 1 (
    echo Could not create the OCR environment with the bundled Python runtime.
    pause
    exit /b 1
  )
)

echo Installing PaddlePaddle CPU and PaddleOCR. This may take several minutes.
"%FORMA_BASE_PYTHON%" -m pip --python "%FORMA_OCR_PYTHON%" install paddlepaddle==3.3.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
if errorlevel 1 goto :failed
"%FORMA_BASE_PYTHON%" -m pip --python "%FORMA_OCR_PYTHON%" install paddleocr==3.3.0
if errorlevel 1 goto :failed
"%FORMA_BASE_PYTHON%" -m pip --python "%FORMA_OCR_PYTHON%" install truststore
if errorlevel 1 goto :failed

echo OCR setup is complete. Restart Forma Studio to enable local OCR and PDF layout extraction.
pause
exit /b 0

:failed
echo OCR setup failed. Keep this window open and copy the last error message.
pause
exit /b 1
