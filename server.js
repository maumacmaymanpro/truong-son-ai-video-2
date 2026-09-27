import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const JOB_DIR = path.join(DATA_DIR, 'jobs');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 300);
const JOB_RETENTION_HOURS = Number(process.env.JOB_RETENTION_HOURS || 24);
const AI_BG_MAX = Number(process.env.AI_BG_MAX || 6);
const DEMO_MODE = String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true';
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-luna';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

await Promise.all([UPLOAD_DIR, JOB_DIR, OUTPUT_DIR, ASSET_DIR, DATA_DIR].map(d => fsp.mkdir(d, { recursive: true })));

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const jobs = new Map();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^video\//i.test(file.mimetype) || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.originalname);
    cb(ok ? null : new Error('CHỈ_NHẬN_FILE_VIDEO'));
  }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

function now() { return new Date().toISOString(); }
function newId() { return crypto.randomUUID(); }
function safeName(s) {
  return String(s || 'video').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'video';
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function ffFilterPath(p) { return p.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'"); }
function shellError(err, stderr = '') { const e = new Error(`${err?.message || err}\n${stderr}`); e.code = err?.code; return e; }

async function run(cmd, args, opts = {}) {
  return await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('error', e => reject(e));
    p.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(shellError(new Error(`${cmd} exited ${code}`), stderr)));
  });
}

async function ffprobeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error('Không đọc được thời lượng video.');
  return d;
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: now() });
  jobs.set(job.id, job);
  try { fs.writeFileSync(path.join(JOB_DIR, `${job.id}.json`), JSON.stringify(job, null, 2)); } catch {}
}

function publicJob(job) {
  return {
    id: job.id, name: job.originalName, status: job.status, phase: job.phase,
    progress: job.progress, error: job.error || null, duration: job.duration || null,
    transcript: job.transcript || null, sections: job.sections || null,
    title: job.title || '', caption: job.caption || '',
    outputReady: Boolean(job.outputPath),
    downloadUrl: job.outputPath ? `/api/jobs/${job.id}/download` : null,
    previewUrl: job.outputPath ? `/api/jobs/${job.id}/preview` : null,
    createdAt: job.createdAt, updatedAt: job.updatedAt
  };
}

async function createAudio(input, out) {
  await run('ffmpeg', ['-hide_banner','-loglevel','error','-y','-i',input,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',out]);
}

function normalizeTranscription(t) {
  const raw = Array.isArray(t?.segments) ? t.segments : [];
  return raw.map((s, i) => ({
    id: i,
    start: Number(s.start ?? 0),
    end: Number(s.end ?? 0),
    text: String(s.text ?? '').trim()
  })).filter(s => s.end > s.start + 0.03 && s.text);
}

function buildBlocks(segments) {
  const out = [];
  let cur = null;
  for (const s of segments) {
    const sentenceEnd = /[.!?。！？]$/.test(s.text);
    if (!cur) cur = { id: out.length, start: s.start, end: s.end, text: s.text, segmentIds: [s.id] };
    else if ((s.start - cur.start) >= 14 || (cur.end - cur.start) >= 7 && sentenceEnd) {
      out.push(cur);
      cur = { id: out.length, start: s.start, end: s.end, text: s.text, segmentIds: [s.id] };
    } else {
      cur.end = s.end; cur.text += ' ' + s.text; cur.segmentIds.push(s.id);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function demoTranscript(duration) {
  const sample = [
    'Có một điều rất nhiều người chỉ nhận ra khi đã đi được một đoạn đường dài.',
    'Chúng ta thường nghĩ rằng thay đổi lớn phải bắt đầu bằng một quyết định thật lớn.',
    'Nhưng thực tế, nhiều thay đổi bền vững lại bắt đầu từ một việc rất nhỏ.',
    'Khi hiểu rõ mình đang muốn gì, chúng ta sẽ bớt chạy theo điều người khác mong đợi.',
    'Và khi bớt phân tán, năng lượng của mình bắt đầu tập trung hơn.',
    'Đó cũng là lúc chúng ta có thể đi nhanh hơn mà không cần phải vội.'
  ];
  const n = Math.max(1, Math.min(sample.length, Math.ceil(duration / 12)));
  const step = Math.max(5, duration / n);
  return sample.slice(0, n).map((text, i) => ({ id: i, start: +(i*step).toFixed(2), end: +Math.min(duration, (i+1)*step).toFixed(2), text }));
}

async function analyzeContent(blocks, topic, style) {
  if (DEMO_MODE) {
    const keep = blocks.map(b => b.id);
    const groups = [];
    for (let i = 0; i < keep.length; i += 2) {
      const ids = keep.slice(i, i + 2);
      const txt = ids.map(id => blocks[id]?.text || '').join(' ');
      groups.push({
        title: `Ý ${groups.length + 1}`,
        hook: i === 0 ? 'Có một điều nhiều người chỉ nhận ra khi đã đi rất xa.' : 'Điều quan trọng nằm ở một thay đổi rất nhỏ.',
        backgroundPrompt: 'cinematic Vietnamese personal growth, warm golden light, elegant, premium, no text, vertical 9:16',
        keepIds: ids, reason: 'Giữ vì chứa ý chính liên tiếp.'
      });
    }
    return { title: topic?.trim() || 'Một điều đáng biết trước khi bạn bắt đầu', caption: 'Chia sẻ kiến thức theo góc nhìn cá nhân. Nội dung mang tính tham khảo.', sections: groups };
  }
  const compact = blocks.map(b => ({ id: b.id, start: +b.start.toFixed(2), end: +b.end.toFixed(2), text: b.text })).slice(0, 180);
  const system = `Bạn là biên tập viên video short-form tiếng Việt. Nhiệm vụ: đọc transcript có timestamp, hiểu ý, loại phần lặp/lan man, nhưng không cắt mất ý quan trọng. Tạo các section liên tục theo mạch nội dung. Mỗi section gồm các block id cần giữ, một hook riêng để giữ chân người xem, và prompt background phù hợp bối cảnh. Không bịa nội dung ngoài transcript. Ưu tiên câu tự nhiên, ngắn, không giật gân quá mức. Phong cách: ${style}. Chủ đề người dùng: ${topic || '(chưa chỉ định)'}.

Chỉ trả về JSON hợp lệ, không markdown, theo schema: {title:string, caption:string, sections:[{title:string,hook:string,backgroundPrompt:string,keepIds:number[],reason:string}]}.
Quy tắc: sections 1-6; keepIds phải dùng các id có trong dữ liệu; mỗi id chỉ xuất hiện tối đa một section; ưu tiên 60-90% nội dung hữu ích; không giữ các block chỉ là từ đệm/lặp; hook không quá 18 từ.`;
  const response = await openai.responses.create({ model: OPENAI_TEXT_MODEL, input: [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(compact) }
  ] });
  const raw = String(response.output_text || '').trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sections)) throw new Error('AI phân tích không trả về sections hợp lệ.');
  return parsed;
}

function hexToASS(hex, alpha = '00') {
  const m = String(hex || '').replace('#','').match(/^([0-9a-f]{6})$/i);
  if (!m) return '&H00FFFFFF';
  const h = m[1]; const r = h.slice(0,2), g = h.slice(2,4), b = h.slice(4,6);
  return `&H${alpha}${b}${g}${r}`;
}
function assEscape(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N'); }
function assTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = sec%60;
  return `${h}:${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;
}

async function writeASS(file, cues, settings) {
  const font = settings.fontFamily || 'Arial';
  const size = clamp(Number(settings.fontSize) || 52, 24, 96);
  const primary = hexToASS(settings.color || '#FFFFFF');
  const outline = hexToASS(settings.outlineColor || '#06131A');
  const pos = settings.position === 'top' ? 8 : settings.position === 'center' ? 5 : 2;
  const marginV = settings.position === 'top' ? 90 : settings.position === 'center' ? 0 : 120;
  const outlineW = clamp(Number(settings.outlineWidth) || 3, 0, 8);
  let lines = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${size},${primary},${primary},${outline},&H99000000,-1,0,0,0,100,100,0,0,1,${outlineW},1,${pos},60,60,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  for (const cue of cues) {
    lines += `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assEscape(cue.text)}\n`;
  }
  await fsp.writeFile(file, lines, 'utf8');
}

async function gradientBackground(out, index = 0) {
  const pairs = [
    ['#081a26','#173c4a'], ['#1c1028','#3d1f54'], ['#19200f','#405128'],
    ['#24150f','#5b2a1d'], ['#0b152b','#24496e'], ['#191919','#554d3a']
  ];
  const [a,b] = pairs[index % pairs.length];
  await run('convert', ['-size','1080x1920',`gradient:${a}-${b}`,'-blur','0x2','-quality','88',out]);
  return out;
}

async function aiBackground(prompt, out) {
  if (DEMO_MODE || !openai) return false;
  const result = await openai.images.generate({ model: OPENAI_IMAGE_MODEL, prompt: `${prompt}. Vertical 9:16 cinematic background for an educational social video. No text, no logos, no watermark, clean composition, leave some darker negative space for subtitles.`, size: '1024x1536' });
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) return false;
  await fsp.writeFile(out, Buffer.from(b64, 'base64'));
  return true;
}

async function makeHookVideo(bgPath, hookText, outPath) {
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const filter = [
    `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`,
    `drawbox=x=55:y=130:w=970:h=1660:color=black@0.24:t=fill`,
    `drawtext=fontfile=${ffFilterPath(font)}:text='TRƯỜNG SƠN AI VIDEO':fontcolor=white@0.82:fontsize=30:x=60:y=90`,
    `drawtext=fontfile=${ffFilterPath(font)}:text='${String(hookText).replaceAll("'", "\\'").replaceAll(':','\\:').replaceAll('%','\\%')}':fontcolor=white:fontsize=62:line_spacing=14:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.28:boxborderw=28`,
    `fade=t=in:st=0:d=0.18,fade=t=out:st=1.85:d=0.25`
  ].join(',');
  await run('ffmpeg', ['-hide_banner','-loglevel','error','-y','-loop','1','-i',bgPath,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t','2.1','-vf',filter,'-r','30','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-shortest',outPath]);
}

function mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a,b)=>a[0]-b[0]);
  const out=[];
  for (const x of sorted) {
    if (!out.length || x[0]-out[out.length-1][1] > 0.28) out.push(x.slice());
    else out[out.length-1][1] = Math.max(out[out.length-1][1], x[1]);
  }
  return out;
}

async function renderSection(input, section, allBlocks, opts, sectionIndex, jobDir) {
  const selected = allBlocks.filter(b => section.keepIds.includes(b.id) && b.keep !== false);
  if (!selected.length) return null;
  const intervals = mergeIntervals(selected.map(b=>[b.start,b.end]));
  const contentDuration = intervals.reduce((n,x)=>n+x[1]-x[0],0);
  if (contentDuration < 0.6) return null;

  const bgPath = path.join(jobDir, `bg-${sectionIndex}.png`);
  let hasBg = false;
  if (opts.backgroundMode === 'ai' && sectionIndex < AI_BG_MAX) {
    try { hasBg = await aiBackground(section.backgroundPrompt || 'cinematic premium contextual background', bgPath); } catch (e) { /* fallback below */ }
  }
  if (!hasBg) await gradientBackground(bgPath, sectionIndex);

  const assPath = path.join(jobDir, `sub-${sectionIndex}.ass`);
  const cues=[];
  let offset=0;
  for (const interval of intervals) {
    for (const b of selected) {
      const start = Math.max(interval[0], b.start), end = Math.min(interval[1], b.end);
      if (end <= start + 0.05) continue;
      const txt = b.subtitleText || b.text;
      cues.push({ start: offset + (start-interval[0]), end: offset + (end-interval[0]), text: txt });
    }
    offset += interval[1]-interval[0];
  }
  await writeASS(assPath, cues, opts.subtitle);

  const contentPath = path.join(jobDir, `content-${sectionIndex}.mp4`);
  const partsV=[], partsA=[];
  intervals.forEach((r,i)=>{
    partsV.push(`[0:v]trim=start=${r[0].toFixed(3)}:end=${r[1].toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    partsA.push(`[0:a]atrim=start=${r[0].toFixed(3)}:end=${r[1].toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
  });
  const vconcat = intervals.map((_,i)=>`[v${i}]`).join('');
  const aconcat = intervals.map((_,i)=>`[a${i}]`).join('');
  const bgf='[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=18:2[bg]';
  const fg='[vc]scale=980:1740:force_original_aspect_ratio=decrease,pad=980:1740:(ow-iw)/2:(oh-ih)/2:color=black@0.12[fg]';
  const filter = `${partsV.join(';')};${partsA.join(';')};${vconcat}concat=n=${intervals.length}:v=1:a=0[vc0];${aconcat}concat=n=${intervals.length}:v=0:a=1[ac];${bgf.replace('[vc]','[vc0]')};${fg.replace('[vc]','[vc0]')};[bg][fg]overlay=x=50:y=90:shortest=1,ass='${ffFilterPath(assPath)}'[vout]`;
  await run('ffmpeg', ['-hide_banner','-loglevel','error','-y','-i',input,'-loop','1','-i',bgPath,'-filter_complex',filter,'-map','[vout]','-map','[ac]','-r','30','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest',contentPath]);

  const hookPath = path.join(jobDir, `hook-${sectionIndex}.mp4`);
  await makeHookVideo(bgPath, section.hook || section.title || 'Một điều đáng biết', hookPath);

  const sectionList = path.join(jobDir, `concat-${sectionIndex}.txt`);
  await fsp.writeFile(sectionList, [`file '${hookPath.replaceAll("'", "'\\''")}'`,`file '${contentPath.replaceAll("'", "'\\''")}'`].join('\n'));
  const sectionOut = path.join(jobDir, `section-${sectionIndex}.mp4`);
  await run('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',sectionList,'-c','copy',sectionOut]);
  return sectionOut;
}

async function renderFinal(job, plan) {
  const input = job.inputPath;
  const workDir = path.join(DATA_DIR, `work-${job.id}`);
  await fsp.mkdir(workDir, { recursive: true });
  try {
    const allBlocks = (job.blocks || []).map(b => ({ ...b }));
    const keepMap = new Map((plan?.blocks || []).map(b => [Number(b.id), b]));
    for (const b of allBlocks) {
      const edited = keepMap.get(b.id);
      if (edited) { b.keep = edited.keep !== false; b.subtitleText = String(edited.text ?? b.text); }
    }
    const opts = {
      backgroundMode: ['ai','gradient','none'].includes(plan?.backgroundMode) ? plan.backgroundMode : 'ai',
      subtitle: {
        fontFamily: plan?.subtitle?.fontFamily || 'Arial',
        fontSize: plan?.subtitle?.fontSize || 52,
        color: plan?.subtitle?.color || '#FFFFFF',
        outlineColor: plan?.subtitle?.outlineColor || '#06131A',
        outlineWidth: plan?.subtitle?.outlineWidth || 3,
        position: plan?.subtitle?.position || 'bottom'
      }
    };
    const sections=[];
    for (let i=0; i<(plan.sections || []).length; i++) {
      const s={...plan.sections[i], keepIds:(plan.sections[i].keepIds||[]).map(Number)};
      update(job,{phase:`Dựng đoạn ${i+1}/${plan.sections.length}`,progress:48 + Math.round((i/Math.max(1,plan.sections.length))*40)});
      const rendered = await renderSection(input,s,allBlocks,opts,i,workDir);
      if (rendered) sections.push(rendered);
    }
    if (!sections.length) throw new Error('Không còn đoạn nào được giữ. Hãy chọn ít nhất một đoạn.');
    const list = path.join(workDir,'final-list.txt');
    await fsp.writeFile(list, sections.map(p=>`file '${p.replaceAll("'", "'\\''")}'`).join('\n'));
    const concatOut = path.join(workDir,'concat.mp4');
    await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-c','copy',concatOut]);
    const outputPath = path.join(OUTPUT_DIR, `${safeName(job.originalName).replace(/\.[^.]+$/,'')}-TS-AI-${Date.now()}.mp4`);
    update(job,{phase:'Đóng gói MP4',progress:95});
    await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',concatOut,'-c','copy','-movflags','+faststart',outputPath]);
    return outputPath;
  } finally {
    await fsp.rm(workDir,{recursive:true,force:true});
  }
}

async function analyzeJob(job) {
  try {
    update(job,{status:'processing',phase:'Đọc video',progress:5});
    job.duration = await ffprobeDuration(job.inputPath);
    update(job,{phase:'Tách âm thanh',progress:12});
    const audio = path.join(DATA_DIR, `audio-${job.id}.wav`);
    await createAudio(job.inputPath,audio);
    let transcript;
    if (DEMO_MODE) {
      transcript = { text: demoTranscript(job.duration).map(x=>x.text).join(' '), segments: demoTranscript(job.duration) };
    } else if (openai) {

      update(job,{phase:'AI nghe và nhận dạng lời thoại',progress:22});
      const t = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audio),
        model: OPENAI_TRANSCRIBE_MODEL,
        language: 'vi',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment']
      });
      transcript = t;
    } else {
      throw new Error('OPENAI_API_KEY chưa được cấu hình. Hãy điền khóa API hoặc bật DEMO_MODE=true để thử giao diện.');
    }
    const segments = normalizeTranscription(transcript);
    if (!segments.length) throw new Error('Không nhận được lời thoại. Hãy kiểm tra video có tiếng nói rõ hay không.');
    job.transcript = { text: segments.map(s=>s.text).join(' '), segments };
    update(job,{phase:'AI hiểu nội dung và chọn đoạn',progress:38});
    const blocks = buildBlocks(segments);
    job.blocks = blocks;
    const analysis = await analyzeContent(blocks, job.topic || '', job.style || 'natural');
    job.sections = analysis.sections.map((s,idx)=>({ ...s, id:idx, keepIds:(s.keepIds||[]).map(Number) }));
    job.title = analysis.title || job.originalName.replace(/\.[^.]+$/,'');
    job.caption = analysis.caption || '';
    update(job,{status:'analysis_ready',phase:'Đã phân tích xong',progress:45});
    await fsp.rm(audio,{force:true});
  } catch (e) {
    update(job,{status:'error',phase:'Lỗi phân tích',progress:100,error:e?.message || String(e)});
  }
}

async function renderJob(job, plan) {
  try {
    update(job,{status:'rendering',phase:'Bắt đầu dựng video',progress:47});
    job.outputPath = await renderFinal(job, plan);
    update(job,{status:'completed',phase:'Hoàn thành',progress:100});
  } catch (e) {
    update(job,{status:'error',phase:'Lỗi render',progress:100,error:e?.message || String(e)});
  }
}

app.get('/api/health', (_req,res)=>res.json({ok:true, demoMode:DEMO_MODE, openaiConfigured:Boolean(openai), textModel:OPENAI_TEXT_MODEL, transcribeModel:OPENAI_TRANSCRIBE_MODEL, imageModel:OPENAI_IMAGE_MODEL, ffmpeg:true}));

app.post('/api/jobs', upload.single('video'), (req,res)=>{
  if (!req.file) return res.status(400).json({error:'Chưa nhận được video.'});
  const id = newId();
  const job = {
    id, originalName:req.file.originalname, inputPath:req.file.path, topic:String(req.body.topic||''), style:String(req.body.style||'natural'),
    status:'queued',phase:'Đã nhận video',progress:1,createdAt:now(),updatedAt:now()
  };
  jobs.set(id,job); update(job,{});
  void analyzeJob(job);
  res.json(publicJob(job));
});

app.get('/api/jobs/:id',(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:'Không tìm thấy phiên xử lý.'});
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/render',(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:'Không tìm thấy phiên xử lý.'});
  if(job.status!=='analysis_ready') return res.status(409).json({error:`Chưa thể render ở trạng thái ${job.status}.`});
  const plan=req.body?.plan;
  if(!plan || !Array.isArray(plan.sections) || !plan.sections.length) return res.status(400).json({error:'Thiếu danh sách section.'});
  void renderJob(job,plan);
  res.json({ok:true});
});

app.get('/api/jobs/:id/download',(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job?.outputPath) return res.status(404).send('Video chưa sẵn sàng.');
  if(!fs.existsSync(job.outputPath)) return res.status(404).send('File video không còn tồn tại.');
  const name = `${safeName(job.originalName).replace(/\.[^.]+$/,'')}-Truong-Son-AI.mp4`;
  res.download(job.outputPath,name,{maxAge:0},err=>{ if(err && !res.headersSent) res.status(500).send('Không thể tải file.'); });
});
app.get('/api/jobs/:id/preview',(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job?.outputPath || !fs.existsSync(job.outputPath)) return res.status(404).end();
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Accept-Ranges','bytes');
  const stat=fs.statSync(job.outputPath); const range=req.headers.range;
  if(!range) return fs.createReadStream(job.outputPath).pipe(res);
  const [s,e]=range.replace('bytes=','').split('-'); const start=Number(s); const end=e?Number(e):stat.size-1;
  res.status(206).set({ 'Content-Range':`bytes ${start}-${end}/${stat.size}`, 'Content-Length':String(end-start+1) });
  fs.createReadStream(job.outputPath,{start,end}).pipe(res);
});

app.use((err,_req,res,_next)=>{
  const msg=err?.code==='LIMIT_FILE_SIZE' ? `Video quá lớn. Giới hạn hiện tại ${MAX_UPLOAD_MB} MB.` : (err?.message||'Lỗi máy chủ.');
  res.status(400).json({error:msg});
});

// Cleanup stale local jobs/files. This does not interrupt active jobs.
setInterval(async()=>{
  const cutoff=Date.now()-JOB_RETENTION_HOURS*3600*1000;
  for(const [id,job] of jobs){
    if(new Date(job.createdAt).getTime()<cutoff && !['processing','rendering','queued'].includes(job.status)){
      try{await fsp.rm(job.inputPath,{force:true});}catch{}
      try{if(job.outputPath)await fsp.rm(job.outputPath,{force:true});}catch{}
      jobs.delete(id);
      try{await fsp.rm(path.join(JOB_DIR,`${id}.json`),{force:true});}catch{}
    }
  }
}, 30*60*1000).unref();

app.listen(PORT,()=>console.log(`Truong Son AI Video 2.0 running on http://localhost:${PORT} | demo=${DEMO_MODE} | openai=${Boolean(openai)}`));
