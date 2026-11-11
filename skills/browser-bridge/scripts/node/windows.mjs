import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stat, readFile} from 'node:fs/promises';
import {resolve, join, basename} from 'node:path';
import {profiles, webextension, find_tabs, window_control, defaultUrl} from './client.mjs';
import {requireWindows} from './windows-platform.mjs';

// This call owns one native guard lease, never a current/default browser selection.
export async function create_firefox_window({profile_id, context, connection_id,
  native_window_handle, anchor_window_id, url = 'about:blank', service_url} = {}) {
  requireWindows();
  if (!profile_id || !connection_id || !['normal', 'private'].includes(context)) throw new Error('Explicit profile_id, connection_id and normal/private context are required.');
  if (!Number.isSafeInteger(native_window_handle) || native_window_handle <= 0 || !Number.isSafeInteger(anchor_window_id)) throw new Error('Supply a live native_window_handle and its bridge anchor_window_id.');
  const selected = (await profiles({service_url})).profiles.find(item => item.profile_id === profile_id && item.connection_id === connection_id && item.browser === 'firefox');
  if (!selected) throw new Error('The selected Firefox connection is not live.');
  if (context === 'private' && !selected.private_allowed) throw new Error('Allow the extension to run in Firefox private windows first.');
  const anchor = selected.windows.find(window => window.window_id === anchor_window_id);
  if (!anchor) throw new Error('The anchor window is not visible in the selected Firefox profile.');
  const check = await webextension({profile_id, connection_id, context: anchor.incognito ? 'private' : 'normal',
    window_id: anchor_window_id, path: 'windows.get', args: [anchor_window_id], service_url});
  if (check.status !== 'completed' || check.error || !check.value?.title) throw new Error(check.error || 'Cannot establish the native window title.');
  return withGuard([String(native_window_handle), check.value.title], () =>
    webextension({profile_id, connection_id, context, path: 'windows.create',
      args: [{url, incognito: context === 'private', focused: false}], mode: 'authorized_mutation', service_url}));
}

async function withGuard(nativeArguments, operation) {
  return withNativeLease('foreground_guard.py', nativeArguments, operation, 10000);
}

async function withNativeLease(script, nativeArguments, operation, readyTimeout) {
  const child = spawn('uv', ['run', '--no-project', 'python', '-X', 'utf8',
    fileURLToPath(new URL(`../windows/${script}`, import.meta.url)),
    ...nativeArguments], {windowsHide: true});
  let buffer = '', errors = '', acknowledgement = false, stopped = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  const timer = setTimeout(() => readyReject(new Error('Native guard did not become ready; inspect any reported startup before retrying.')), readyTimeout);
  child.stderr.on('data', data => {errors += data;});
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      try {
        const value = JSON.parse(buffer.slice(0, end));
        if (value.ready) {acknowledgement = true; readyResolve(value);}
        if (value.stopped) stopped = true;
      } catch (error) {readyReject(error);}
      buffer = buffer.slice(end + 1);
    }
  });
  const closed = new Promise(resolve => {
    child.on('error', error => {readyReject(error); resolve({error});});
    child.on('close', code => {
      if (!acknowledgement) readyReject(new Error(`Native guard failed before creation: ${errors || code}`));
      resolve({code});
    });
  });
  let operationError;
  try {
    const native = await ready;
    clearTimeout(timer);
    return await operation(native);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    clearTimeout(timer);
    child.stdin.on('error', () => {});
    child.stdin.end('stop\n');
    const result = await closed;
    if (acknowledgement && (result.error || result.code !== 0 || !stopped)) throw new Error(`Native guard release failed; inspect the created window before repeating: ${errors}${operationError ? ` Original operation: ${operationError}` : ''}`, {cause: operationError});
  }
}

async function launch(executable, args) {
  const child = spawn(executable, args, {windowsHide: true, stdio: 'ignore'});
  await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
  child.unref();
}

const profileReaderDependency = 'dfindexeddb @ https://github.com/google/dfindexeddb/archive/b65ff9bd6dedb61e7b288e1bdadf68ef6b1f56bb.zip';

async function pythonJson(script, args = [], leveldb = false) {
  const child = spawn('uv', ['run', '--offline', '--no-project',
    ...(leveldb ? ['--with', profileReaderDependency] : []), 'python', '-X', 'utf8',
    fileURLToPath(new URL(`../windows/${script}`, import.meta.url)), ...args], {windowsHide: true});
  let output = '', errors = '';
  child.stdout.on('data', data => {output += data;});
  child.stderr.on('data', data => {errors += data;});
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errors || `Edge discovery failed: ${code}`)));
  });
  return JSON.parse(output);
}

export async function edge_defaults() {
  requireWindows();
  return pythonJson('edge_info.py');
}

// Inspect only a task-resolved physical profile; disconnected profiles are not installation requests.
export async function edge_profile_extension_status({user_data_dir, profile_directory, context} = {}) {
  requireWindows();
  if (!['normal', 'private'].includes(context)) throw new Error('Explicit normal/private context is required.');
  if (typeof user_data_dir !== 'string' || !user_data_dir) throw new Error('Resolve the Edge user-data directory first.');
  if (typeof profile_directory !== 'string' || !profile_directory || profile_directory === '.' || profile_directory === '..' || /[\\/]/.test(profile_directory)) throw new Error('Supply one existing physical profile directory name.');
  const root = resolve(user_data_dir);
  const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'));
  if (!Object.hasOwn(state.profile?.info_cache ?? {}, profile_directory)) throw new Error('The selected profile is not registered in Edge Local State.');
  const profilePath = join(root, profile_directory);
  if (!(await stat(profilePath)).isDirectory()) throw new Error('The selected physical profile directory does not exist.');
  const extensionPath = fileURLToPath(new URL('../../extension', import.meta.url));
  if (!(await stat(extensionPath)).isDirectory()) throw new Error('This skill extension directory does not exist.');
  const source = join(profilePath, 'Secure Preferences');
  const preferences = JSON.parse(await readFile(source, 'utf8'));
  const settings = preferences.extensions?.settings;
  const value = {
    profile_directory, profile_name: state.profile.info_cache[profile_directory].name ?? null,
    context, extension_path: extensionPath, source, evidence: 'saved_preferences',
    connection_state: 'not_checked',
  };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {...value, registration: 'unknown', private_allowed: null,
      guidance: 'The saved extension registry is unavailable. Do not infer that installation is missing.'};
  }
  const entries = Object.entries(settings);
  if (entries.some(([, item]) => !item || typeof item !== 'object' || Array.isArray(item))) {
    return {...value, registration: 'unknown', private_allowed: null,
      guidance: 'The saved extension registry contains unreadable entries. Do not infer that installation is missing.'};
  }
  const installed = entries.filter(([, item]) => typeof item?.path === 'string' &&
    resolve(profilePath, 'Extensions', item.path).toLowerCase() === resolve(extensionPath).toLowerCase());
  if (installed.length === 1) {
    const [extension_id, item] = installed[0];
    return {...value, registration: 'present', extension_id,
      private_allowed: typeof item.incognito === 'boolean' ? item.incognito : null,
      guidance: 'Registration is present; it does not prove a live or enabled extension. Check live connections and recovery; do not request reinstallation. For private tasks, check the selected profile permission separately.'};
  }
  // Another copy/name match must not trigger a duplicate installation request.
  if (installed.length > 1 || entries.some(([, item]) => item?.manifest?.name === 'Browser Bridge')) {
    return {...value, registration: 'unknown', private_allowed: null,
      guidance: 'Several registrations or another Browser Bridge copy may exist. Confirm the selected profile extension before requesting installation.'};
  }
  return {...value, registration: 'not_found', private_allowed: null,
    guidance: 'No registration for this skill extension was found in the saved registry. Only if this is the task-required profile, ask the user to load extension_path in that profile. Other profiles need no installation. Saved preferences may lag live browser state.'};
}

// Physical profile selection is explicit here; no default/current target is saved.
export async function create_edge_window({executable, user_data_dir, profile_directory,
  context, url, service_url = defaultUrl()} = {}) {
  requireWindows();
  if (!['normal', 'private'].includes(context)) throw new Error('Explicit normal/private context is required.');
  if (typeof profile_directory !== 'string' || !profile_directory || profile_directory === '.' || profile_directory === '..' || /[\\/]/.test(profile_directory)) throw new Error('Supply one existing physical profile directory name.');
  if (typeof executable !== 'string' || basename(executable).toLowerCase() !== 'msedge.exe' || !user_data_dir) throw new Error('Resolve the installed Edge executable and user-data directory first.');
  executable = resolve(executable);
  user_data_dir = resolve(user_data_dir);
  if (!(await stat(executable)).isFile() || !(await stat(join(user_data_dir, profile_directory))).isDirectory()) throw new Error('The executable or selected profile does not exist.');
  const localState = JSON.parse(await readFile(join(user_data_dir, 'Local State'), 'utf8'));
  if (!Object.hasOwn(localState.profile?.info_cache ?? {}, profile_directory)) throw new Error('The selected profile is not registered in Edge Local State.');
  const preferences = JSON.parse(await readFile(join(user_data_dir, profile_directory, 'Secure Preferences'), 'utf8'));
  const extensionPath = fileURLToPath(new URL('../../extension', import.meta.url));
  const installed = Object.values(preferences.extensions?.settings ?? {}).filter(item =>
    typeof item.path === 'string' && resolve(item.path).toLowerCase() === resolve(extensionPath).toLowerCase());
  if (installed.length !== 1) throw new Error('Load this skill’s extension in the selected Edge profile before background window creation.');
  if (context === 'private' && installed[0].incognito !== true) throw new Error('Allow this extension in InPrivate for the selected Edge profile first.');
  if (url !== undefined && !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Use an authorized HTTP(S) destination URL.');
  const identity = await pythonJson('edge_profile_id.py', [user_data_dir, profile_directory], true);
  const selection = [`--user-data-dir=${user_data_dir}`, `--profile-directory=${profile_directory}`];
  async function connected() {
    const deadline = Date.now() + 15000;
    let selected;
    while (Date.now() < deadline) {
      selected = (await profiles({service_url})).profiles.find(item => item.profile_id === identity.profile_id && item.browser === 'chromium');
      if (selected) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!selected) throw new Error('The selected physical Edge profile did not connect. Check its extension before repeating.');
    if (context === 'private' && !selected.private_allowed) throw new Error('Allow this extension in InPrivate for the selected Edge profile first.');
    return selected;
  }
  const created = await withNativeLease('edge_startup.py',
    [executable, user_data_dir, profile_directory, context, ...(url === undefined ? [] : [url])], async native => {
    if (!native.running) {
      await connected();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = (await find_tabs({match: {profile_id: identity.profile_id, context,
          ...(url === undefined ? {} : {url})}, service_url})).matches;
        const windows = [...new Set(found.map(item => item.window_id))];
        if (windows.length > 1) throw new Error('Several startup windows match the destination. Inspect the created windows before selecting one or repeating.');
        if (windows.length === 1) {
          const current = (await profiles({service_url})).profiles.find(item => item.profile_id === identity.profile_id);
          const window = current?.windows.find(item => item.window_id === windows[0]);
          if (window) {
            const tabs = (await find_tabs({match: {profile_id: identity.profile_id, context,
              window_id: window.window_id}, service_url})).matches;
            return {...window, profile_id: identity.profile_id, context,
              connection_id: current.connection_id, tabs,
              ...(found.length === 1 ? {tab_id: found[0].tab_id} : {}), native_process_id: native.pid};
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`The startup window was not reported in live inventory. Inspect process ${native.pid} before repeating.`);
    }
    return withGuard(['--chromium', user_data_dir, executable], async () => {
      await launch(executable, [...selection, '--no-startup-window']);
      await connected();
      const result = await window_control({profile_id: identity.profile_id, context, action: 'create',
        ...(url === undefined ? {} : {url}), mode: 'authorized_mutation', timeout_ms: 15000, service_url});
      const item = result.results?.[0];
      if (result.error || item?.status !== 'exited' || !Number.isSafeInteger(item.value?.window_id)) throw Object.assign(new Error('Native window creation failed; inspect its result before repeating.'), {result});
      const value = item.value;
      const tab_id = value.tabs?.[0]?.tab_id;
      const visibleDeadline = Date.now() + 5000;
      while (Date.now() < visibleDeadline) {
        const matches = (await find_tabs({match: {profile_id: identity.profile_id, context,
          window_id: value.window_id, ...(tab_id ? {tab_id} : {})}, service_url})).matches;
        if (matches.length) return {...value, profile_id: identity.profile_id, context,
          connection_id: matches[0].connection_id, tab_id};
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Object.assign(new Error('The created window was not reported in live inventory. Inspect it before repeating.'), {created: value});
    });
  }, 45000);
  return {status: 'completed', value: created};
}
