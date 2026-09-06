import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Per-flow native acceptance on Linux. Run with:
//   xvfb-run -a dbus-run-session -- node scripts/native-smoke.mjs
// Uses a real WebKit/Tauri application, isolated directories and a local fake
// LLM. IPC is used directly only for preparation and verification; every flow
// is otherwise driven through the visible UI.
const scratch = await mkdtemp(path.join(tmpdir(), 'studio-native-test-'));
const runtimeEnv = {
  ...process.env,
  XDG_DATA_HOME: path.join(scratch, 'data'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'),
  WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  // A virtual X11 test session does not need desktop portal mounts.
  GTK_USE_PORTAL: '0',
  GIO_USE_VFS: 'local',
};
const sockets = new Set();
const provider = http.createServer(async (request, response) => {
  if (request.url === '/v1/models' || request.url === '/models') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'test' }] }));
    return;
  }
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  assert.ok(!JSON.stringify(body.messages).includes("Stack preference:"), "legacy stack preference must not reach the model");
  if (body.model === 'slow') return;
  const specialist = body.messages[0].content.includes('specialist implementing');
  const results = body.messages.filter(m => m.role === 'tool');
  const ask = !specialist && body.messages.some(m => JSON.stringify(m.content).includes('ask first'));
  let call;
  if (specialist && results.length === 0) call = { name: 'create_file', arguments: JSON.stringify({ path: 'index.html', content: '<!doctype html><html><head><title>Native preview</title></head><body><h1>Native generation passed</h1><script>document.body.dataset.executed="yes"</script></body></html>' }) };
  else if (ask && results.length === 0) call = { name: 'ask_user', arguments: JSON.stringify({ question: 'Choose a color', options: ['Blue', 'Green', 'Red', 'Gray'] }) };
  else if (!specialist && results.length === (ask ? 1 : 0)) call = { name: 'spawn_agent', arguments: JSON.stringify({ name: 'Builder', objective: 'Build a native test page', filePaths: ['index.html'] }) };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = data => response.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ choices: [{ index: 0, delta: { reasoning_content: specialist ? 'Inspecting the page structure before creating the file. Checking the existing content and preserving the project architecture. Preparing the layout and verifying the required interactions. The saved result will remain available while the next changes are applied.' : 'Reviewing the request and choosing the next step.' } }] });
  if (specialist) {
    await delay(250);
    send({ choices: [{ index: 0, delta: { reasoning_content: ' Continuing from the earlier analysis without replacing it.' } }] });
  }
  await delay(specialist ? 1800 : 100);
  if (specialist && results.length === 0) {
    for (let chunk = 0; chunk < 2000; chunk++) {
      send({ choices: [{ index: 0, delta: { reasoning_content: ' checking layout' } }] });
      if (chunk % 25 === 0) await delay(10);
    }
  }
  if (call) {
    const midpoint = Math.floor(call.arguments.length / 2);
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, midpoint) } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: call.arguments.slice(midpoint) } }] }, finish_reason: 'tool_calls' }] });
  } else {
    for (const text of ['Native ', 'generation ', 'complete.']) send({ choices: [{ index: 0, delta: { content: text } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  response.end('data: [DONE]\n\n');
});
provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerPort = provider.address().port;
const providerBase = `http://127.0.0.1:${providerPort}/v1`;
const driverPort = 4457;
let driver, session, wmProc;
let driverLogs = '';
const skips = [];
const sanitize = text => String(text).replace(/(apiKey|authorization|x-api-key|x-goog-api-key)(["':\s]+)([^\s"',}]+)/gi, '$1$2[redacted]');
const wd = async (method, suffix, body) => {
  const response = await fetch(`http://127.0.0.1:${driverPort}${suffix}`, { method, signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result.value)); return result.value;
};
const script = (source, args = []) => wd('POST', `/session/${session}/execute/sync`, { script: source, args });
const ipcResult = (command, args = {}) => wd('POST', `/session/${session}/execute/async`, {
  script: 'const done=arguments[arguments.length-1];try{window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));}catch(error){done({error:String(error)});}', args: [command, args],
});
const ipc = async (command, args) => { const result = await ipcResult(command, args); if (result.error) throw new Error(result.error); return result.value; };
const until = async (read, description) => { for (let i = 0; i < 150; i++) { const result = await read(); if (result) return result; await delay(200); } throw new Error(`Timed out: ${description}`); };
const shot = async name => {
  const png = await wd('GET', `/session/${session}/screenshot`);
  await writeFile(name, Buffer.from(png, 'base64'));
};
const clickText = async (tag, text, root = 'document') => {
  const clicked = await script(`const scope=arguments[2]==="document"?document:document.querySelector(arguments[2]);const els=[...scope.querySelectorAll(arguments[0])];const el=els.find(e=>(e.textContent||"").trim()===arguments[1]&&!e.disabled&&e.offsetParent!==null);if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true;`, [tag, text, root]);
  assert.ok(clicked, `visible control not found: <${tag}> ${text}`);
};
const fillField = async (selector, value) => {
  await script(`const el=document.querySelector(arguments[0]);if(!el)throw new Error("missing "+arguments[0]);const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(el,arguments[1]);el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));`, [selector, value]);
};
const hasCommand = async name => {
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
};
async function step(name, fn) {
  console.log(`## ${name}`);
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}: ${error?.message ?? error}`);
    try {
      await mkdir('artifacts', { recursive: true });
      await shot(`artifacts/fail-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
      await writeFile(`artifacts/fail-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.log`, sanitize(driverLogs).slice(-20000));
      await writeFile(`artifacts/fail-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.context.txt`, sanitize(`hash=${await script('return window.location.hash').catch(() => '?')}\nbuttons=${await script('return document.querySelectorAll("button").length').catch(() => '?')}\n`));
    } catch { /* evidence is best-effort */ }
    throw error;
  }
}
try {
  await mkdir('artifacts', { recursive: true });
  if (await hasCommand('openbox')) {
    wmProc = spawn('openbox', [], { env: { ...runtimeEnv, DISPLAY: process.env.DISPLAY }, stdio: 'ignore' });
    wmProc.on('error', () => {});
    await delay(1500);
    console.log('window manager: openbox');
  } else {
    skips.push('real minimize/restore (no window manager on PATH)');
    console.log('window manager: none detected, minimize/restore will be skipped');
  }
  driver = spawn('tauri-driver', ['--port', String(driverPort), '--native-port', '4458'], {
    env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  driver.stdout.on('data', data => { driverLogs += data; }); driver.stderr.on('data', data => { driverLogs += data; void writeFile('artifacts/native-driver.log', sanitize(driverLogs)); });
  driver.on('error', error => { console.error(error); });
  await until(async () => { try { return await fetch(`http://127.0.0.1:${driverPort}/status`).then(r => r.ok); } catch { return false; } }, 'WebDriver startup');
  console.log('Opening native WebView…');
  const result = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: path.resolve('src-tauri/target/debug/screenshot-to-code') } } } });
  session = result.sessionId;
  await wd('POST', `/session/${session}/timeouts`, { script: 30000, pageLoad: 60000, implicit: 1000 });

  await step('startup and light theme', async () => {
    await until(() => script(`return !!document.querySelector('[aria-label="Project brief"]')`), 'Studio startup');
    assert.equal(await ipc('plugin:window|is_decorated', { label: 'main' }), false);
    await script('document.documentElement.classList.remove("dark"); document.body.classList.remove("dark")');
    const sidebar = await script('return getComputedStyle(document.querySelector(".forge-sidebar")).backgroundColor');
    assert.match(sidebar, /rgb\((2[0-4][0-9]|25[0-5]),\s*(2[0-4][0-9]|25[0-5]),\s*(2[0-4][0-9]|25[0-5])\)/, `expected a light sidebar, got ${sidebar}`);
    await shot('/tmp/forge-home.png');
  });

  await step('viewport sizes', async () => {
    await wd('POST', `/session/${session}/window/rect`, { width: 800, height: 600 });
    assert.equal(await script('return getComputedStyle(document.querySelector(".forge-sidebar")).display !== "none"'), true);
    await shot('/tmp/forge-home-800.png');
    await wd('POST', `/session/${session}/window/rect`, { width: 1024, height: 768 });
    assert.equal(await script('return document.querySelector(".forge-content")!==null'), true);
    await shot('/tmp/forge-home-1024.png');
    await wd('POST', `/session/${session}/window/rect`, { width: 1440, height: 940 });
  });

  await step('window controls', async () => {
    await ipc('plugin:window|toggle_maximize', { label: 'main' });
    await ipc('plugin:window|toggle_maximize', { label: 'main' });
    const labels = await script('return [...document.querySelectorAll("[aria-label=\\"Window controls\\"] button")].map(b=>b.getAttribute("aria-label"))');
    assert.deepEqual(labels, ['Minimize', 'Maximize', 'Close']);
    if (!wmProc || wmProc.exitCode !== null) {
      skips.push('minimize via UI (no live window manager)');
      return;
    }
    await wd('POST', `/session/${session}/window/minimize`);
    await delay(1000);
    await wd('POST', `/session/${session}/window/maximize`);
    const rect = await wd('GET', `/session/${session}/window/rect`);
    assert.ok(rect.width >= 1000, `expected a maximized window, got ${rect.width}`);
  });

  await step('dark theme', async () => {
    await script('document.documentElement.classList.add("dark"); document.body.classList.add("dark")');
    const sidebar = await script('return getComputedStyle(document.querySelector(".forge-sidebar")).backgroundColor');
    assert.match(sidebar, /rgb\((\d+),\s*(\d+),\s*(\d+)\)/, `unexpected sidebar ${sidebar}`);
    const [, r, g, b] = sidebar.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    assert.ok(Number(r) < 60 && Number(g) < 60 && Number(b) < 60, `expected a dark sidebar, got ${sidebar}`);
    await shot('/tmp/forge-home-dark.png');
    await script('document.documentElement.classList.remove("dark"); document.body.classList.remove("dark")');
  });

  await step('keyboard navigation', async () => {
    await script('document.querySelector("textarea")?.focus()');
    const stops = [];
    for (let i = 0; i < 10; i++) {
      await wd('POST', `/session/${session}/actions`, { actions: [{ type: 'key', id: 'kbd', actions: [{ type: 'keyDown', value: '' }, { type: 'keyUp', value: '' }] }] });
      stops.push(await script('const el=document.activeElement;return el?el.tagName+"|"+((el.getAttribute("aria-label")||el.textContent||"").trim().slice(0,24)):"none"'));
    }
    const interactive = stops.filter(s => /^(BUTTON|INPUT|TEXTAREA|SELECT)\|/.test(s));
    assert.ok(interactive.length >= 3, `expected tab stops on controls, got ${JSON.stringify(stops)}`);
  });

  await step('project creation through the composer', async () => {
    await fillField('[aria-label="Project brief"]', 'Native smoke');
    await script(`document.querySelector('[aria-label="Create project"]').click()`);
    const created = await until(async () => {
      const found = await script('return document.querySelector("h1")?.textContent');
      return found === 'Native smoke' ? found : null;
    }, 'project navigation');
    assert.equal(created, 'Native smoke');
    await shot('/tmp/forge-project.png');
  });

  let projectId = await script('return window.location.hash').then(h => h.split('/').pop());
  assert.ok(projectId && projectId.length > 4, `expected a project route, got ${projectId}`);

  await step('question round-trip and generation', async () => {
    const initial = await ipc('get_files', { projectId });
    await ipc('edit_file', { projectId, path: 'notes.md', content: 'Native persistence', revision: initial.revision });
    assert.match((await ipcResult('edit_file', { projectId, path: '../escape', content: 'bad', revision: initial.revision })).error, /relative|portable/);
    assert.match((await ipcResult('edit_file', { projectId, path: 'notes.md', content: 'stale', revision: initial.revision })).error, /changed/);
    const settings = { primaryModel: 'custom:test', subagentModel: 'custom:test', customProviders: [{ id: 'test', enabled: true, baseUrl: providerBase, protocol: 'chat_completions', apiKey: null, headers: {}, models: [{ id: 'test', name: 'Test' }] }], activeCustomProviderId: 'test' };
    await fillField('[aria-label="Message"]', 'Keep my next change');
    await clickText('button', 'Settings', '.forge-sidebar');
    const runId = await ipc('start_run', { projectId, text: 'ask first, then build', images: [], settings: { ...settings, generatedCodeConfig: 'legacy-ignored' } });
    await until(() => script('return [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Blue")'), 'question via IPC channel');
    assert.equal(await script(`return document.querySelector('[aria-label="Message"]').value`), 'Keep my next change');
    await shot('/tmp/forge-settings-running.png');
    await clickText('button', 'Close', '[role="dialog"]');
    await shot('/tmp/forge-question.png');
    await script('window.__frameGaps = []; window.__measureFrames = true; let previous = performance.now(); const measure = now => { window.__frameGaps.push(now - previous); previous = now; if (window.__measureFrames) requestAnimationFrame(measure); }; requestAnimationFrame(measure);');
    await clickText('button', 'Blue');
    await until(() => script('return document.querySelector(".thinking-stream")?.textContent.includes("Inspecting")'), 'live specialist thinking');
    await delay(600);
    assert.ok(await script('return document.querySelector(".thinking-lines").textContent.includes("Inspecting") && document.querySelector(".thinking-lines").textContent.includes("Continuing")'), 'earlier thinking remains after new deltas');
    assert.ok(await script('return document.querySelector(".thinking-viewport").scrollTop > 0'), 'thinking moves upward');
    assert.ok(await script('return new Set([...document.querySelectorAll(".thinking-line")].map(line => line.style.transform)).size > 1'), 'thinking lens varies width by position');
    assert.equal(await script('return getComputedStyle(document.querySelector(".thinking-line")).textAlign'), 'left', 'thinking aligns to reading edge');
    assert.ok(await script('return document.querySelector(".stage-work").clientWidth > 480'), 'thinking fills the stage width');
    await shot('/tmp/forge-thinking.png');
    await until(async () => (await ipc('get_transcript', { projectId })).some(m => m.role === 'assistant' && m.runId === runId), 'generation completion');
    const frames = await script('window.__measureFrames = false; return window.__frameGaps');
    const sortedFrames = frames.slice().sort((a, b) => a - b);
    const p95 = sortedFrames[Math.floor(sortedFrames.length * .95)];
    console.log(`Streaming frame intervals: p95=${Math.round(p95)}ms, max=${Math.round(Math.max(...frames))}ms`);
    assert.ok(p95 < 250, 'UI keeps rendering through a 2000-fragment burst');
    assert.ok(await script('return document.querySelectorAll(".thinking-line").length <= 14'), 'bounded teleprompter DOM');
    const files = await ipc('get_files', { projectId });
    assert.match(files.files['index.html'], /Native generation passed/);
    assert.equal(files.files['notes.md'], 'Native persistence');
    const versions = await ipc('list_iterations', { projectId }); assert.equal(versions.length, 2);
    await until(() => script('return !!document.querySelector(".layout-split iframe")'), 'adaptive preview reveal');
    assert.equal(await script(`return document.querySelector('[aria-label="Message"]').value`), 'Keep my next change');
    await shot('/tmp/forge-workspace.png');
    assert.equal(await script('return document.querySelectorAll(".conversation-message").length'), 0, 'message stream stays out of the primary workspace');
    for (const [width, height] of [[800, 600], [1024, 768], [1440, 940]]) {
      await wd('POST', `/session/${session}/window/rect`, { width, height });
      assert.equal(await script('return document.documentElement.scrollWidth <= innerWidth'), true, `no horizontal overflow at ${width}`);
      await shot(`/tmp/forge-workspace-${width}.png`);
    }
    await clickText('button', 'History');
    assert.ok(await script('return document.querySelector(".forge-history-dialog")?.textContent.includes("Native generation complete")'));
    await clickText('button', 'Close', '[role="dialog"]');
    await clickText('button', 'Code');
    await until(() => script('return !!document.querySelector(".cm-editor")'), 'source editor');
    await shot('/tmp/forge-code.png');
    await script('window.__forgeEditor = document.querySelector(".cm-editor"); window.__forgePreview = document.querySelector("iframe")');
    await clickText('button', 'Preview');
    assert.equal(await script('return window.__forgePreview === document.querySelector("iframe")'), true, 'preview stays mounted across views');
    await clickText('button', 'Code');
    assert.equal(await script('return window.__forgeEditor === document.querySelector(".cm-editor")'), true, 'editor stays mounted across views');
    await clickText('button', 'Preview');

    await clickText('button', 'Overview');
    assert.equal(await script('return !!document.querySelector(".layout-conversation")'), true);
    await clickText('button', 'Show result');
    await clickText('button', 'Agents');
    await until(() => script('return document.querySelector(".run-details")?.textContent.includes("Builder")'), 'completed agent details');
    assert.equal(await script('return !!document.querySelector(".forge-details-dialog")'), false);
    await shot('/tmp/forge-details.png');
    await clickText('button', 'Result', '.workspace-panel-tabs');
    return { runId };
  });

  await step('isolated preview window', async () => {
    const handles = await wd('GET', `/session/${session}/window/handles`);
    await script(`document.querySelector('[aria-label="Result options"]').click()`);
    await until(() => script('return [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Open preview window"&&b.offsetParent!==null)'), 'preview control');
    await clickText('button', 'Open preview window');
    const preview = await until(async () => (await wd('GET', `/session/${session}/window/handles`)).find(h => !handles.includes(h)), 'isolated preview window');
    await wd('POST', `/session/${session}/window`, { handle: preview });
    assert.equal(await script('return document.querySelector("h1")?.textContent'), 'Native generation passed');
    assert.equal(await script('return document.body.dataset.executed'), 'yes');
    const forbidden = await ipcResult('list_projects'); assert.ok(forbidden.error, 'Preview must not have project IPC access');
    await wd('DELETE', `/session/${session}/window`);
    await wd('POST', `/session/${session}/window`, { handle: handles[0] });
    await script('window.location.hash = arguments[0]', [`/projects/${projectId}`]);
    await until(() => script('return !!document.querySelector("iframe")'), 'back to project');
  });

  await step('history restore and cancellation', async () => {
    const files = await ipc('get_files', { projectId });
    const versions = await ipc('list_iterations', { projectId });
    await ipc('restore_revision', { projectId, iterationId: versions[0].id, revision: files.revision });
    const restored = await ipc('get_files', { projectId }); assert.equal(restored.files['index.html'], undefined);
    const settings = { primaryModel: 'custom:slow', subagentModel: 'custom:slow', customProviders: [{ id: 'test', enabled: true, baseUrl: providerBase, protocol: 'chat_completions', apiKey: null, headers: {}, models: [{ id: 'slow', name: 'Slow' }] }], activeCustomProviderId: 'test' };
    const slowId = await ipc('start_run', { projectId, text: 'Cancel this run', images: [], settings: { ...settings, primaryModel: 'custom:slow' } });
    await ipc('cancel_run', { projectId });
    await until(async () => (await ipc('get_transcript', { projectId })).some(m => m.runId === slowId && m.role === 'assistant'), 'cancel completion');
  });

  await step('provider settings through the UI', async () => {
    await clickText('button', 'Settings', '.forge-sidebar');
    await until(() => script('return [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Providers")'), 'settings screen');
    await clickText('button', 'Add provider');
    await fillField('#provider-name', 'Native Fake');
    await fillField('#provider-base-url', providerBase);
    await clickText('button', 'Run test');
    await until(() => script('return document.body.textContent.includes("Connection OK")||document.body.textContent.includes("discovered model")'), 'connection test');
    const discovered = await script('return [...document.querySelectorAll("button")].find(b=>/discovered$/.test(b.textContent.trim()))?.textContent.trim() ?? null');
    if (discovered) await clickText('button', discovered);
    await clickText('button', 'Save provider');
    await until(() => script('return document.body.textContent.includes("Tested OK")||document.body.textContent.includes("In use")'), 'provider badge');
  });

  await step('reduced motion wiring', async () => {
    const probe = await script(`const host=document.createElement("div");host.className="studio-shell";const el=document.createElement("div");el.className="stage-mark is-working";el.innerHTML="<span></span>";host.appendChild(el);document.body.appendChild(host);const mq=window.matchMedia("(prefers-reduced-motion: reduce)");const out={name:getComputedStyle(el.firstChild).animationName,reduced:mq.matches};host.remove();return out;`);
    assert.equal(probe.name, probe.reduced ? 'none' : 'stage-ripple');
  });

  await step('service crash shows restart', async () => {
    const runtime = await ipc('create_project', { name: 'Runtime crash', brief: '' });
    let revision = (await ipc('get_files', { projectId: runtime.id })).revision;
    revision = (await ipc('edit_file', { projectId: runtime.id, path: 'package.json', content: JSON.stringify({ name: 'native-crash-test', version: '1.0.0', scripts: { dev: 'node missing.cjs' } }), revision })).revision;
    await ipc('edit_file', { projectId: runtime.id, path: 'index.html', content: '<h1>crash</h1>', revision });
    await ipc('start_services', { projectId: runtime.id });
    await until(async () => (await ipc('services_status', { projectId: runtime.id })).state === 'crashed', 'supervised crash');
    // IPC preparation bypasses the UI list: reload so the sidebar reflects it.
    await script('window.location.reload()');
    await until(() => script('return document.body.textContent.includes("Runtime crash")'), 'list shows Runtime crash');
    await script('window.location.hash = arguments[0]', [`/projects/${runtime.id}`]);
    await until(() => script('return document.body.textContent.includes("Restart app")'), 'restart control');
  });

  await step('managed Node.js lifecycle', async () => {
    const runtime = await ipc('create_project', { name: 'Runtime lifecycle', brief: '' });
    await script('window.location.reload()');
    await until(() => script('return document.body.textContent.includes("Runtime lifecycle")'), 'list shows Runtime lifecycle');
    let revision = (await ipc('get_files', { projectId: runtime.id })).revision;
    revision = (await ipc('edit_file', { projectId: runtime.id, path: 'package.json', content: JSON.stringify({ name: 'native-runtime-test', version: '1.0.0', scripts: { dev: 'node server.cjs' } }), revision })).revision;
    await ipc('edit_file', { projectId: runtime.id, path: 'server.cjs', content: 'require("http").createServer((q,s)=>s.end("native-runtime-ready")).listen(Number(process.env.PORT),"127.0.0.1")', revision });
    await ipc('start_services', { projectId: runtime.id });
    const service = await until(async () => {
      const status = await ipc('services_status', { projectId: runtime.id });
      if (status.state === 'crashed') throw new Error(JSON.stringify(status));
      return status.state === 'running' ? status : null;
    }, 'managed Node.js app');
    assert.equal(await fetch(service.url).then(r => r.text()), 'native-runtime-ready');
    await ipc('stop_services', { projectId: runtime.id });
    assert.equal((await ipc('services_status', { projectId: runtime.id })).state, 'stopped');
  });

  await step('native file dialogs', async () => {
    if (!await hasCommand('xdotool') && !await hasCommand('wtype')) {
      skips.push('native file dialogs (no desktop automation on PATH)');
      return;
    }
    throw new Error('desktop automation present but dialog scripting is not implemented');
  });

  await step('reload persistence', async () => {
    await script('window.location.reload()');
    await until(async () => { try { return (await ipc('get_files', { projectId })).files['notes.md'] === 'Native persistence'; } catch { return false; } }, 'persisted reload');
    await until(() => script('return !!document.querySelector("textarea") && !document.body.textContent.includes("Opening Studio")'), 'render after reload');
  });

  const screenshot = await wd('GET', `/session/${session}/screenshot`);
  await writeFile('artifacts/native-smoke.png', Buffer.from(screenshot, 'base64'));
  await writeFile('artifacts/native-smoke.log', sanitize(driverLogs));
  try {
    await writeFile('artifacts/skips.txt', `${skips.map(s => `SKIP ${s}`).join('\n')}\n`);
  } catch { /* ignore */ }
  console.log(`PASS: creation, questions, generation, isolated preview, history, provider UI, services, persistence. Skips: ${skips.length ? skips.join('; ') : 'none'}.`);
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
  driver?.kill(); wmProc?.kill();
  for (const socket of sockets) socket.destroy(); provider.close();
  await readFile('artifacts/native-smoke.png').catch(() => writeFile('artifacts/native-smoke.log', sanitize(driverLogs)).catch(() => {}));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
