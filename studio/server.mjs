import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWebbook } from './webbook/server.mjs';
import { createPdfLayout } from './webbook/pdf-layout.mjs';
import { createAutoWeb } from './webbook/auto-web.mjs';
import { createAiLog } from './ailog.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4180);
let apiKey = '';
let aliKey = ''; let oaKey = '', oaModels = [], oaImageModels = [];
const ALI_BASE = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com';
const videoJobs = new Map();
const localFfmpeg = join(root, '.tools', 'ffmpeg', 'ffmpeg.exe');
const localFfprobe = join(root, '.tools', 'ffmpeg', 'ffprobe.exe');
const ffmpegPath = process.env.FFMPEG_PATH || (existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg');
const ffprobePath = process.env.FFPROBE_PATH || (existsSync(localFfprobe) ? localFfprobe : 'ffprobe');
const demucsPath = process.env.DEMUCS_PATH || 'demucs';
const bundledPoppler = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'poppler', 'Library', 'bin', 'pdftoppm.exe');
const pdfToPpmPath = process.env.PDFTOPPM_PATH || (existsSync(bundledPoppler) ? bundledPoppler : 'pdftoppm');

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.json':'application/json; charset=utf-8', '.zip':'application/zip', '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime' };

function run(command, args, { maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    const stdout = [], stderr = [];
    let outputSize = 0;
    child.stdout.on('data', chunk => { outputSize += chunk.length; if (outputSize > maxOutput) { child.kill(); reject(new Error('Слишком большой вывод FFmpeg.')); } else stdout.push(chunk); });
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('FFmpeg не найден. Установите FFmpeg и FFprobe, затем перезапустите Forma Studio.') : error.code === 'EPERM' ? new Error('Windows запретила запуск FFmpeg из текущей сессии. Запустите Forma Studio в обычном PowerShell, где разрешён запуск ffmpeg.exe и ffprobe.exe.') : error));
    child.on('close', code => code === 0 ? resolve({ stdout:Buffer.concat(stdout), stderr:Buffer.concat(stderr).toString('utf8') }) : reject(new Error(Buffer.concat(stderr).toString('utf8').trim().slice(-3000) || `FFmpeg завершился с кодом ${code}.`)));
  });
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error(`Файл превышает лимит ${Math.round(limit / 1024 / 1024)} МБ.`); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function sendFile(res, path, headers = {}) {
  res.writeHead(200, { 'cache-control':'no-store', ...headers });
  await new Promise((resolve, reject) => { const stream = createReadStream(path); stream.on('error', reject); stream.on('end', resolve); stream.pipe(res); });
}

async function expireVideoJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of videoJobs) if (job.created < cutoff) { videoJobs.delete(id); await rm(job.dir, { recursive:true, force:true }).catch(()=>{}); }
}
const videoJobCleanup = setInterval(() => expireVideoJobs().catch(()=>{}), 5 * 60 * 1000);
videoJobCleanup.unref();

const webbook = createWebbook({ root, getApiKey: () => apiKey, getAliKey: () => aliKey, origin: `http://127.0.0.1:${port}` });
const pdfLayout = createPdfLayout({ root, renderScan: webbook.renderScan });
const autoWeb = createAutoWeb({ root, renderScan: webbook.renderScan, getApiKey: () => apiKey, adoptLocal: webbook.adoptLocal });
// Journal of every AI image and video (kept beside the books, on drive D through the library junction).
const aiLog = createAiLog(join(root, 'library', 'ai-log'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (await autoWeb.handle(req, res, url)) return;
  if (await pdfLayout.handle(req, res, url)) return;
  if (await webbook.handle(req, res, url)) return;
  if (await aiLog.handle(req, res, url)) return;
  if (req.method === 'POST' && url.pathname === '/local/pdf/page') {
    let dir;
    try {
      const page = Number(url.searchParams.get('page'));
      if (!Number.isInteger(page) || page < 1 || page > 5000) throw new Error('Номер страницы должен быть от 1 до 5000.');
      const buffer = await readBody(req, 200 * 1024 * 1024);
      if (!buffer.length) throw new Error('PDF пустой.');
      dir = await mkdtemp(join(tmpdir(), 'forma-pdf-'));
      const input = join(dir, 'source.pdf'), prefix = join(dir, 'page');
      await writeFile(input, buffer);
      await run(pdfToPpmPath, ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', '120', input, prefix], { maxOutput:1024*1024 });
      const output = prefix + '.png';
      if (!existsSync(output)) throw new Error('Не удалось отрисовать эту страницу PDF. Проверьте номер страницы.');
      await sendFile(res, output, { 'content-type':'image/png', 'cache-control':'no-store' });
    } catch (error) {
      res.writeHead(400, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
      res.end(JSON.stringify({ error:error.message || 'Не удалось обработать PDF.' }));
    } finally { if (dir) await rm(dir, { recursive:true, force:true }).catch(()=>{}); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/local/video/status') {
    try { await run(ffmpegPath, ['-version'], { maxOutput:4096 }); await run(ffprobePath, ['-version'], { maxOutput:4096 }); let separatorAvailable=false; try { await run(demucsPath, ['--help'], { maxOutput:1024*1024 }); separatorAvailable=true; } catch {} res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify({ available:true, separatorAvailable })); }
    catch (error) { res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify({ available:false, error:error.message })); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/local/video/jobs') {
    await expireVideoJobs();
    let dir;
    try {
      const name = url.searchParams.get('name') || 'clip.mp4';
      const preserveBackground = url.searchParams.get('separate') === '1';
      const extension = extname(name).toLowerCase();
      if (!['.mp4','.mov','.m4v','.webm','.mkv'].includes(extension)) throw new Error('Поддерживаются MP4, MOV, M4V, WebM и MKV.');
      const buffer = await readBody(req, 80 * 1024 * 1024);
      if (!buffer.length) throw new Error('Видеофайл пуст.');
      dir = await mkdtemp(join(tmpdir(), 'forma-video-'));
      const input = join(dir, `source${extension}`), audio = join(dir, 'source.wav');
      await writeFile(input, buffer);
      const probe = await run(ffprobePath, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height:stream_side_data=rotation:format=duration','-of','json',input], { maxOutput:4096 });
      const probeData = JSON.parse(probe.stdout.toString('utf8'));
      const duration = Number(probeData.format?.duration);
      const videoStream = probeData.streams?.[0] || {};
      const rotation = Number(videoStream.side_data_list?.find(item => Number.isFinite(Number(item.rotation)))?.rotation || 0);
      const swapsDimensions = Math.abs(rotation % 180) === 90;
      const width = Number(swapsDimensions ? videoStream.height : videoStream.width);
      const height = Number(swapsDimensions ? videoStream.width : videoStream.height);
      if (!Number.isFinite(duration)) throw new Error('Не удалось определить длительность видео.');
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('Не удалось определить размер кадра видео.');
      if (duration > 20.25) throw new Error(`Длительность видео ${duration.toFixed(1)} с. Максимум — 20 секунд.`);
      if (duration < 0.25) throw new Error('Видео слишком короткое.');
      await run(ffmpegPath, ['-y','-i',input,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',audio], { maxOutput:4096 });
      let background = '';
      if (preserveBackground) {
        const stemsDir=join(dir,'stems');
        try { await run(demucsPath, ['-d','cpu','--two-stems=vocals','-n','htdemucs','--out',stemsDir,audio], { maxOutput:1024*1024 }); } catch(error) { if(error.code==='ENOENT') throw new Error('Demucs не найден. Установите его по инструкции в README и перезапустите Forma Studio.'); throw error; }
        const stemDir=join(stemsDir,'htdemucs','source');
        const vocals=join(stemDir,'vocals.wav'); background=join(stemDir,'no_vocals.wav');
        await stat(vocals); await stat(background); const id=randomUUID(); videoJobs.set(id, { dir, input, audio:vocals, background, duration, width, height, created:Date.now() });
        await sendFile(res, vocals, { 'content-type':'audio/wav', 'x-forma-job-id':id, 'x-forma-duration':String(duration), 'x-forma-separated':'true' });
      } else {
        const id = randomUUID(); videoJobs.set(id, { dir, input, audio, duration, width, height, created:Date.now() });
        await sendFile(res, audio, { 'content-type':'audio/wav', 'x-forma-job-id':id, 'x-forma-duration':String(duration) });
      }
    } catch (error) {
      if (dir) await rm(dir, { recursive:true, force:true }).catch(()=>{});
      res.writeHead(error.message.startsWith('Файл превышает') ? 413 : 400, { 'content-type':'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify({ error:{ message:error.message } }));
    }
    return;
  }
  const referenceMatch = req.method === 'POST' && url.pathname.match(/^\/local\/video\/jobs\/([\w-]+)\/reference$/);
  if (referenceMatch) {
    const job=videoJobs.get(referenceMatch[1]);
    if (!job) { res.writeHead(404, { 'content-type':'application/json' }); res.end('{"error":{"message":"Задача истекла. Загрузите видео ещё раз."}}'); return; }
    try {
      const input=join(job.dir,'voice-reference-input'), output=join(job.dir,'voice-reference.wav');
      await writeFile(input, await readBody(req, 30*1024*1024));
      await run(ffmpegPath,['-y','-i',input,'-vn','-t','20','-ac','1','-ar','16000','-c:a','pcm_s16le',output],{maxOutput:4096});
      await sendFile(res,output,{'content-type':'audio/wav'});
    } catch(error) { res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}})); }
    return;
  }
  const renderMatch = req.method === 'POST' && url.pathname.match(/^\/local\/video\/jobs\/([\w-]+)\/render$/);
  if (renderMatch) {
    await expireVideoJobs();
    const job = videoJobs.get(renderMatch[1]);
    if (!job) { res.writeHead(404, { 'content-type':'application/json' }); res.end('{"error":{"message":"Задача истекла. Загрузите видео ещё раз."}}'); return; }
    try {
      const data = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}');
      const includeOriginal = data.includeOriginal !== false;
      const includeTranslation = data.includeTranslation !== false;
      const includeSubtitles = includeOriginal || includeTranslation;
      const subtitleSegments = Array.isArray(data.subtitleSegments) ? data.subtitleSegments : [];
      if (includeSubtitles && (!subtitleSegments.length || subtitleSegments.length > 2000)) throw new Error('Не переданы корректные сегменты субтитров.');
      const output = join(job.dir, 'forma-translated.mp4');
      let outputDuration = job.duration;
      let videoTail = '';
      let speechTempo = 1;
      const escapeFilterPath = path => path.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
      const rawSubtitleTimes = subtitleSegments.flatMap(segment => [Number(segment.start), Number(segment.end)]).filter(Number.isFinite);
      const maxSubtitleTime = rawSubtitleTimes.length ? Math.max(...rawSubtitleTimes) : 0;
      const timestampsAreMilliseconds = maxSubtitleTime > job.duration * 10;
      const normalizeTime = value => { const seconds = (Number(value) || 0) / (timestampsAreMilliseconds ? 1000 : 1); return Math.max(0, Math.min(job.duration, seconds)); };
      const assTime = seconds => { const totalCs = Math.round(Math.max(0, Math.min(job.duration, Number(seconds) || 0)) * 100); const h = Math.floor(totalCs / 360000); const m = Math.floor(totalCs % 360000 / 6000); const sec = Math.floor(totalCs % 6000 / 100); const cs = totalCs % 100; return String(h) + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0') + '.' + String(cs).padStart(2,'0'); };
      const assText = value => String(value || '').replace(/\\/g,'\\\\').replace(/\r\n?|\n/g,'\\N').replace(/{/g,'\\{').replace(/}/g,'\\}');
      const bothSubtitleLanguages = includeOriginal && includeTranslation;
      const frameWidth = job.width || 1920;
      const frameHeight = job.height || 1080;
      const dimensionScale = frameHeight / 1080;
      const requestedSizes = data.subtitleSizes || {};
      const safeSize = (value, fallback) => Math.max(8, Math.min(120, Math.round(Number(value) || fallback)));
      const russianSubtitleSize = Math.max(8, Math.round((bothSubtitleLanguages ? safeSize(requestedSizes.dualRussian, 54) : 54) * dimensionScale));
      const chineseSubtitleSize = Math.max(8, Math.round((bothSubtitleLanguages ? safeSize(requestedSizes.dualChinese, 86) : 94) * dimensionScale));
      const originalSize = data.sourceLanguage === 'zho' ? chineseSubtitleSize : data.sourceLanguage === 'rus' ? russianSubtitleSize : (bothSubtitleLanguages ? 22 : 26);
      const translatedSize = data.language === 'rus' ? russianSubtitleSize : data.language === 'zho' ? chineseSubtitleSize : (bothSubtitleLanguages ? 22 : 26);
      let subtitleFilter = '';
      if (includeSubtitles) {
        const subtitleFile = join(job.dir, 'subtitles-burned.ass');
        const horizontalMargin = Math.round(frameWidth * 0.06);
        const style = (name, size, marginV) => 'Style: ' + name + ',Arial,' + size + ',&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,' + horizontalMargin + ',' + horizontalMargin + ',' + marginV + ',1';
        const wrapSubtitle = (value, size, language) => {
          const maxWidth = frameWidth - horizontalMargin * 2;
          const chars = Array.from(String(value || '').replace(/\r\n?/g, '\n'));
          const lines = [];
          let line = '', width = 0;
          const charWidth = char => /[\u2E80-\u9FFF\uF900-\uFAFF]/u.test(char) ? size : /\s/u.test(char) ? size * 0.3 : size * 0.56;
          for (const paragraph of chars.join('').split('\n')) {
            const words = language === 'rus' ? paragraph.split(/(\s+)/u) : Array.from(paragraph);
            for (const word of words) {
              const wordWidth = Array.from(word).reduce((sum, char) => sum + charWidth(char), 0);
              if (line && width + wordWidth > maxWidth) { lines.push(line.trimEnd()); line = ''; width = 0; }
              if (wordWidth > maxWidth && language === 'rus') {
                for (const char of Array.from(word)) {
                  const w = charWidth(char);
                  if (line && width + w > maxWidth) { lines.push(line.trimEnd()); line = ''; width = 0; }
                  line += char; width += w;
                }
              } else { line += word; width += wordWidth; }
            }
            if (line) lines.push(line.trimEnd());
            line = ''; width = 0;
          }
          return lines.join('\n');
        };
        const originalMargin = Math.max(2, Math.round(frameHeight * (bothSubtitleLanguages ? 140 : 54) / 1080));
        const translatedMargin = Math.max(2, Math.round(frameHeight * 54 / 1080));
        const events = [];
        for (const segment of subtitleSegments) {
          const startSeconds = normalizeTime(segment.start), endSeconds = normalizeTime(segment.end);
          if (startSeconds >= job.duration || endSeconds <= startSeconds) continue;
          const start = assTime(startSeconds), end = assTime(endSeconds);
          if (includeTranslation && segment.translation) events.push('Dialogue: 0,' + start + ',' + end + ',Translation,,0,0,0,,' + assText(wrapSubtitle(segment.translation, translatedSize, data.language)));
          if (includeOriginal && segment.original) events.push('Dialogue: 0,' + start + ',' + end + ',Original,,0,0,0,,' + assText(wrapSubtitle(segment.original, originalSize, data.sourceLanguage)));
        }
        const ass = '[Script Info]\nScriptType: v4.00+\nPlayResX: ' + frameWidth + '\nPlayResY: ' + frameHeight + '\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' + style('Original', originalSize, originalMargin) + '\n' + style('Translation', translatedSize, translatedMargin) + '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' + events.join('\n') + '\n';
        await writeFile(subtitleFile, ass, 'utf8');
        subtitleFilter = 'ass=filename=\'' + escapeFilterPath(subtitleFile) + '\'';
      }
      const args = ['-y','-i',job.input];
      if (data.audioBase64) {
        const audio = join(job.dir, 'translated.mp3');
        await writeFile(audio, Buffer.from(data.audioBase64, 'base64'));
        const speechProbe = await run(ffprobePath, ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',audio], { maxOutput:4096 });
        const speechDuration = Number(speechProbe.stdout.toString('utf8').trim());
        if (!Number.isFinite(speechDuration) || speechDuration <= 0) throw new Error('Не удалось определить длительность переводной озвучки.');
        speechTempo = Math.min(1.2, Math.max(1, speechDuration / job.duration));
        const adjustedSpeechDuration = speechDuration / speechTempo;
        outputDuration = Math.max(job.duration, adjustedSpeechDuration);
        if (outputDuration > job.duration + 0.05) videoTail = `,tpad=stop_mode=clone:stop_duration=${(outputDuration - job.duration).toFixed(3)}`;
        args.push('-i', audio);
        if (data.preserveBackground && job.background) args.push('-i', job.background);
        if (data.preserveBackground && job.background) {
          const volume=Math.max(0,Math.min(1,Number(data.backgroundVolume)||0));
          args.push('-filter_complex',`[1:a]atempo=${speechTempo.toFixed(3)},aresample=48000[dub];[2:a]volume=${volume},aresample=48000[bg];[bg][dub]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=250:makeup=1[ducked];[dub][ducked]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${outputDuration.toFixed(3)}[mix]`,'-map','0:v:0','-map','[mix]');
        } else args.push('-map','0:v:0','-map','1:a:0','-af',`atempo=${speechTempo.toFixed(3)},apad=whole_dur=${outputDuration.toFixed(3)}`);
      } else {
        args.push('-map','0:v:0','-map','0:a?');
      }
      if (subtitleFilter || videoTail) args.push('-vf','setpts=PTS-STARTPTS' + videoTail + (subtitleFilter ? ',' + subtitleFilter : ''));
      args.push('-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k');
      args.push('-t',outputDuration.toFixed(3),'-movflags','+faststart',output);
      await run(ffmpegPath, args, { maxOutput:4096 });
      const outputInfo = await stat(output);
      if (outputInfo.size > 500 * 1024 * 1024) throw new Error('Полученный видеофайл превышает лимит 500 МБ.');
      await sendFile(res, output, { 'content-type':'video/mp4', 'content-disposition':'attachment; filename="forma-translated.mp4"' });
    } catch (error) {
      res.writeHead(400, { 'content-type':'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify({ error:{ message:error.message } }));
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/local/key') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body || '{}');
      apiKey = typeof data.key === 'string' ? data.key.trim() : '';
      res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify({ connected: Boolean(apiKey) }));
    } catch { res.writeHead(400); res.end('Invalid JSON'); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/local/status') {
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end(JSON.stringify({ connected: Boolean(apiKey) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/local/clear') {
    apiKey = '';
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end('{"connected":false}');
    return;
  }
  // OpenAI direct (the user's own key and balance): the director's pass that writes clip prompts.
  // The key lives only in this process, like the others.
  if (url.pathname === '/local/openai' && req.method === 'GET') {
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end(JSON.stringify({ connected: Boolean(oaKey), models: oaModels, imageModels: oaImageModels }));
    return;
  }
  if (url.pathname === '/local/openai' && (req.method === 'POST' || req.method === 'DELETE')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let key = '';
    try { key = req.method === 'POST' ? String(JSON.parse(body || '{}').key || '').trim() : ''; } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    let models = [], imageModels = [];
    if (key) {
      // The model list: free, and it proves the key.
      try {
        const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) { const detail = (await r.text()).slice(0, 300); res.writeHead(400, { 'content-type':'application/json' }); res.end(JSON.stringify({ connected: Boolean(oaKey), error: { message: `OpenAI не принял ключ (HTTP ${r.status}): ${detail}` } })); return; }
        const ids = ((await r.json()).data || []).map(m => m.id);
        models = ids.filter(id => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|instruct)/.test(id)).sort();
        imageModels = ids.filter(id => /^(gpt-image|chatgpt-image|dall-e-3)/.test(id)).sort();
      } catch (err) { res.writeHead(400, { 'content-type':'application/json' }); res.end(JSON.stringify({ connected: Boolean(oaKey), error: { message: 'Не удалось связаться с OpenAI: ' + err.message } })); return; }
    }
    oaKey = key; oaModels = key ? models : []; oaImageModels = key ? imageModels : [];
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end(JSON.stringify({ connected: Boolean(oaKey), models: oaModels, imageModels: oaImageModels }));
    return;
  }
  // GPT Image: a picture from text, or from reference pictures (page drawing, portraits) — the images
  // «edits» endpoint takes several input images. Answer: OpenAI's JSON with base64 pictures.
  if (url.pathname === '/local/openai/images' && req.method === 'POST') {
    if (!oaKey) { res.writeHead(401, { 'content-type':'application/json' }); res.end('{"error":{"message":"Сначала добавьте ключ OpenAI."}}'); return; }
    try {
      let raw = ''; for await (const c of req) raw += c;
      const b = JSON.parse(raw || '{}'), images = Array.isArray(b.images) ? b.images.slice(0, 16) : [];
      let upstream;
      if (images.length) {
        const form = new FormData();
        form.append('model', String(b.model)); form.append('prompt', String(b.prompt || ''));
        if (b.size) form.append('size', String(b.size)); if (b.quality) form.append('quality', String(b.quality));
        images.forEach((d, k) => { const m = /^data:([^;]+);base64,(.*)$/s.exec(String(d)); if (m) form.append('image[]', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), `ref-${k}.${m[1].split('/')[1] || 'png'}`); });
        upstream = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${oaKey}` }, body: form, signal: AbortSignal.timeout(300000) });
      } else {
        upstream = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { authorization: `Bearer ${oaKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: b.model, prompt: b.prompt, ...(b.size ? { size: b.size } : {}), ...(b.quality ? { quality: b.quality } : {}) }), signal: AbortSignal.timeout(300000) });
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control':'no-store' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) { res.writeHead(502, { 'content-type':'application/json' }); res.end(JSON.stringify({ error: { message: 'Не удалось связаться с OpenAI: ' + err.message } })); }
    return;
  }  if (url.pathname === '/local/openai/chat' && req.method === 'POST') {
    if (!oaKey) { res.writeHead(401, { 'content-type':'application/json' }); res.end('{"error":{"message":"Сначала добавьте ключ OpenAI."}}'); return; }
    try {
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${oaKey}`, 'content-type': 'application/json' }, body: req, duplex: 'half', signal: AbortSignal.timeout(180000) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control':'no-store' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) { res.writeHead(502, { 'content-type':'application/json' }); res.end(JSON.stringify({ error: { message: 'Не удалось связаться с OpenAI: ' + err.message } })); }
    return;
  }
  // Alibaba Model Studio (Token Plan): images and video straight from the
  // subscription, without OpenRouter. The key lives only in this process.
  if (url.pathname === '/local/alibaba' && req.method === 'GET') {
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end(JSON.stringify({ connected: Boolean(aliKey) }));
    return;
  }
  if (url.pathname === '/local/alibaba' && (req.method === 'POST' || req.method === 'DELETE')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let key = '';
    try { key = req.method === 'POST' ? String(JSON.parse(body || '{}').key || '').trim() : ''; } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    let check = null;
    if (key) {
      // The model list of the OpenAI-compatible endpoint (the one the platform
      // uses with this key): free, nothing is generated.
      try {
        const r = await fetch(`${ALI_BASE}/compatible-mode/v1/models`, { headers: { authorization: `Bearer ${key}` } });
        const detail = r.ok ? '' : (await r.text()).slice(0, 300);
        console.log(`[alibaba] key check: HTTP ${r.status} ${detail}`);
        check = r.status === 401 || r.status === 403 ? { ok: false, message: `Alibaba не принял ключ (HTTP ${r.status}): ${detail}` } : { ok: true };
      } catch (err) { check = { ok: false, message: 'Не удалось связаться с Alibaba: ' + err.message + (err.cause?.code ? ` (${err.cause.code})` : '') }; }
      if (!check.ok) { res.writeHead(400, { 'content-type':'application/json' }); res.end(JSON.stringify({ connected: Boolean(aliKey), error: { message: check.message } })); return; }
    }
    aliKey = key;
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end(JSON.stringify({ connected: Boolean(aliKey) }));
    return;
  }
  if (url.pathname.startsWith('/local/alibaba/api/')) {
    if (!aliKey) { res.writeHead(401, { 'content-type':'application/json' }); res.end('{"error":{"message":"Сначала добавьте ключ Alibaba Model Studio."}}'); return; }
    const path = url.pathname.slice('/local/alibaba/'.length);
    if (!/^api\/v1\/(services\/aigc\/[a-z-]+\/[a-z-]+|tasks\/[\w-]+)$/.test(path)) { res.writeHead(400); res.end('Invalid Alibaba path'); return; }
    const headers = { authorization: `Bearer ${aliKey}`, 'content-type': 'application/json' };
    if (req.headers['x-dashscope-async']) headers['X-DashScope-Async'] = 'enable';
    // The body is read once, so a dropped connection (no answer at all) can be retried: nothing reached
    // Alibaba then, nothing is charged twice. Any answer from Alibaba, even an error, is passed on as is.
    const body = ['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c; })());
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Pictures are made inside this one request and may take minutes: wait up to 10.
        const upstream = await fetch(`${ALI_BASE}/${path}`, { method: req.method, headers, body, signal: AbortSignal.timeout(600000) });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control':'no-store' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      } catch (err) {
        last = err; console.log(`[alibaba] ${path}: attempt ${attempt} failed: ${err.message}${err.cause?.code ? ' (' + err.cause.code + ')' : ''}`);
        // A request that waited too long reached Alibaba and may still be running there: never resend it (it would be paid twice).
        if (err.name === 'TimeoutError' || err.name === 'AbortError') break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    res.writeHead(502, { 'content-type':'application/json' });
    res.end(JSON.stringify({ error:{ message:`Не удалось связаться с Alibaba после 3 попыток: ${last?.message}${last?.cause?.code ? ' (' + last.cause.code + ')' : ''}. Проверьте интернет и повторите.` } }));
    return;
  }
  // Results (images, videos) are temporary Alibaba OSS links; fetched here to avoid browser CORS.
  if (url.pathname === '/local/alibaba/file' && req.method === 'GET') {
    let target;
    try { target = new URL(url.searchParams.get('url') || ''); } catch { res.writeHead(400); res.end('Bad URL'); return; }
    if (target.protocol !== 'https:' || !/\.aliyuncs\.com$/.test(target.hostname)) { res.writeHead(400); res.end('Only Alibaba result links'); return; }
    // The result link is fresh and valid for a day; a failed download is almost always a network blip, so try up to 4 times.
    let last = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const upstream = await fetch(target, { signal: AbortSignal.timeout(60000) });
        if (!upstream.ok) { last = `HTTP ${upstream.status}`; if (upstream.status < 500 && upstream.status !== 429) break; throw new Error(last); }
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream', 'content-length': body.length, 'cache-control':'no-store' });
        res.end(body);
        return;
      } catch (err) {
        last = `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;
        console.log(`[alibaba] download attempt ${attempt} failed: ${last}`);
        if (attempt < 4) await new Promise(r => setTimeout(r, 1200 * attempt));
      }
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(last);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (!apiKey) { res.writeHead(401, { 'content-type':'application/json' }); res.end('{"error":{"message":"Сначала добавьте OpenRouter API key в настройках."}}'); return; }
    const path = url.pathname.slice('/api/'.length);
    if (!/^v1\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes('..')) { res.writeHead(400); res.end('Invalid API path'); return; }
    const headers = { authorization: `Bearer ${apiKey}`, 'content-type': req.headers['content-type'] || 'application/json' };
    for (const name of ['http-referer', 'x-openrouter-title']) if (req.headers[name]) headers[name] = req.headers[name];
    try {
      const upstream = await fetch(`https://openrouter.ai/api/${path}${url.search}`, { method:req.method, headers, body:['GET','HEAD'].includes(req.method) ? undefined : req, ...(['GET','HEAD'].includes(req.method) ? {} : { duplex:'half' }) });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'cache-control':'no-store',
        ...(upstream.headers.get('content-disposition') ? { 'content-disposition': upstream.headers.get('content-disposition') } : {})
      });
      if (!upstream.body) { res.end(); return; }
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (err) {
      res.writeHead(502, { 'content-type':'application/json' });
      const detail = err.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
        ? 'Node.js не доверяет сертификату сайта. Перезапустите сервер командой: node --use-system-ca server.mjs'
        : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;
      res.end(JSON.stringify({ error:{ message:`Не удалось связаться с OpenRouter: ${detail}` } }));
    }
    return;
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const type = mime[extname(file)] || 'application/octet-stream';
    // Byte ranges let the browser stream and seek page videos.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && info.size) {
      let start = range[1] === '' ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : info.size - 1;
      if (start > end || start >= info.size) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); res.end(); return; }
      end = Math.min(end, info.size - 1);
      res.writeHead(206, { 'content-type':type, 'content-length':end - start + 1, 'content-range':`bytes ${start}-${end}/${info.size}`, 'accept-ranges':'bytes', 'cache-control':'no-store' });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type':type, 'content-length':info.size, 'accept-ranges':'bytes', 'cache-control':'no-store' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});

server.listen(port, '127.0.0.1', () => console.log(`Мультимедиа-консоль: http://127.0.0.1:${port}`));


