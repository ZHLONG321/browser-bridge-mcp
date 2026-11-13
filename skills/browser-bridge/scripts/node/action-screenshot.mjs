import {setTimeout as delay} from 'node:timers/promises';
import * as bridge from './client.mjs';
import {screenshot, validateScreenshotOptions} from './screenshots.mjs';

// One action, one delay after its acknowledgement, one capture; never replay a mutation.
export async function action_screenshot({action, capture: destination, delay_ms, mode, allow_foreground, ...options}) {
  const capture = {return_image: true, ...options};
  let takeScreenshot;
  if (destination?.type === 'browser') {
    const {type, ...area} = destination;
    Object.assign(capture, area);
    validateScreenshotOptions(capture);
    takeScreenshot = () => screenshot(capture);
  } else if (['windows_region', 'windows_window', 'windows_foreground'].includes(destination?.type)) {
    const {windowsSchemas} = await import('./windows-schema.mjs');
    const {windows_call} = await import('./windows-runner.mjs');
    const {requireWindows} = await import('./windows-platform.mjs');
    requireWindows();
    const {type, ...area} = destination;
    const operation = type.replace('windows_', 'capture_');
    const args = windowsSchemas[operation].parse({session_id: capture.session_id, format: capture.format,
      quality: capture.quality, return_image: capture.return_image, timeout_ms: capture.timeout_ms, ...area});
    if (operation === 'capture_window' && (args.hwnd === undefined) === (args.title === undefined)) throw new Error('Supply exactly one of hwnd or title.');
    takeScreenshot = () => windows_call(operation, args);
  } else {
    throw new Error('Supply browser, windows_region, windows_window or windows_foreground capture type.');
  }
  if (mode !== 'authorized_mutation') throw new Error('Action screenshots require mode: authorized_mutation.');
  // Node timers overflow above this native limit and would otherwise fire immediately.
  if (!Number.isInteger(delay_ms) || delay_ms < 0 || delay_ms > 2147483647) {
    throw new Error('delay_ms must be an integer between 0 and 2147483647 milliseconds.');
  }
  const firefox = capture.tab_id.startsWith('firefox-tab:');
  const target = {profile_id: capture.profile_id, context: capture.context, window_id: capture.window_id,
    tab_id: capture.tab_id, connection_id: capture.connection_id, service_url: capture.service_url,
    timeout_ms: capture.timeout_ms, mode, allow_foreground};
  let run;
  switch (action?.type) {
    case 'javascript':
      if (firefox) throw new Error('Use webextension for Firefox actions.');
      if (!Array.isArray(action.scripts) || !action.scripts.length || action.scripts.some(s => typeof s !== 'string')) throw new Error('Supply JavaScript function bodies in scripts.');
      run = () => bridge.javascript({...target, scripts: action.scripts, frame_id: action.frame_id});
      break;
    case 'cdp':
      if (firefox) throw new Error('Use webextension for Firefox actions.');
      if (!Array.isArray(action.commands) || !action.commands.length || action.commands.some(c => !c || typeof c.method !== 'string' || !c.method)) throw new Error('Supply native CDP commands.');
      run = () => bridge.cdp({...target, commands: action.commands});
      break;
    case 'navigate':
    case 'reload':
      if (firefox) throw new Error('Use webextension for Firefox actions.');
      if (action.type === 'navigate' && (typeof action.url !== 'string' || !action.url)) throw new Error('Navigation requires url.');
      run = () => bridge.tab_control({...target, action: action.type, ...(action.type === 'navigate' ? {url: action.url} : {})});
      break;
    case 'webextension':
      if (!firefox) throw new Error('Use javascript, cdp, navigate or reload for Chromium actions.');
      if (typeof action.path !== 'string' || !action.path || action.args !== undefined && !Array.isArray(action.args)) throw new Error('Supply a Firefox API path and optional args array.');
      run = () => bridge.webextension({...target, action: 'call', path: action.path, args: action.args});
      break;
    default:
      throw new Error('Use javascript, cdp, navigate, reload or webextension action type.');
  }
  let phase = 'action', action_result;
  try {
    console.error(JSON.stringify({event: 'action_screenshot_started', action: action.type, delay_ms}));
    action_result = await run();
    if (action_result.error || action_result.status === 'failed' || action_result.status === 'timed_out' ||
      action_result.results?.some(item => !['exited', 'completed'].includes(item.status) || item.error || item.value?.exceptionDetails)) {
      throw Object.assign(new Error('Browser action failed; no screenshot was taken.'), {result: action_result});
    }
    phase = 'delay';
    console.error(JSON.stringify({event: 'action_screenshot_waiting', delay_ms}));
    await delay(delay_ms);
    phase = 'screenshot';
    return await takeScreenshot();
  } catch (error) {
    error.details = {...error.details, phase, action_completed: phase !== 'action',
      ...(action_result === undefined ? {} : {action_result})};
    throw error;
  }
}
