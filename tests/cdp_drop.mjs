// Tests only: drop a file onto the running Stitchline window (as if dragged from Explorer).
//   node tests/cdp_drop.mjs C:\path\drawing.plt
import fs from 'node:fs';
import path from 'node:path';
const file = process.argv[2];
const b64 = fs.readFileSync(file).toString('base64');
const name = path.basename(file);
const expr = `(() => {
  const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(name)}));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return 'dropped ' + u.length + ' bytes';
})()`;
const port = process.env.CDP_PORT || 9333;
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id === 1) { console.log(JSON.stringify(m.result.result.value)); ws.close(); } };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
