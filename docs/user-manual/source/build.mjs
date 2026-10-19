// Builds ../user-manual-ar.pdf from parts/*.html: joins the parts into manual.html (table of contents and index
// made from the headings), prints it with Microsoft Edge (headless, DevTools printToPDF) and runs it twice, so the
// page numbers in the contents and the index are the real ones; postpdf.py then adds bookmarks and metadata.
//   node docs/user-manual/source/build.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_PDF = path.resolve(HERE, '../user-manual-ar.pdf');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));

// ------------------------------------------------------------------ index: [term, anchor]
const INDEX = [
  ['إبرة (اختيار)', 'c8-1'], ['إبرة 3 (ليزر)', 'c8-5'], ['إحصاءات', 'c10-1'], ['اختصارات لوحة المفاتيح', 'c15'],
  ['أداة التحديد', 'c6-1'], ['أداة التحديد المباشر', 'c6-1'], ['أداة القياس', 'c6-9'], ['إدراج رسمة', 'c5-3'],
  ['إدراج أمر في البرنامج', 'c10-2'], ['إزالة البرنامج', 'c2-5'], ['أجزاء (زجزاج، رجوع، طول خاص)', 'c6-5'],
  ['إضافة شكل', 'c6-7'], ['إعدادات الماكينة', 'c8-3'], ['الإعدادات', 'c13'], ['أوامر افتراضية', 'c10-3'],
  ['تثبيت', 'c2-2'], ['تحريك', 'c6-3'], ['تدوير', 'c6-3'], ['تراجع وإعادة', 'c11-4'], ['ترتيب تلقائي', 'c9-2'],
  ['ترتيب الخياطة', 'c9-1'], ['تسريع مسارات الليزر', 'c8-6'], ['تصدير', 'c10-5'], ['تعديل النقاط', 'c6-4'],
  ['تعويض الخلوص', 'c8-3'], ['تغيير الحجم', 'c6-3'], ['تنظيف الرسمة', 'c6-6'], ['حافظة (نسخ ولصق)', 'c6-8'],
  ['حذف طبقة', 'c7-2'], ['حركات الانتقال', 'c9-2'], ['حفظ تلقائي', 'c11-4'], ['حفظ الشغلانة', 'c11-2'],
  ['حفظ ملف الماكينة', 'c10-6'], ['الخطوة التالية والسابقة', 'c3-2'], ['دقة PLT (dpi)', 'c5-5'], ['رجوع (تقفيل)', 'c8-2'],
  ['زوايا', 'c8-2'], ['سرعة الخياطة', 'c10-3'], ['سمة فاتحة وداكنة', 'c13-3'], ['شبكة الرسمة', 'c13-4'],
  ['شريط الخطوات', 'c3-2'], ['شغلانة جديدة', 'c5-1'], ['الصفحة الرئيسية', 'c3-1'], ['صيغ الملفات', 'c5-2'],
  ['طاولة الماكينة', 'c5-7'], ['طبقة جديدة', 'c7-3'], ['الطبقات', 'c7'], ['طول الغرزة', 'c8-1'],
  ['عكس الاتجاه', 'c6-4'], ['عكس (مرآة)', 'c6-3'], ['فتح ملف', 'c5-2'], ['فلاشة USB', 'c10-6'],
  ['قائمة مختصرة', 'c6-8'], ['قص ليزر', 'c8-5'], ['لغة الواجهة', 'c13-2'], ['ليزر بطيء', 'c8-6'],
  ['محاكاة', 'c9-3'], ['مخرج IO', 'c10-3'], ['مشكلات معروفة', 'c16-4'], ['مقياس الرسمة', 'c5-6'],
  ['ملفات أخيرة', 'c3-1'], ['نسخ الأشكال', 'c6-5'], ['نسخ إعدادات الغرز', 'c8-4'], ['نقطة أصل الماكينة', 'c8-3'],
  ['نقطة البداية', 'c6-4'], ['نقطة مرجعية', 'c6-5'], ['البحث عن أداة', 'c14'], ['أشكال مغلقة', 'c8-2'],
  ['تحديد بالمستطيل', 'c6-1'], ['حجم الواجهة', 'c13-4'], ['الخط وحجم النص', 'c13-3'], ['سؤال حفظ التعديلات', 'c11-3'],
];

// ------------------------------------------------------------------ assemble
function assemble(pages = {}) {
  let html = fs.readdirSync(path.join(HERE, 'parts')).filter(f => f.endsWith('.html')).sort()
    .map(f => fs.readFileSync(path.join(HERE, 'parts', f), 'utf8')).join('\n');
  const pg = id => pages[id] ?? '00';
  // contents: chapters and sections from the headings
  const toc = [];
  for (const m of html.matchAll(/<h([12])[^>]*\bid="([^"]+)"[^>]*>(.*?)<\/h\1>/gs)) {
    const [, lvl, id, inner] = m;
    const n = (inner.match(/<span class="n">(.*?)<\/span>/) || [])[1] || '';
    const text = inner.replace(/<span class="n">.*?<\/span>/, '').replace(/<[^>]+>/g, '').trim();
    toc.push(`<li class="l${lvl}"><span class="tn">${n}</span><a href="#${id}">${text}</a><span class="dots"></span><a class="pg" href="#${id}">${pg(id)}</a></li>`);
  }
  html = html.replace('<ol id="tocList"></ol>', `<ol id="tocList">${toc.join('\n')}</ol>`);
  html = html.replace('<section class="toc">', '<section class="toc" id="toc">');
  // a key combination (Ctrl+S) is one left-to-right unit inside the Arabic text
  html = html.replace(/<kbd>[^<]*<\/kbd>(?:\s*(?:\+|\/|…)\s*<kbd>[^<]*<\/kbd>)+/g, m => `<span class="kc" dir="ltr">${m}</span>`);
  // index, grouped by first letter (alef forms together)
  const key = t => t.replace(/^ال/, '').replace(/^[أإآ]/, 'ا');
  const sorted = [...INDEX].sort((a, b) => key(a[0]).localeCompare(key(b[0]), 'ar'));
  let idx = '', cur = '';
  for (const [t, id] of sorted) {
    const L = key(t)[0];
    if (L !== cur) { cur = L; idx += `<h4>${L}</h4>`; }
    idx += `<div><a href="#${id}">${t}</a><span class="dots"></span><a class="pg" href="#${id}">${pg(id)}</a></div>`;
  }
  html = html.replace('<div class="idx" id="idx"></div>', `<div class="idx" id="idx">${idx}</div>`);
  const file = path.join(HERE, 'manual.html');
  fs.writeFileSync(file, html);
  return file;
}

// ------------------------------------------------------------------ print with Edge
const FOOT = `<div style="width:100%; font-family:'Segoe UI', Tahoma, sans-serif; font-size:8.5pt; color:#78716c; direction:rtl;
  padding:0 18mm; display:flex; justify-content:space-between; align-items:center;">
  <span>ستيتشلاين · دليل المستخدم</span>
  <span style="font-family:'Segoe UI'; color:#1c1917; font-weight:600; border-top:1.5pt solid #e8336d; padding-top:1mm; min-width:9mm; text-align:center;"><span class="pageNumber"></span></span></div>`;
const HEAD = `<div style="width:100%; padding:0 18mm; direction:rtl; font-size:7pt;"><div style="border-bottom:.8pt dashed #e7e5e4; height:1px;"></div></div>`;

async function print(htmlFile, pdfFile, plain = false) {
  const port = 9441;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'slpdf-'));
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.length) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  const pg = list.find(p => p.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map(); const events = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m.method); };
  await new Promise(r => (ws.onopen = r));
  const send = (method, params = {}) => new Promise(r => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(htmlFile).href });
  for (let i = 0; i < 120 && !events.includes('Page.loadEventFired'); i++) await new Promise(r => setTimeout(r, 250));
  await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true });
  await new Promise(r => setTimeout(r, 800));
  const r = await send('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true, displayHeaderFooter: !plain, headerTemplate: HEAD, footerTemplate: FOOT,
    generateTaggedPDF: true, generateDocumentOutline: true,
  });
  if (!r.result) throw new Error(JSON.stringify(r.error));
  fs.writeFileSync(pdfFile, Buffer.from(r.result.data, 'base64'));
  ws.close(); edge.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}

const tmp1 = path.join(os.tmpdir(), 'sl-manual-pass1.pdf');
await print(assemble(), tmp1);
// where each heading landed: postpdf.py reads the internal links of pass 1
const pages = JSON.parse(execFileSync('python', [path.join(HERE, 'postpdf.py'), 'pages', tmp1], { encoding: 'utf8' }));
const tmp2 = path.join(os.tmpdir(), 'sl-manual-pass2.pdf');
await print(assemble(pages), tmp2);
const pages2 = JSON.parse(execFileSync('python', [path.join(HERE, 'postpdf.py'), 'pages', tmp2], { encoding: 'utf8' }));
const moved = Object.keys(pages).filter(k => pages[k] !== pages2[k]);
if (moved.length) { console.log('page numbers moved in pass 2, running a third pass:', moved.join(' ')); await print(assemble(pages2), tmp2); }
// the cover: printed on its own, full bleed and without the running footer, then put in place of page 1
const front = fs.readFileSync(path.join(HERE, 'parts', '00-front.html'), 'utf8');
const coverHtml = front.slice(0, front.indexOf('<!-- ================================================================ table of contents'))
  .replace('</head>', '<style>@page { size: A4; margin: 0 } .cover { break-after: auto; }</style></head>') + '</body></html>';
const coverFile = path.join(HERE, 'cover.html');
fs.writeFileSync(coverFile, coverHtml);
const tmpc = path.join(os.tmpdir(), 'sl-manual-cover.pdf');
await print(coverFile, tmpc, true);
execFileSync('python', [path.join(HERE, 'postpdf.py'), 'finish', tmp2, OUT_PDF, path.join(HERE, 'manual.html'), tmpc], { stdio: 'inherit' });
console.log('written', OUT_PDF);
