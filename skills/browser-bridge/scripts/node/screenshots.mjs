import {randomUUID} from 'node:crypto';
import {mkdir, open, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as bridge from './client.mjs';

// Target discovery, element lookup, scrolling and readiness belong to the caller.
function itemValue(reply) {
  if (reply.error) throw Object.assign(new Error(reply.error), {result: reply});
  const item = reply.results?.[0] ?? reply;
  if (!['exited', 'completed'].includes(item.status) || item.error) {
    throw Object.assign(new Error(item.error || 'Screenshot browser operation failed.'), {result: reply});
  }
  if (item.value?.type === 'result_truncated') {
    throw new Error('Screenshot data was truncated. Reload Browser Bridge extension 1.0.5 or later; do not save the preview as an image.');
  }
  return item.value;
}

export function screenshotDirectory(session_id) {
  if (typeof session_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session_id)) {
    throw new Error('session_id must be the current caller session ID, using letters, digits, underscores or hyphens.');
  }
  return join(process.env.TMP || tmpdir(), `codex-${session_id}-browser-bridge`, 'screen');
}

function captureRect(scope, supplied, padding, metrics) {
  const page = metrics.page;
  const viewport = metrics.viewport;
  let rect;
  if (scope === 'full_page') rect = {...page};
  else if (scope === 'viewport') rect = {...viewport};
  else {
    if (!supplied || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(supplied[key])) || supplied.width <= 0 || supplied.height <= 0) {
      throw new Error('Supply a finite rectangle with positive width and height.');
    }
    const reference = supplied.reference ?? 'page';
    const unit = supplied.unit ?? 'css_px';
    if (!['page', 'viewport'].includes(reference) || !['css_px', 'percent', 'ratio'].includes(unit)) {
      throw new Error('Rectangle reference must be page/viewport and unit must be css_px/percent/ratio.');
    }
    const base = reference === 'page' ? page : viewport;
    const divisor = unit === 'percent' ? 100 : 1;
    const sx = unit === 'css_px' ? 1 : base.width / divisor;
    const sy = unit === 'css_px' ? 1 : base.height / divisor;
    rect = {x: base.x + supplied.x * sx, y: base.y + supplied.y * sy, width: supplied.width * sx, height: supplied.height * sy};
    if (rect.x < page.x || rect.y < page.y || rect.x + rect.width > page.x + page.width + 0.5 || rect.y + rect.height > page.y + page.height + 0.5) {
      throw new Error('The supplied rectangle extends beyond the document. Resolve its bounds before capturing.');
    }
  }
  // Padding captures existing surrounding page content and stops at page edges.
  const x = Math.max(page.x, rect.x - padding);
  const y = Math.max(page.y, rect.y - padding);
  return {x, y, width: Math.min(page.x + page.width, rect.x + rect.width + padding) - x,
    height: Math.min(page.y + page.height, rect.y + rect.height + padding) - y};
}

async function firefoxCall(target, path, args) {
  return itemValue(await bridge.webextension({...target, path, args}));
}

async function firefoxMetrics(target, nativeId) {
  const values = await firefoxCall(target, 'tabs.executeScript', [nativeId, {code: `(() => {
    const root=document.documentElement,body=document.body,v=visualViewport;
    return {page:{x:0,y:0,width:Math.max(root.scrollWidth,body?.scrollWidth??0,innerWidth),height:Math.max(root.scrollHeight,body?.scrollHeight??0,innerHeight)},
      viewport:{x:v?.pageLeft??scrollX,y:v?.pageTop??scrollY,width:v?.width??innerWidth,height:v?.height??innerHeight}};
  })()`}]);
  if (values.length !== 1) throw new Error('Expected geometry from the Firefox top document.');
  return values[0];
}

async function firefoxCapture(target, nativeId, rect, format, quality) {
  // Capture once losslessly, then encode that same bitmap. No layout or scrolling.
  const dataUrl = await firefoxCall(target, 'tabs.captureTab', [nativeId, {format: 'png', rect}]);
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('Firefox did not return a PNG screenshot.');
  const values = await firefoxCall(target, 'tabs.executeScript', [nativeId, {code: `(async () => {
    const bytes=Uint8Array.from(atob(${JSON.stringify(dataUrl.slice('data:image/png;base64,'.length))}),c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    try {
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
      ${format === 'jpeg' ? "ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);" : ''}
      ctx.drawImage(bitmap,0,0);
      const blob=await canvas.convertToBlob({type:${JSON.stringify(`image/${format}`)},quality:${quality / 100}});
      if(blob.type!==${JSON.stringify(`image/${format}`)})throw Error('Requested screenshot encoder is unavailable');
      const output=new Uint8Array(await blob.arrayBuffer());let binary='';
      for(let i=0;i<output.length;i+=32768)binary+=String.fromCharCode(...output.subarray(i,i+32768));
      return btoa(binary);
    } finally {bitmap.close();}
  })()`}]);
  if (values.length !== 1) throw new Error('Expected one encoded Firefox screenshot.');
  return values[0];
}

function imageBytes(data, format) {
  if (typeof data !== 'string' || !data.length) throw new Error('Screenshot image data is missing.');
  const bytes = Buffer.from(data, 'base64');
  const valid = format === 'webp'
    ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!valid) throw new Error('Screenshot data does not match the requested image format.');
  return bytes;
}

export function validateScreenshotOptions({session_id, scope, rect, element_rect, padding = 0, format = 'webp', quality,
  profile_id, context, tab_id, connection_id, return_image = false}) {
  screenshotDirectory(session_id);
  if (!profile_id || !['normal', 'private'].includes(context) || typeof tab_id !== 'string' || !tab_id) {
    throw new Error('Explicit profile_id, context and tab_id are required.');
  }
  if (!['full_page', 'viewport', 'element', 'rect'].includes(scope)) throw new Error('Use full_page, viewport, element or rect screenshot scope.');
  if (!['webp', 'jpeg'].includes(format)) throw new Error('Use webp or jpeg for compressed screenshots.');
  quality ??= format === 'webp' ? 100 : 90;
  if (!Number.isInteger(quality) || quality < 0 || quality > 100 || !Number.isFinite(padding) || padding < 0) {
    throw new Error('quality must be an integer 0..100 and padding must be nonnegative CSS pixels.');
  }
  if (typeof return_image !== 'boolean') throw new Error('return_image must be a boolean.');
  if (scope === 'element' || scope === 'rect') {
    const area = scope === 'element' ? element_rect : rect;
    if (!area || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(area[key])) || area.width <= 0 || area.height <= 0 ||
      !['page', 'viewport'].includes(area.reference ?? 'page') || !['css_px', 'percent', 'ratio'].includes(area.unit ?? 'css_px')) {
      throw new Error('Supply a finite rectangle with positive dimensions and valid reference/unit.');
    }
  }
  if (tab_id.startsWith('firefox-tab:')) {
    const prefix = `firefox-tab:${profile_id}:`;
    const nativeId = Number(tab_id.slice(prefix.length));
    if (!connection_id) throw new Error('Firefox screenshots require the current extension connection_id.');
    if (!tab_id.startsWith(prefix) || !Number.isSafeInteger(nativeId) || nativeId < 0) throw new Error('Firefox tab does not belong to the supplied profile.');
  }
}

export async function screenshot(options) {
  validateScreenshotOptions(options);
  const {session_id, scope, rect, element_rect, padding = 0, format = 'webp',
    quality = format === 'webp' ? 100 : 90, return_image = false,
    profile_id, context, window_id, tab_id, connection_id, service_url, timeout_ms} = options;
  const directory = screenshotDirectory(session_id);
  const target = {profile_id, context, window_id, tab_id, service_url, timeout_ms};
  const firefox = typeof tab_id === 'string' && tab_id.startsWith('firefox-tab:');
  let metrics, nativeId;
  if (firefox) {
    if (!connection_id) throw new Error('Firefox screenshots require the current extension connection_id.');
    target.connection_id = connection_id;
    const prefix = `firefox-tab:${profile_id}:`;
    nativeId = Number(tab_id.slice(prefix.length));
    if (!tab_id.startsWith(prefix) || !Number.isSafeInteger(nativeId) || nativeId < 0) throw new Error('Firefox tab does not belong to the supplied profile.');
    metrics = await firefoxMetrics(target, nativeId);
  } else {
    const raw = itemValue(await bridge.cdp({...target, commands: [{method: 'Page.getLayoutMetrics'}]}));
    const v = raw.cssVisualViewport;
    metrics = {page: raw.cssContentSize, viewport: {x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight}};
    metrics.cssToDip = raw.layoutViewport.clientWidth / raw.cssLayoutViewport.clientWidth;
  }
  const area = captureRect(scope, scope === 'element' ? element_rect : rect, padding, metrics);
  if (area.width <= 0 || area.height <= 0) throw new Error('Screenshot area is empty.');
  let data;
  if (firefox) data = await firefoxCapture(target, nativeId, area, format, quality);
  else {
    const factor = metrics.cssToDip;
    const captured = itemValue(await bridge.cdp({...target, commands: [{method: 'Page.captureScreenshot', params: {
      format, quality, fromSurface: true, captureBeyondViewport: true,
      clip: {x: area.x * factor, y: area.y * factor, width: area.width * factor, height: area.height * factor, scale: 1},
    }}]}));
    data = captured.data;
  }
  const bytes = imageBytes(data, format);
  await mkdir(directory, {recursive: true});
  const filename = `${scope}-${randomUUID()}.${format === 'jpeg' ? 'jpg' : 'webp'}`;
  const path = join(directory, filename);
  const file = await open(path, 'wx');
  try {await file.writeFile(bytes);} finally {await file.close();}
  // The caller must never receive a filename before its complete file exists.
  const saved = await stat(path);
  if (!saved.isFile() || saved.size !== bytes.length || saved.size === 0) throw new Error('Screenshot file is missing, empty or incomplete.');
  console.error(JSON.stringify({event: 'screenshot_saved', filename, bytes: saved.size, format, quality, rect_css_px: area}));
  return return_image ? {filename, image: {type: 'image', data: bytes.toString('base64'), mimeType: `image/${format}`}} : filename;
}
