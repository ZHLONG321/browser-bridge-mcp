import {open, readFile, rename, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cdp} from './client.mjs';
import {recordingPaths, verifiedRecordingFile, writeRecordingState} from './recordings.mjs';
import {deliverToolOutput} from './codex-notify.mjs';

const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const paths = recordingPaths(job.session_id, job.recording_id);
let state = {...JSON.parse(await readFile(paths.state, 'utf8')), worker_pid: process.pid};
let owned = false, stopAttempted = false, stream;
async function update(fields) {
  state = {...state, ...fields, updated_at: new Date().toISOString()};
  await writeRecordingState(paths, state);
  console.log(JSON.stringify({recording_id: job.recording_id, status: state.status, bytes: state.bytes, notification: state.notification}));
}
async function command(method, params = {}) {
  const reply = await cdp({...job.target, mode: 'authorized_mutation', commands: [{method, params}]});
  const item = reply.results?.[0];
  if (reply.error || item?.status !== 'exited' || item.error) {
    const message = String(item?.error || (typeof reply.error === 'object' ? JSON.stringify(reply.error) : reply.error) || 'Browser recording command failed.');
    throw Object.assign(Error(message), {method, outcome_unknown: reply.outcome_unknown === true || item?.status === 'timed_out'});
  }
  if (item.value?.type === 'result_truncated') throw Error('Native video stream data was truncated; no completed filename will be returned.');
  return item.value;
}
function unsupported(error) {
  return error.method === 'Page.startScreenRecording' && /method (?:was )?not found|wasn.t found|unknown method|not supported without AV1\/libaom|-32601/i.test(error.message);
}
async function stopRequested() {
  try {await stat(paths.stop); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}
async function saveStream() {
  if (!stream) throw Error('Native recorder returned no video stream.');
  const partial = join(paths.directory, `${job.recording_id}.partial`);
  const file = await open(partial, 'wx');
  let count = 0, header = Buffer.alloc(0);
  try {
    while (true) {
      // Keep each existing Bridge text response below its transport bound.
      // Write each chunk directly; never accumulate/re-encode the whole video.
      const chunk = await command('IO.read', {handle: stream, size: 65536});
      if (typeof chunk.data !== 'string') throw Error('Native video stream returned invalid chunk data.');
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      await file.writeFile(bytes);
      count += bytes.length;
      if (header.length < 12) header = Buffer.concat([header, bytes.subarray(0, 12 - header.length)]);
      if (chunk.eof) break;
    }
  } finally {await file.close();}
  if (!count) throw Error('Native recording produced an empty video.');
  const format = header.toString('ascii', 4, 8) === 'ftyp' ? 'mp4'
    : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm' : undefined;
  if (!format) throw Error('Native video container is unrecognized; the original bytes remain in the partial file.');
  const filename = `${job.recording_id}.${format}`;
  await rename(partial, join(paths.directory, filename));
  await verifiedRecordingFile(paths, {filename, bytes: count});
  return {filename, bytes: count, format};
}

try {
  await update({status: 'starting'});
  const params = {audio: job.audio, captureArea: 'target'};
  for (const [field, value] of Object.entries({maxWidth: job.max_width, maxHeight: job.max_height, frameRate: job.frame_rate})) {
    if (value !== undefined) params[field] = value;
  }
  const started = await command('Page.startScreenRecording', params);
  stream = started.stream;
  owned = true;
  const startTime = Date.now();
  await update({status: 'recording', supported: true, stream, started_at: new Date(startTime).toISOString(), duration_ms: job.duration_ms});
  // Native capture runs in the browser after the start tool has returned.
  // Manual stop and optional duration share the same one-shot stop operation.
  while (!await stopRequested() && (job.duration_ms === undefined || Date.now() - startTime < job.duration_ms)) {
    await delay(job.duration_ms === undefined ? 200 : Math.min(200, Math.max(1, job.duration_ms - (Date.now() - startTime))));
  }
  await update({status: 'saving'});
  stopAttempted = true;
  const stopped = await command('Page.stopScreenRecording');
  owned = false;
  stream = stopped.stream || stream;
  const saved = await saveStream();
  await update({...saved, status: 'completed', completed_at: new Date().toISOString(), stream: undefined});
  try {await command('IO.close', {handle: stream});} catch (error) {await update({stream_close_error: error.message});}
} catch (error) {
  if (owned && !stopAttempted) {
    stopAttempted = true;
    try {const stopped = await command('Page.stopScreenRecording'); stream = stopped.stream || stream; owned = false;}
    catch (stopError) {state.stop_error = stopError.message;}
  }
  if (unsupported(error)) await update({status: 'unsupported', supported: false, reason: error.message, stream});
  else await update({status: 'failed', error: error.message, stream, outcome_unknown: owned || error.outcome_unknown === true});
  // Keep partial bytes and any unread native stream for explicit recovery.
  // Never replay start/stop or silently discard a failed recording.
}

if (job.codex_notify) {
  try {
    const output = state.status === 'completed' ? await verifiedRecordingFile(paths, state)
      : JSON.stringify({recording_id: job.recording_id, status: state.status, reason: state.reason, error: state.error});
    const accepted = await deliverToolOutput(job.codex_notify, {name: 'browser_recording_result', namespace: null, output, retain: true});
    await update({notification: {status: 'accepted', turn_id: accepted.turn?.id}});
  } catch (error) {
    await update({notification: {status: 'failed', error: error.message, delivery_may_be_unknown: true}});
  }
}
