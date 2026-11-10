import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, open, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {tabs} from './client.mjs';

const active = new Set(['starting', 'recording', 'saving']);
export function recordingDirectory(session_id) {
  if (typeof session_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session_id)) throw Error('Supply the current caller session_id.');
  return join(process.env.TMP || tmpdir(), `codex-${session_id}-browser-bridge`, 'video');
}
export function recordingPaths(session_id, recording_id) {
  if (!/^recording-[0-9a-f-]{36}$/.test(recording_id ?? '')) throw Error('Supply the recording_id returned by recording_start.');
  const directory = recordingDirectory(session_id);
  const job = join(directory, '.jobs', recording_id);
  return {directory, job, request: join(job, 'request.json'), state: join(job, 'state.json'), stop: join(job, 'stop.request')};
}
export async function writeRecordingState(paths, state) {
  await writeFile(paths.state + '.next', JSON.stringify(state));
  await rename(paths.state + '.next', paths.state);
}
async function readState(paths) {
  return JSON.parse(await readFile(paths.state, 'utf8'));
}
export async function verifiedRecordingFile(paths, state) {
  if (typeof state.filename !== 'string' || basename(state.filename) !== state.filename) throw Error('Recording has no valid completed filename.');
  const saved = await stat(join(paths.directory, state.filename));
  if (!saved.isFile() || !saved.size || saved.size !== state.bytes) throw Error('Recording file is missing, empty or incomplete.');
  return state.filename;
}
async function selectedRecording(fields) {
  if (!fields.profile_id || !['normal', 'private'].includes(fields.context) || !fields.tab_id) throw Error('Explicit profile_id, context and tab_id are required.');
  const paths = recordingPaths(fields.session_id, fields.recording_id);
  const state = await readState(paths);
  for (const key of ['profile_id', 'context', 'tab_id', 'window_id']) {
    if (fields[key] !== undefined && fields[key] !== state.target[key]) throw Error(`Recording ${key} selection mismatch.`);
  }
  if ((active.has(state.status) || state.notification?.status === 'pending') && state.worker_pid) {
    try {process.kill(state.worker_pid, 0);} catch (error) {
      if (error.code !== 'ESRCH') throw error;
      if (state.status === 'completed') return {paths, state: {...state, notification: {status: 'failed', error: 'Worker exited before notification was acknowledged.', delivery_may_be_unknown: true}}};
      return {paths, state: {...state, status: 'failed', error: 'Recording worker exited before completion; inspect its log and native stream before recovery.', outcome_unknown: true}};
    }
  }
  return {paths, state};
}

export async function recording_start({session_id, profile_id, context, tab_id, window_id, mode,
  duration_ms, audio = false, max_width, max_height, frame_rate, codex_notify, service_url, timeout_ms}) {
  recordingDirectory(session_id);
  if (mode !== 'authorized_mutation') throw Error('Starting a recording requires mode: authorized_mutation.');
  for (const [name, value] of Object.entries({duration_ms, max_width, max_height, frame_rate, timeout_ms})) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw Error(`${name} must be a positive safe integer.`);
  }
  if (typeof audio !== 'boolean') throw Error('audio must be a boolean.');
  if (codex_notify) {
    const {validateCodexNotification} = await import('./codex-notify.mjs');
    validateCodexNotification(codex_notify);
  }
  const found = await tabs({profile_id, context, window_id, service_url});
  const tab = found.tabs.find(item => item.tab_id === tab_id);
  if (!tab) throw Error('The selected recording tab is absent from this live profile/privacy/window.');
  if (tab.browser === 'firefox' || tab_id.startsWith('firefox-tab:')) {
    return {status: 'unsupported', supported: false, reason: 'This Bridge has no native background video-recording operation for Firefox.'};
  }
  const recording_id = `recording-${randomUUID()}`;
  const paths = recordingPaths(session_id, recording_id);
  await mkdir(paths.job, {recursive: true});
  const request = {session_id, recording_id, target: {profile_id, context, tab_id, window_id: tab.window_id, service_url, timeout_ms},
    duration_ms, audio, max_width, max_height, frame_rate, codex_notify};
  await writeFile(paths.request, JSON.stringify(request), {flag: 'wx'});
  const initial = {recording_id, status: 'starting', target: request.target, created_at: new Date().toISOString(),
    notification: {status: codex_notify ? 'pending' : 'not_configured'}};
  await writeRecordingState(paths, initial);
  const log = await open(join(paths.job, 'worker.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./recording-worker.mjs', import.meta.url)), paths.request], {
      detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
    child.unref();
  } catch (error) {
    await writeRecordingState(paths, {...initial, status: 'failed', error: error.message});
    throw error;
  } finally {await log.close();}
  const deadline = Date.now() + (timeout_ms ?? 30000) + 5000;
  while (Date.now() < deadline) {
    const state = await readState(paths);
    if (state.status !== 'starting') return state;
    try {process.kill(child.pid, 0);} catch (error) {if (error.code === 'ESRCH') throw Object.assign(Error(`Recording worker exited; inspect ${join(paths.job, 'worker.log')}`), {created: {recording_id}}); throw error;}
    await delay(100);
  }
  return {...await readState(paths), outcome_unknown: true, message: 'Startup acknowledgement is pending. Inspect this recording_id; do not start another recording.'};
}
export async function recording_status(fields) {
  return (await selectedRecording(fields)).state;
}
export async function recording_stop(fields) {
  if (fields.mode !== 'authorized_mutation') throw Error('Stopping a recording requires mode: authorized_mutation.');
  const {paths, state} = await selectedRecording(fields);
  if (!['starting', 'recording'].includes(state.status)) return state;
  try {await writeFile(paths.stop, new Date().toISOString(), {flag: 'wx'});} catch (error) {if (error.code !== 'EEXIST') throw error;}
  return {...state, stop_requested: true};
}
export async function recording_result(fields) {
  const {paths, state} = await selectedRecording(fields);
  if (state.status !== 'completed') return state;
  return verifiedRecordingFile(paths, state);
}
