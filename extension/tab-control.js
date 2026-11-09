"use strict";

(function install(root) {
  function create(tabs, storage, prefix) {
    function native(id) {
      if (typeof id !== 'string' || !/^chrome-tab:\d+$/.test(id)) throw new Error('An exact tab ID is required.');
      return Number(id.slice(prefix.length));
    }
    function webUrl(value) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) page URL.');
      return url.href;
    }
    return {
      nativeRefreshSupported: true,
      async run(request) {
        const id = native(request.target_tab_id);
        const tab = await tabs.get(id);
        if (!['normal', 'private'].includes(request.context) || tab.incognito !== (request.context === 'private')) throw new Error('Window privacy context mismatch.');
        if (request.window_id !== undefined && tab.windowId !== request.window_id) throw new Error('Window selection mismatch.');
        if (request.action === 'open') {
          const created = await tabs.create({url: webUrl(request.url), active: false, windowId: tab.windowId});
          return {tab_id: prefix + created.id, window_id: created.windowId, incognito: created.incognito};
        }
        if (request.action === 'navigate') {
          await tabs.update(id, {url: webUrl(request.url)});
          return {tab_id: prefix + id, navigated: true};
        }
        if (request.action === 'reload') {
          await tabs.reload(id, {bypassCache: false});
          return {tab_id: prefix + id, reloaded: true};
        }
        if (request.action === 'close') {
          const window = await chrome.windows.get(tab.windowId);
          if (tab.active && window.focused && request.allow_foreground !== true) throw new Error('Closing the foreground tab requires explicit foreground permission.');
          await tabs.remove(id);
          return {tab_id: prefix + id, closed: true};
        }
        if (request.action === 'activate') {
          if (request.allow_foreground !== true) throw new Error('Activating a tab requires explicit foreground permission.');
          await tabs.update(id, {active: true});
          await chrome.windows.update(tab.windowId, {focused: true});
          return {tab_id: prefix + id, activated: true};
        }
        throw new Error('Unknown tab-control action.');
      },
    };
  }
  root.LocalBridgeTabControl = Object.freeze({create});
})(globalThis);
