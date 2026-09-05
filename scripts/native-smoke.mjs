import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Run with xvfb-run -a node scripts/native-smoke.mjs on Linux. Uses a real
// WebKit/Tauri application, an isolated data directory and a local fake LLM.
const scratch = await mkdtemp(path.join(tmpdir(), 'studio-native-test-'));
const sockets = new Set();
const provider = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
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
const driverPort = 4457;
let driver, session;
const wd = async (method, suffix, body) => {
  const response = await fetch(`http://127.0.0.1:${driverPort}${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result.value)); return result.value;
};
const script = (source, args = []) => wd('POST', `/session/${session}/execute/sync`, { script: source, args });
const ipcResult = (command, args = {}) => wd('POST', `/session/${session}/execute/async`, {
  script: 'const done=arguments[arguments.length-1];try{window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));}catch(error){done({error:String(error)});}', args: [command, args],
});
const ipc = async (command, args) => { const result = await ipcResult(command, args); if (result.error) throw new Error(result.error); return result.value; };
const until = async (read, description) => { for (let i = 0; i < 150; i++) { const result = await read(); if (result) return result; await delay(200); } throw new Error(`Timed out: ${description}`); };
try {
  driver = spawn('tauri-driver', ['--port', String(driverPort), '--native-port', '4458'], {
    env: { ...process.env, XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CONFIG_HOME: path.join(scratch, 'config'), WEBKIT_DISABLE_DMABUF_RENDERER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let driverLogs = ''; driver.stdout.on('data', data => { driverLogs += data; }); driver.stderr.on('data', data => { driverLogs += data; });
  driver.on('error', error => { console.error(error); });
  await until(async () => { try { return await fetch(`http://127.0.0.1:${driverPort}/status`).then(r => r.ok); } catch { return false; } }, 'WebDriver startup');
  const result = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: path.resolve('src-tauri/target/debug/screenshot-to-code') } } } });
  session = result.sessionId;
  await wd('POST', `/session/${session}/timeouts`, { script: 30000, pageLoad: 60000, implicit: 1000 });
  await until(() => script('return document.body.textContent.includes("A space for your next idea")'), 'Studio startup');
  const project = await ipc('create_project', { name: 'Native smoke', brief: 'IPC test' });
  await script('window.location.hash = arguments[0]', [`/projects/${project.id}`]);
  await until(() => script('return !!document.querySelector("textarea")'), 'project navigation');
  const initial = await ipc('get_files', { projectId: project.id });
  await ipc('edit_file', { projectId: project.id, path: 'notes.md', content: 'Native persistence', revision: initial.revision });
  assert.match((await ipcResult('edit_file', { projectId: project.id, path: '../escape', content: 'bad', revision: initial.revision })).error, /relative|portable/);
  assert.match((await ipcResult('edit_file', { projectId: project.id, path: 'notes.md', content: 'stale', revision: initial.revision })).error, /changed/);
  const settings = { primaryModel: 'custom:test', subagentModel: 'custom:test', customProviders: [{ id: 'test', enabled: true, baseUrl: `http://127.0.0.1:${providerPort}/v1`, protocol: 'chat_completions', apiKey: null, headers: {}, models: [{ id: 'test', name: 'Test' }] }], activeCustomProviderId: 'test' };
  const runId = await ipc('start_run', { projectId: project.id, text: 'ask first, then build', images: [], settings });
  await until(() => script('return [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Blue")'), 'question via IPC channel');
  await script('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Blue").click()');
  await until(async () => (await ipc('get_transcript', { projectId: project.id })).some(m => m.role === 'assistant' && m.runId === runId), 'generation completion');
  const files = await ipc('get_files', { projectId: project.id });
  assert.match(files.files['index.html'], /Native generation passed/);
  assert.equal(files.files['notes.md'], 'Native persistence');
  const versions = await ipc('list_iterations', { projectId: project.id }); assert.equal(versions.length, 2);
  await until(() => script('return !!document.querySelector("iframe")'), 'preview iframe');
  const handles = await wd('GET', `/session/${session}/window/handles`);
  await ipc('open_preview', { projectId: project.id, iterationId: null });
  const preview = await until(async () => (await wd('GET', `/session/${session}/window/handles`)).find(h => !handles.includes(h)), 'isolated preview window');
  await wd('POST', `/session/${session}/window`, { handle: preview });
  assert.equal(await script('return document.querySelector("h1")?.textContent'), 'Native generation passed');
  assert.equal(await script('return document.body.dataset.executed'), 'yes');
  const forbidden = await ipcResult('list_projects'); assert.ok(forbidden.error, 'Preview must not have project IPC access');
  await wd('DELETE', `/session/${session}/window`);
  await wd('POST', `/session/${session}/window`, { handle: handles[0] });
  await ipc('restore_revision', { projectId: project.id, iterationId: versions[0].id, revision: files.revision });
  const restored = await ipc('get_files', { projectId: project.id }); assert.equal(restored.files['index.html'], undefined);
  const slowId = await ipc('start_run', { projectId: project.id, text: 'Cancel this run', images: [], settings: { ...settings, primaryModel: 'custom:slow' } });
  await ipc('cancel_run', { projectId: project.id });
  await until(async () => (await ipc('get_transcript', { projectId: project.id })).some(m => m.runId === slowId && m.role === 'assistant'), 'cancel completion');
  await script('window.location.reload()');
  await until(async () => { try { return (await ipc('get_files', { projectId: project.id })).files['notes.md'] === 'Native persistence'; } catch { return false; } }, 'persisted reload');
  await until(() => script('return !!document.querySelector("textarea") && !document.body.textContent.includes("Opening Studio")'), 'render after reload');
  const runtime = await ipc('create_project', { name: 'Runtime lifecycle', brief: '' });
  let revision = (await ipc('get_files', { projectId: runtime.id })).revision;
  revision = (await ipc('edit_file', { projectId: runtime.id, path: 'package.json', content: JSON.stringify({ name: 'native-runtime-test', version: '1.0.0', scripts: { dev: 'node server.cjs' } }), revision })).revision;
  await ipc('edit_file', { projectId: runtime.id, path: 'server.cjs', content: 'require("http").createServer((q,s)=>s.end("native-runtime-ready")).listen(Number(process.env.PORT),"127.0.0.1")', revision });
  await ipc('start_services', { projectId: runtime.id });
  const service = await until(async () => {
    const status = await ipc('services_status', { projectId: runtime.id });
    if (status.state === 'crashed') throw new Error(JSON.stringify(status));
    return status.state === 'running' ? status : null;
  }, 'managed Node.js app');
  assert.equal(await fetch(service.url).then(r=>r.text()), 'native-runtime-ready');
  await ipc('stop_services', { projectId: runtime.id });
  assert.equal((await ipc('services_status', { projectId: runtime.id })).state, 'stopped');
  const screenshot = await wd('GET', `/session/${session}/screenshot`);
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/native-smoke.png', Buffer.from(screenshot, 'base64'));
  await writeFile('artifacts/native-smoke.log', driverLogs);
  console.log('PASS: real Tauri IPC, streaming tools, question round-trip, native preview, IPC isolation, revisions, traversal rejection, cancellation and persistence.');
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
  driver?.kill(); for (const socket of sockets) socket.destroy(); provider.close();
  await rm(scratch, { recursive: true, force: true });
}
