/* Orpheon Eclipse Bridge 1.0.4 for MySpoti. No external dependencies.
 *
 * A pure Eclipse addon bridge: one ordered addon list, no Eclipse Cloud
 * account, login, token or subscription code. Each addon advertises its own
 * settings in its manifest and is asked in list order.
 *
 * Audio path:
 *   spotifyUri / isrc / title+artist+duration
 *     -> addon /resolve (exact when Spotify metadata exists)
 *     -> addon /stream/<id>
 *     -> MySpoti audio-source
 *   /search + strict matching is the fallback for rows without exact metadata.
 */
(function () {
  'use strict';

  var P = '[Orpheon 1.0.4] ';
  var VERSION = '1.0.4';
  var ADDONS_KEY = 'addons_v1';
  var CACHE_KEY = 'cache_v1';
  var LAST_KEY = 'last_play_v1';
  var PREFETCH_KEY = 'prefetch_v1';
  var PREFETCH_CFG_KEY = 'prefetch_cfg_v1';
  var MAX_ADDONS = 12;
  var MAX_CACHE = 120;
  var MISS_TTL = 90 * 1000;
  var DEFAULT_TTL = 5 * 60 * 1000;
  var MAX_TTL = 10 * 60 * 1000;
  var UA = 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

  var deadline = 0;
  var budgetLeft = 0;
  var queueSnapshot = null;

  function s(x) { return x == null ? '' : String(x).trim(); }
  function clean(v) { return s(v).replace(/\s+/g, ''); }
  function escapeHtml(v) {
    return s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isOk(r) { return !!(r && (r.ok === true || (Number(r.status) >= 200 && Number(r.status) < 300))); }
  function log(x) { try { myspoti.log(P + x); } catch (e) {} }
  function notify(message) { try { myspoti.notify(message); } catch (e) {} }
  function feature(x) { return !!(myspoti.features && myspoti.features.indexOf(x) >= 0); }
  function reason(type, detail) {
    if (!feature('results')) return null;
    var r = {outcome: type};
    if (detail) r.detail = s(detail).slice(0, 120);
    return r;
  }
  function jsonOf(r) {
    if (!r) return null;
    try {
      return typeof r.json === 'function' ? r.json() : (typeof r.body === 'string' ? JSON.parse(r.body) : r.body);
    } catch (e) { return null; }
  }
  function timeout(max) {
    if (!deadline) return max;
    var allowed = Math.min(max, deadline - Date.now());
    if (budgetLeft > 0) allowed = Math.min(allowed, budgetLeft);
    allowed = Math.max(1000, allowed);
    if (budgetLeft > 0) budgetLeft = Math.max(0, budgetLeft - allowed);
    return allowed;
  }
  function addonHeaders() { return {'User-Agent': UA, 'Accept': 'application/json'}; }
  function safeGet(k) { try { return myspoti.storage.get(k); } catch (e) { return undefined; } }
  function safeRemove(k) { try { myspoti.storage.remove(k); } catch (e) {} }
  function enc(v) { return encodeURIComponent(s(v)); }
  function buildQuery(params) {
    var out = [];
    if (!params) return '';
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v == null || s(v) === '') continue;
      out.push(enc(k) + '=' + enc(v));
    }
    return out.join('&');
  }
  function addonHost(url) {
    var m = /^https:\/\/([^\/?#]+)/i.exec(s(url));
    if (!m) return '';
    return m[1].toLowerCase().split(':')[0];
  }
  function trunc(v, n) { v = s(v); return v.length > n ? v.slice(0, n) : v; }

  // ---- Addon manifest and settings --------------------------------------
  function parseAddonUrl(v) {
    v = clean(v);
    if (!/^https:\/\/[^\s]+$/i.test(v)) return null;
    var hash = v.indexOf('#');
    if (hash >= 0) v = v.slice(0, hash);
    var qi = v.indexOf('?');
    var rawPath = qi >= 0 ? v.slice(0, qi) : v;
    var query = qi >= 0 ? v.slice(qi + 1) : '';
    var path = rawPath.replace(/\/+$/, '');
    if (!/\/manifest\.json$/i.test(path)) path += '/manifest.json';
    var base = path.slice(0, -'/manifest.json'.length);
    if (!/^https:\/\/[^\/]+/i.test(base)) return null;
    return {manifestUrl: path + (query ? '?' + query : ''), base: base, query: query};
  }

  function manifestCapabilities(data) {
    var caps = {search: false, resolve: false, isrc: false, stream: false};
    function add(v) {
      if (v == null) return;
      if (typeof v === 'string') {
        var k = v.toLowerCase();
        if (k.indexOf('search') >= 0) caps.search = true;
        if (k.indexOf('resolve') >= 0) caps.resolve = true;
        if (k.indexOf('isrc') >= 0) caps.isrc = true;
        if (k.indexOf('stream') >= 0) caps.stream = true;
        return;
      }
      if (typeof v !== 'object') return;
      var named = v.name || v.path || v.type || v.endpoint || v.id;
      if (named) add(named);
      for (var key in v) {
        if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
        if (key === 'name' || key === 'path' || key === 'type' || key === 'endpoint' || key === 'id') continue;
        if (v[key] === true || typeof v[key] === 'string') add(key);
      }
    }
    ['resources', 'capabilities', 'features', 'endpoints'].forEach(function (key) {
      var v = data && data[key];
      if (!v) return;
      if (typeof v === 'string') add(v);
      else if (typeof v.length === 'number') {
        for (var i = 0; i < v.length; i++) add(v[i]);
      } else if (typeof v === 'object') add(v);
    });
    ['search', 'resolve', 'isrc', 'stream'].forEach(function (key) {
      if (data && data[key] === true) caps[key] = true;
    });
    return caps;
  }

  function optionList(raw) {
    var out = [];
    if (!raw || typeof raw.length !== 'number') return out;
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i];
      if (typeof v === 'string' || typeof v === 'number') {
        out.push({value: s(v), label: s(v)});
      } else if (v && typeof v === 'object') {
        var value = s(v.value != null ? v.value : v.key);
        if (!value) continue;
        out.push({value: value, label: s(v.label || value)});
      }
    }
    return out;
  }

  function settingDef(key, raw) {
    if (!key) return null;
    raw = raw && typeof raw === 'object' ? raw : {default: raw};
    var type = s(raw.type).toLowerCase() || 'text';
    if (type === 'choice') type = 'select';
    if (type === 'boolean') type = 'toggle';
    var options = optionList(raw.options);
    var def = {
      key: s(key),
      type: type,
      label: s(raw.label) || s(key),
      help: s(raw.help || raw.description),
      default: raw.default != null ? s(raw.default) : '',
      perNetwork: raw.perNetwork === true,
      options: options
    };
    if (type === 'select') {
      if (!options.length) def.type = 'text';
      else if (!def.default || !options.some(function (o) { return o.value === def.default; })) {
        def.default = options[0].value;
      }
    } else if (type === 'toggle') {
      def.default = (raw.default === true || def.default === 'true' || def.default === '1' || def.default === 'on') ? 'true' : 'false';
    } else if (type === 'number') {
      if (raw.min != null && isFinite(Number(raw.min))) def.min = Number(raw.min);
      if (raw.max != null && isFinite(Number(raw.max))) def.max = Number(raw.max);
      if (raw.step != null && isFinite(Number(raw.step))) def.step = Number(raw.step);
    } else {
      if (raw.maxLength != null && isFinite(Number(raw.maxLength))) def.maxLength = Math.max(1, Number(raw.maxLength));
      type = 'text';
      def.type = 'text';
      if (raw.secret === true || s(raw.format).toLowerCase() === 'secret' || s(raw.type).toLowerCase() === 'secret' || s(raw.type).toLowerCase() === 'password') def.secret = true;
    }
    return def.key ? def : null;
  }

  function parseSettingDefs(raw) {
    var out = [];
    if (!raw) return out;
    if (typeof raw.length === 'number' && typeof raw !== 'string') {
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (!item || typeof item !== 'object') continue;
        var d = settingDef(s(item.key), item);
        if (d) out.push(d);
      }
    } else if (typeof raw === 'object') {
      for (var key in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
        var def = settingDef(key, raw[key]);
        if (def) out.push(def);
      }
    }
    return out;
  }

  function coerceValue(def, raw, fallback) {
    var value = raw == null ? fallback : raw;
    if (def.type === 'select') {
      var option = null;
      for (var i = 0; i < def.options.length; i++) {
        if (def.options[i].value === s(value)) { option = def.options[i].value; break; }
      }
      if (option == null) option = def.default || (def.options[0] && def.options[0].value) || '';
      return option;
    }
    if (def.type === 'toggle') {
      if (value === true || s(value) === 'true' || s(value) === '1' || s(value) === 'on') return 'true';
      if (value === false || s(value) === 'false' || s(value) === '0' || s(value) === 'off') return 'false';
      return def.default === 'true' ? 'true' : 'false';
    }
    if (def.type === 'number') {
      var n = Number(value);
      if (!isFinite(n)) n = Number(def.default);
      if (!isFinite(n)) n = 0;
      if (def.min != null && n < def.min) n = def.min;
      if (def.max != null && n > def.max) n = def.max;
      return String(n);
    }
    var text = s(value);
    if (def.maxLength) text = text.slice(0, def.maxLength);
    return text;
  }

  function normalizeValues(defs, values) {
    var out = {};
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      var raw = values && Object.prototype.hasOwnProperty.call(values, def.key) ? values[def.key] : undefined;
      out[def.key] = coerceValue(def, raw, def.default);
    }
    return out;
  }

  function defaultsFor(defs) {
    var out = {};
    for (var i = 0; i < defs.length; i++) out[defs[i].key] = coerceValue(defs[i], undefined, defs[i].default);
    return out;
  }

  function settingQuery(addon) {
    var parts = [];
    var defs = addon.settings || [];
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      var value = addon.values && Object.prototype.hasOwnProperty.call(addon.values, def.key)
        ? coerceValue(def, addon.values[def.key], def.default)
        : coerceValue(def, undefined, def.default);
      if (value !== '') parts.push(enc(def.key) + '=' + enc(value));
    }
    return parts.join('&');
  }

  function addonEndpoint(addon, path, params) {
    var query = [];
    if (addon.query) query.push(addon.query);
    var settings = settingQuery(addon);
    if (settings) query.push(settings);
    var encoded = buildQuery(params || {});
    if (encoded) query.push(encoded);
    return addon.base + path + (query.length ? '?' + query.join('&') : '');
  }

  function addonSupports(addon, name) {
    var list = addon.resources || [];
    for (var i = 0; i < list.length; i++) {
      if (s(list[i]).toLowerCase().indexOf(name) >= 0) return true;
    }
    return false;
  }

  function resourceText(addon) {
    var out = [];
    ['search', 'resolve', 'isrc', 'stream'].forEach(function (r) {
      if (addonSupports(addon, r)) out.push(r);
    });
    return out.join(', ') || 'stream';
  }

  function manifestName(data) {
    return s(data && (data.name || data.addonName || data.title)) || 'Eclipse addon';
  }

  function normalizeStoredAddon(item) {
    if (!item || typeof item !== 'object') return null;
    var parsed = parseAddonUrl(item.url);
    if (!parsed) return null;
    var defs = parseSettingDefs(item.settings);
    return {
      url: parsed.manifestUrl,
      base: parsed.base,
      query: parsed.query,
      name: s(item.name) || 'Eclipse addon',
      version: s(item.version),
      resources: Array.isArray(item.resources) ? item.resources.map(s) : [],
      settings: defs,
      values: normalizeValues(defs, item.values),
      enabled: item.enabled !== false,
      lastTest: item.lastTest && typeof item.lastTest === 'object' ? item.lastTest : null,
      addedAt: Number(item.addedAt) || Date.now()
    };
  }

  function prefetchConfig() {
    var v = safeGet(PREFETCH_CFG_KEY);
    var enabled = !(v && v.enabled === false);
    var count = v && Number(v.count);
    if (!isFinite(count) || count < 1) count = 2;
    if (count > 3) count = 3;
    return {enabled: enabled, count: count};
  }

  function loadAddons() {
    var raw = safeGet(ADDONS_KEY);
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var addon = normalizeStoredAddon(raw[i]);
      if (addon) out.push(addon);
    }
    return out;
  }

  function saveAddons(list, clear) {
    try {
      myspoti.storage.set(ADDONS_KEY, list);
    } catch (e) {
      log('storage: could not save addon list');
      return false;
    }
    if (clear !== false) clearCache();
    return true;
  }

  function enabledAddons() {
    var list = loadAddons(), out = [];
    for (var i = 0; i < list.length; i++) if (list[i].enabled) out.push(list[i]);
    return out;
  }

  function addonStamp(list) {
    var parts = [VERSION];
    for (var i = 0; i < list.length; i++) {
      parts.push(list[i].url + '|' + (list[i].enabled ? '1' : '0') + '|' + JSON.stringify(list[i].values || {}));
    }
    return parts.join('\n');
  }

  function fetchManifest(parsed, max, stage) {
    var started = Date.now();
    var r = getJson(parsed.manifestUrl, max, stage + '-manifest');
    if (!r.ok) return {error: r.error, status: r.status, code: r.error};
    var caps = manifestCapabilities(r.data);
    if (!caps.stream || !(caps.resolve || caps.search || caps.isrc)) {
      return {error: 'invalid-manifest', status: r.status, capabilities: caps};
    }
    return {
      ok: true,
      status: r.status,
      latencyMs: Date.now() - started,
      data: r.data,
      capabilities: caps,
      settings: parseSettingDefs(r.data.settings),
      name: manifestName(r.data),
      version: s(r.data.version)
    };
  }

  // ---- HTTP -------------------------------------------------------------
  function getJson(url, max, stage) {
    try {
      var r = myspoti.http.get(url, {headers: addonHeaders(), timeout: timeout(max)});
      if (!r || r.error) { log(stage + ': network'); return {error: 'network', status: 0}; }
      var status = Number(r.status) || 0;
      if (!isOk(r)) { log(stage + ': HTTP ' + status); return {error: 'http-' + status, status: status}; }
      var data = jsonOf(r);
      if (!data || typeof data !== 'object') { log(stage + ': invalid JSON'); return {error: 'invalid-json', status: status}; }
      return {ok: true, status: status, data: data};
    } catch (e) {
      log(stage + ': network');
      return {error: 'network', status: 0};
    }
  }

  // ---- Track matching ---------------------------------------------------
  function norm(v) {
    return s(v).toLowerCase().replace(/&/g, ' and ')
      .replace(/[áàâãä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
      .replace(/[óòôõö]/g, 'o').replace(/[úùûü]/g, 'u').replace(/ç/g, 'c')
      .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function artistName(a) {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') return s(a.name || a.title);
    if (a && typeof a.length === 'number' && a[0]) return artistName(a[0]);
    return '';
  }
  function markers(v) {
    var n = norm(v), out = [];
    ['live', 'remix', 'instrumental', 'acoustic', 'sped up', 'slowed'].forEach(function (m) {
      if (new RegExp('\\b' + m + '\\b').test(n)) out.push(m);
    });
    return out.join(',');
  }
  function baseTitle(v) {
    return norm(v).replace(/\b(remix|live|instrumental|acoustic|version|edit|mix)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function strongArtist(a, b) {
    var x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var A = x.split(' '), B = y.split(' ');
    var short = A.length <= B.length ? A : B;
    var long = short === A ? B : A;
    for (var i = 0; i < short.length; i++) if (long.indexOf(short[i]) < 0) return false;
    return true;
  }
  function matching(t, item) {
    if (!item || typeof item !== 'object') return {ok: false, why: 'invalid item'};
    var a = s(t.isrc).toUpperCase(), b = s(item.isrc).toUpperCase();
    if (a && b) return {ok: a === b, why: a === b ? 'ISRC confirmed' : 'ISRC mismatch', isrc: a === b};
    var title = norm(t.title), got = norm(item.title || item.name);
    if (!title || !got) return {ok: false, why: 'missing title'};
    if (title !== got) {
      var tb = baseTitle(t.title), gb = baseTitle(item.title || item.name);
      if (!tb || tb !== gb) return {ok: false, why: 'title mismatch'};
      if (markers(t.title) !== markers(item.title || item.name)) return {ok: false, why: 'version mismatch'};
    }
    var src = norm(t.artist), dst = norm(artistName(item.artist) || artistName(item.artists));
    if (!src || !dst || !strongArtist(t.artist, artistName(item.artist) || artistName(item.artists))) {
      return {ok: false, why: 'artist mismatch'};
    }
    var d1 = Number(t.durationMs);
    var d2 = Number(item.durationMs || (Number(item.duration) > 0 ? Number(item.duration) * 1000 : 0));
    if (d1 > 0 && d2 > 0 && Math.abs(d1 - d2) > 15000) return {ok: false, why: 'duration mismatch'};
    return {ok: true, why: 'matching metadata', isrc: false};
  }

  function searchItems(data) {
    if (!data) return [];
    if (typeof data.length === 'number' && typeof data !== 'string') return data;
    var keys = ['items', 'results', 'tracks', 'songs'];
    for (var i = 0; i < keys.length; i++) {
      if (data[keys[i]] && typeof data[keys[i]].length === 'number') return data[keys[i]];
    }
    if (data.data && typeof data.data === 'object') return searchItems(data.data);
    if (data.result && typeof data.result === 'object') return searchItems(data.result);
    return [];
  }

  function matchSearch(t, data) {
    var items = searchItems(data);
    for (var i = 0; i < items.length; i++) {
      var it = items[i] && items[i].track && typeof items[i].track === 'object' ? items[i].track : items[i];
      if (!it || typeof it !== 'object') continue;
      var id = s(it.id || it.trackId);
      if (!id) continue;
      var m = matching(t, it);
      if (!m.ok) continue;
      return {id: id, matchedBy: m.isrc ? 'isrc' : 'metadata'};
    }
    return null;
  }

  function resolveItem(data) {
    var d = data || {};
    if (d.item === null || d.found === false) return null;
    var it = d.item || d.track || (d.result && d.result.item) || d.result || d;
    if (!it || typeof it !== 'object') {
      if (d.data && typeof d.data === 'object') return resolveItem(d.data);
      return null;
    }
    var id = s(it.id || it.trackId || d.trackId);
    if (!id) {
      if (d.data && typeof d.data === 'object') return resolveItem(d.data);
      return null;
    }
    return {id: id, item: it};
  }

  function parseResolve(data, t, exact) {
    var found = resolveItem(data);
    if (!found) return null;
    if (exact) return {id: found.id, matchedBy: s(t.isrc) ? 'isrc' : 'spotify'};
    var m = matching(t, found.item);
    if (!m.ok) { log('search: reject ' + m.why); return null; }
    return {id: found.id, matchedBy: m.isrc ? 'isrc' : 'metadata'};
  }

  function simplifiedTitle(title) {
    var v = s(title)
      .replace(/\s*[\(\[].*?[\)\]]/g, ' ')
      .replace(/\s+-\s+.*$/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return v.length >= 3 ? v : '';
  }

  function requestParams(t) {
    var p = {title: s(t.title), artist: s(t.artist)};
    if (Number(t.durationMs) > 0) p.durationMs = Number(t.durationMs);
    if (s(t.isrc)) p.isrc = s(t.isrc).toUpperCase();
    var uri = spotifyUriFor(t);
    if (uri) p.spotifyUri = uri;
    return p;
  }

  function spotifyUriFor(t) {
    var uri = s(t && t.uri);
    if (/^spotify:track:[A-Za-z0-9]+$/.test(uri)) return uri;
    var id = s(t && t.id);
    if (/^[A-Za-z0-9]{10,}$/.test(id)) return 'spotify:track:' + id;
    return '';
  }

  // ---- Stream parsing ---------------------------------------------------
  function safeHeaders(r) {
    if (!r.headers || typeof r.headers !== 'object') return null;
    var safe = {}, allow = ['authorization', 'referer', 'user-agent', 'origin'];
    for (var k in r.headers) {
      if (!Object.prototype.hasOwnProperty.call(r.headers, k)) continue;
      if (allow.indexOf(k.toLowerCase()) >= 0) safe[k] = s(r.headers[k]);
    }
    return Object.keys(safe).length ? safe : null;
  }

  function streamObject(payload) {
    var o = payload;
    for (var i = 0; i < 3; i++) {
      if (!o || typeof o !== 'object') break;
      if (typeof o.url === 'string' || typeof o.streamURL === 'string' || typeof o.streamUrl === 'string') break;
      if (o.data && typeof o.data === 'object') o = o.data;
      else if (o.stream && typeof o.stream === 'object') o = o.stream;
      else if (o.audio && typeof o.audio === 'object') o = o.audio;
      else if (o.result && typeof o.result === 'object') o = o.result;
      else break;
    }
    return o;
  }

  function normalizeCodec(v) {
    v = s(v).toLowerCase();
    if (!v) return '';
    if (v.indexOf('flac') >= 0) return 'flac';
    if (v.indexOf('mp3') >= 0 || v.indexOf('mpeg') >= 0) return 'mp3';
    if (v.indexOf('m4a') >= 0 || v.indexOf('aac') >= 0 || v.indexOf('mp4') >= 0) return 'm4a';
    if (v.indexOf('opus') >= 0) return 'opus';
    var tail = v.split('/').pop();
    return tail.slice(0, 16);
  }

  function mimeFor(codec) {
    if (codec === 'flac') return 'audio/flac';
    if (codec === 'mp3') return 'audio/mpeg';
    if (codec === 'm4a') return 'audio/mp4';
    if (codec === 'opus') return 'audio/ogg';
    return '';
  }

  function publicHttps(v) {
    if (!/^https:\/\/[a-z0-9.-]+\/(?:[^\s"<>]*)$/i.test(s(v))) return false;
    var host = s(v).replace(/^https:\/\//i, '').split('/')[0].toLowerCase();
    if (host.charAt(0) === '[' || host === 'localhost' || host === '127.0.0.1') return false;
    if (host.indexOf(':') >= 0) host = host.split(':')[0];
    if (/\.localhost$|\.local$/.test(host)) return false;
    if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
    return true;
  }

  function expiryOf(r) {
    var now = Date.now();
    var ms = Number(r.expiresInMs);
    if (isFinite(ms) && ms < 0) return {expiresInMs: 0, expired: true};
    if (isFinite(ms) && ms === 0) return {expiresInMs: 0, expired: false};
    if (isFinite(ms) && ms > 0) return {expiresInMs: Math.min(MAX_TTL, Math.floor(ms)), expired: false};
    var at = Number(r.expiresAt);
    if (isFinite(at) && at > 0) {
      var when = at < 1e12 ? at * 1000 : at;
      if (when <= now) return {expiresInMs: 0, expired: true};
      return {expiresInMs: Math.min(MAX_TTL, Math.max(0, when - now - 3000)), expired: false};
    }
    return {expiresInMs: DEFAULT_TTL, expired: false};
  }

  function toAudio(payload, addon) {
    var r = streamObject(payload);
    if (!r || typeof r !== 'object') return null;
    if (r.encrypted === true || r.isEncrypted === true || !!r.drm || !!r.drmInfo || !!r.licenseUrl || !!r.licenseURL) {
      log('stream: DRM refused');
      return null;
    }
    var manifest = s(r.manifest);
    if (/^(hls|dash)$/i.test(manifest)) { log('stream: segmented audio unsupported'); return null; }
    if (manifest && !/^https?:\/\//i.test(manifest)) {
      if (!feature('audio.manifest')) { log('stream: manifest unsupported by this MySpoti'); return null; }
      var m = {manifest: manifest, mimeType: 'audio/mp4'};
      return m;
    }
    var url = s(r.url || r.streamURL || r.streamUrl);
    if (!publicHttps(url)) { log('stream: no public HTTPS URL'); return null; }
    var codec = normalizeCodec(r.codec || r.format);
    if (!codec && /\.flac(?:\?|$)/i.test(url)) codec = 'flac';
    if (!codec && /\.mp3(?:\?|$)/i.test(url)) codec = 'mp3';
    if (!codec && /\.(?:m4a|mp4)(?:\?|$)/i.test(url)) codec = 'm4a';
    if (codec === 'hls' || codec === 'dash') { log('stream: segmented audio unsupported'); return null; }
    var ex = expiryOf(r);
    if (ex.expired) { log('stream: URL expired'); return null; }
    var out = {url: url};
    if (codec) out.codec = codec;
    var mime = mimeFor(codec);
    if (mime) out.mimeType = mime;
    var bit = Number(r.bitDepth), hz = Number(r.sampleRate);
    if (bit >= 8 && bit <= 32) out.bitDepth = bit;
    if (hz >= 8000 && hz <= 768000) out.sampleRate = hz;
    var headers = safeHeaders(r);
    if (headers) out.headers = headers;
    if (ex.expiresInMs === 0) out.expiresInMs = 0;
    else if (ex.expiresInMs > 0) out.expiresInMs = ex.expiresInMs;
    if (!out.bitDepth && !out.sampleRate) {
      out.source = trunc((addon.name || 'Addon') + ' · ' + (codec ? codec.toUpperCase() : 'audio'), 80);
    }
    return out;
  }

  function streamAddon(addon, id, matchedBy) {
    var urls = [
      addonEndpoint(addon, '/stream/' + encodeURIComponent(s(id)), {}),
      addonEndpoint(addon, '/stream', {trackId: s(id)})
    ];
    var last = null;
    for (var i = 0; i < urls.length; i++) {
      var r = getJson(urls[i], 5000, 'stream');
      if (!r.ok) {
        last = r;
        if (r.error === 'http-429' || r.error === 'http-401' || r.error === 'http-403') break;
        continue;
      }
      var audio = toAudio(r.data, addon);
      if (audio) return {audio: audio, matchedBy: matchedBy, route: matchedBy === 'metadata' ? 'search' : 'resolve'};
      last = {error: 'unsupported', status: r.status};
    }
    return {error: last ? last.error : 'no-audio', status: last ? last.status : 0};
  }

  function searchAddon(t, addon) {
    var attempts = [];
    var title = s(t.title), artist = s(t.artist);
    attempts.push((title + ' ' + artist).trim());
    var simple = simplifiedTitle(title);
    if (simple && simple !== title) attempts.push((simple + ' ' + artist).trim());
    var last = null;
    for (var i = 0; i < attempts.length; i++) {
      if (!attempts[i]) continue;
      var r = getJson(addonEndpoint(addon, '/search', {q: attempts[i]}), 2600, 'search');
      if (!r.ok) {
        last = r;
        if (r.error === 'http-429' || r.error === 'http-401' || r.error === 'http-403') return {error: r.error, status: r.status};
        continue;
      }
      var found = matchSearch(t, r.data);
      if (found) return {found: found};
    }
    return {error: last ? last.error : 'no-match', status: last ? last.status : 0};
  }

  function tryAddon(t, addon, exactOnly) {
    var exact = !!(spotifyUriFor(t) || s(t.isrc));
    var found = null;
    var last = null;

    if (addonSupports(addon, 'resolve')) {
      var r = getJson(addonEndpoint(addon, '/resolve', requestParams(t)), 4500, 'resolve');
      if (!r.ok) last = r;
      else {
        found = parseResolve(r.data, t, exact);
        if (!found) last = {error: 'no-match', status: r.status};
      }
    }

    if (!found && s(t.isrc) && addonSupports(addon, 'isrc')) {
      var ri = getJson(addonEndpoint(addon, '/resolve-isrc', {isrc: s(t.isrc).toUpperCase()}), 2600, 'resolve-isrc');
      if (!ri.ok) last = ri;
      else {
        found = parseResolve(ri.data, t, true);
        if (!found) last = {error: 'no-match', status: ri.status};
      }
    }

    if (!found && !exactOnly && addonSupports(addon, 'search')) {
      var sr = searchAddon(t, addon);
      if (sr.found) found = sr.found;
      else if (sr.error === 'http-429' || sr.error === 'http-401' || sr.error === 'http-403') last = sr;
      else if (!last) last = sr;
    }

    if (!found) {
      if (last && last.error === 'http-429') return {error: 'rate-limited', retryAfterMs: 60000, status: 429};
      if (last && (last.error === 'http-401' || last.error === 'http-403')) return {error: 'forbidden', status: last.status};
      if (last && last.error === 'network') return {error: 'network'};
      return {error: 'not-found', status: last ? last.status : 0};
    }

    return streamAddon(addon, found.id, found.matchedBy);
  }

  // ---- Cache ------------------------------------------------------------
  function loadCache() {
    try {
      var v = myspoti.storage.get(CACHE_KEY);
      if (v && typeof v === 'object' && v.tracks && typeof v.tracks === 'object') {
        if (!v.misses || typeof v.misses !== 'object') v.misses = {};
        return v;
      }
    } catch (e) {}
    return {tracks: {}, misses: {}};
  }
  function pruneCache(cache, max) {
    var now = Date.now(), k;
    for (k in cache.misses) {
      if (!Object.prototype.hasOwnProperty.call(cache.misses, k)) continue;
      var m = cache.misses[k];
      if (!m || now - Number(m.t || 0) > MISS_TTL) delete cache.misses[k];
    }
    for (k in cache.tracks) {
      if (!Object.prototype.hasOwnProperty.call(cache.tracks, k)) continue;
      var e = cache.tracks[k];
      if (!e || Number(e.exp || 0) <= now) delete cache.tracks[k];
    }
    trimCache(cache.tracks, max);
    trimCache(cache.misses, max);
  }
  function trimCache(obj, max) {
    var keys = Object.keys(obj);
    if (keys.length <= max) return;
    keys.sort(function (a, b) { return Number(obj[a] && obj[a].t || 0) - Number(obj[b] && obj[b].t || 0); });
    for (var i = 0; i < keys.length - max; i++) delete obj[keys[i]];
  }
  function saveCache(cache) {
    try { pruneCache(cache, MAX_CACHE); } catch (e) { cache = {tracks: {}, misses: {}}; }
    var sizes = [MAX_CACHE, 20, 5];
    for (var i = 0; i < sizes.length; i++) {
      if (i) pruneCache(cache, sizes[i]);
      try { myspoti.storage.set(CACHE_KEY, cache); return true; } catch (e) {}
    }
    safeRemove(CACHE_KEY);
    log('cache: storage full; dropped');
    return false;
  }
  function clearCache() { safeRemove(CACHE_KEY); pushLive(); }

  function readCached(key, stamp) {
    var cache = loadCache();
    var e = cache.tracks[key];
    if (!e || e.stamp !== stamp) return null;
    if (Number(e.exp || 0) <= Date.now()) {
      delete cache.tracks[key];
      saveCache(cache);
      return null;
    }
    return e;
  }
  function writeCached(key, stamp, result) {
    var audio = result.audio || {};
    var raw = Number(audio.expiresInMs);
    if (isFinite(raw) && raw === 0) return;
    if (isFinite(raw) && raw > 0 && raw <= 8000) return;
    var ttl = isFinite(raw) && raw > 0 ? Math.min(MAX_TTL, raw - 3000) : DEFAULT_TTL;
    if (ttl < 5000) return;
    var cache = loadCache();
    cache.tracks[key] = {
      t: Date.now(),
      exp: Date.now() + ttl,
      stamp: stamp,
      audio: audio,
      addon: result.addon,
      matchedBy: result.matchedBy,
      route: result.route
    };
    delete cache.misses[key];
    saveCache(cache);
  }
  function readMiss(key, stamp) {
    var cache = loadCache();
    var m = cache.misses[key];
    if (!m || m.stamp !== stamp) return false;
    if (Date.now() - Number(m.t || 0) > MISS_TTL) {
      delete cache.misses[key];
      saveCache(cache);
      return false;
    }
    return true;
  }
  function rememberMiss(key, stamp) {
    var cache = loadCache();
    delete cache.tracks[key];
    cache.misses[key] = {t: Date.now(), stamp: stamp};
    saveCache(cache);
  }
  function cacheInfo() {
    var cache = loadCache(), now = Date.now(), count = 0, newest = 0;
    for (var k in cache.tracks) {
      if (!Object.prototype.hasOwnProperty.call(cache.tracks, k)) continue;
      var e = cache.tracks[k];
      if (e && Number(e.exp || 0) > now) {
        count++;
        newest = Math.max(newest, Number(e.t || 0));
      }
    }
    return {tracks: count, lastAt: newest || null};
  }

  function liveState() {
    return {
      lastPlay: safeGet(LAST_KEY) || null,
      prefetch: safeGet(PREFETCH_KEY) || null,
      prefetchConfig: prefetchConfig(),
      cache: cacheInfo()
    };
  }

  function pushLive() {
    try {
      if (myspoti.page && typeof myspoti.page.post === 'function') myspoti.page.post({live: liveState()});
    } catch (e) {}
  }

  function trackKey(t) {
    var uri = spotifyUriFor(t);
    if (uri) return uri.toLowerCase();
    if (s(t && t.isrc)) return 'isrc:' + s(t.isrc).toUpperCase();
    return 'meta:' + norm(t && t.title) + '|' + norm(t && t.artist) + '|' + Math.round(Number(t && t.durationMs) || 0);
  }

  function rememberLast(data) {
    data.at = Date.now();
    try { myspoti.storage.set(LAST_KEY, data); } catch (e) {}
    pushLive();
  }

  function rememberPrefetch(data) {
    data.at = Date.now();
    try { myspoti.storage.set(PREFETCH_KEY, data); } catch (e) {}
    pushLive();
  }

  // ---- Resolve ----------------------------------------------------------
  function load(t, options) {
    options = options || {};
    var prefetch = options.prefetch === true;
    var ahead = options.ahead === true;
    var started = Date.now();
    var budget = Number(options.budget) > 0 ? Number(options.budget) : (ahead ? 12000 : 14000);
    deadline = started + budget;
    budgetLeft = budget;
    var list = enabledAddons();
    if (!list.length) return {error: 'config'};
    var key = trackKey(t);
    var stamp = addonStamp(list);
    var cached = readCached(key, stamp);
    if (cached) {
      if (!prefetch) rememberLast({title: s(t.title), artist: s(t.artist), addon: cached.addon, route: cached.route, cache: 'hit', ms: 0});
      return {audio: cached.audio, cache: 'hit', addon: cached.addon, matchedBy: cached.matchedBy, route: cached.route, ms: 0};
    }
    if (readMiss(key, stamp)) return {error: 'not-found', cache: 'hit'};

    var failures = [], anyNetwork = false, anyRate = false, anyForbidden = false;
    for (var i = 0; i < list.length; i++) {
      if (budgetLeft <= 0) { anyNetwork = true; break; }
      var r = tryAddon(t, list[i], ahead || prefetch);
      if (r.audio) {
        var result = {
          audio: r.audio,
          addon: list[i].name || 'Eclipse addon',
          matchedBy: r.matchedBy || 'metadata',
          route: r.route || 'resolve',
          cache: 'miss',
          ms: Date.now() - started
        };
        writeCached(key, stamp, result);
        if (!prefetch) rememberLast({title: s(t.title), artist: s(t.artist), addon: result.addon, route: result.route, cache: 'miss', ms: result.ms});
        log((prefetch ? 'prefetched ' : 'served by ') + result.addon + ' route=' + result.route + ' took=' + result.ms + 'ms');
        return result;
      }
      failures.push((list[i].name || 'addon') + ':' + r.error);
      if (r.error === 'network') anyNetwork = true;
      if (r.error === 'rate-limited') anyRate = true;
      if (r.error === 'forbidden') anyForbidden = true;
    }
    if (!prefetch && !ahead) log('no audio: ' + failures.join(', '));
    if (anyRate) return {error: 'rate-limited', retryAfterMs: 60000};
    if (anyNetwork) return {error: 'network'};
    if (anyForbidden) return {error: 'forbidden'};
    if (!ahead && !prefetch) rememberMiss(key, stamp);
    return {error: 'not-found'};
  }

  // The playback event gives Orpheon a queue snapshot. MySpoti's Web Player queue
  // can lag behind the local player, so the snapshot is used only when the current
  // track is found in it; it is then advanced by URI as local playback moves on.
  function queueTrack(item) {
    if (!item || typeof item !== 'object') return null;
    if (s(item.kind) && s(item.kind).toUpperCase() !== 'TRACK') return null;
    var uri = s(item.uri);
    if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) return null;
    var title = s(item.name);
    if (!title) return null;
    var t = {
      uri: uri,
      title: title,
      artist: artistName(item.artists),
      artists: item.artists,
      durationMs: Number(item.durationMs) || 0
    };
    if (item.album && item.album.name) t.album = s(item.album.name);
    return t;
  }

  function queueList(q) {
    var items = [];
    if (!q) return items;
    if (q.current) items.push(q.current);
    if (q.queued && q.queued.length) items = items.concat(q.queued);
    if (q.nextUp && q.nextUp.length) items = items.concat(q.nextUp);
    var out = [], seen = {};
    for (var i = 0; i < items.length; i++) {
      var uri = s(items[i] && items[i].uri);
      if (!uri || seen[uri]) continue;
      seen[uri] = 1;
      out.push(items[i]);
    }
    return out;
  }

  function queueSnapshotFor(e) {
    if (!e || e.shuffle === true) return null;
    var currentUri = s(e.track && e.track.uri);
    var contextUri = s(e.contextUri);
    if (!currentUri) return null;
    if (queueSnapshot && queueSnapshot.contextUri === contextUri &&
        Date.now() - queueSnapshot.at < 20 * 60 * 1000) {
      for (var j = 0; j < queueSnapshot.tracks.length; j++) {
        if (s(queueSnapshot.tracks[j].uri) === currentUri) return queueSnapshot;
      }
    }
    if (!myspoti.spotify || !myspoti.spotify.player || typeof myspoti.spotify.player.queue !== 'function') return null;
    // The queue can belong to the previous engine context. If the player state
    // names a different context, do not warm the wrong songs.
    try {
      var st = myspoti.spotify.player.state();
      var stCtx = s(st && st.contextUri);
      if (stCtx && contextUri && stCtx !== contextUri) { log('prefetch: context changed'); return null; }
    } catch (stateError) {}
    var q = null;
    try { q = myspoti.spotify.player.queue(); }
    catch (err) { log('prefetch: queue unavailable'); return null; }
    var tracks = queueList(q);
    var at = -1;
    for (var i = 0; i < tracks.length; i++) {
      if (s(tracks[i].uri) === currentUri) { at = i; break; }
    }
    if (at < 0) {
      log('prefetch: current track not in queue');
      queueSnapshot = null;
      return null;
    }
    queueSnapshot = {contextUri: contextUri, tracks: tracks.slice(at), at: Date.now()};
    return queueSnapshot;
  }

  function prefetchUpcoming(limit, e) {
    var list = enabledAddons();
    if (!list.length) return;
    var snap = queueSnapshotFor(e);
    if (!snap) { rememberPrefetch({warmed: 0, total: 0, reason: 'queue hidden'}); return; }
    var currentUri = s(e.track && e.track.uri);
    var at = -1;
    for (var i = 0; i < snap.tracks.length; i++) {
      if (s(snap.tracks[i].uri) === currentUri) { at = i; break; }
    }
    if (at < 0) { queueSnapshot = null; return; }
    var tracks = [];
    for (var j = at + 1; j < snap.tracks.length && tracks.length < limit; j++) {
      var t = queueTrack(snap.tracks[j]);
      if (t) tracks.push(t);
    }
    if (!tracks.length) { log('prefetch: no upcoming tracks'); rememberPrefetch({warmed: 0, total: 0, reason: 'no upcoming'}); return; }
    var started = Date.now();
    var end = started + 2000;
    var stamp = addonStamp(list);
    var warmed = 0;
    for (var k = 0; k < tracks.length; k++) {
      var left = end - Date.now();
      if (left < 900) break;
      var key = trackKey(tracks[k]);
      if (readCached(key, stamp) || readMiss(key, stamp)) continue;
      var r = load(tracks[k], {prefetch: true, budget: left});
      if (r.audio) warmed++;
    }
    rememberPrefetch({warmed: warmed, total: tracks.length, reason: ''});
    log('prefetch: ' + warmed + '/' + tracks.length + ' warmed in ' + (Date.now() - started) + 'ms');
  }

  function failureOutcome(r) {
    if (!r) return reason('not-found');
    if (r.error === 'config') return reason('not-found', 'No addon enabled. Open Orpheon and add one.');
    if (r.error === 'rate-limited') {
      var limited = reason('rate-limited', 'An addon is rate-limited; try again shortly.');
      if (limited) limited.retryAfterMs = Number(r.retryAfterMs) || 60000;
      return limited;
    }
    if (r.error === 'forbidden') return reason('error', 'An addon rejected the request (HTTP 401/403). Open Orpheon and test it.');
    if (r.error === 'network') return reason('network', 'No addon answered in time.');
    return reason('not-found', 'No enabled addon had this track.');
  }

  // ---- Hooks ------------------------------------------------------------
  myspoti.provide('audio-source', function (t) {
    var r = load(t || {}, {ahead: !!(t && t.ahead)});
    if (r.audio) return r.audio;
    log('result: ' + (r.error || 'no-audio'));
    return failureOutcome(r);
  });

  myspoti.provide('download-source', function (t) {
    var r = load(t || {});
    if (!r.audio) {
      log('download: ' + (r.error || 'no-audio'));
      return failureOutcome(r);
    }
    var provider = trunc(r.addon || 'Eclipse addon', 40);
    var matched = r.matchedBy === 'isrc';
    if (r.audio.manifest) {
      return [{manifest: r.audio.manifest, format: 'dash-flac', provider: provider, isrcMatched: matched}];
    }
    var codec = normalizeCodec(r.audio.codec);
    var format = codec === 'mp3' ? 'mp3' : (codec === 'm4a' ? 'm4a' : 'flac');
    var file = {url: r.audio.url, format: format, provider: provider, isrcMatched: matched};
    if (r.audio.headers) file.headers = r.audio.headers;
    if (r.audio.bitDepth) file.bitDepth = r.audio.bitDepth;
    if (r.audio.sampleRate) file.sampleRate = r.audio.sampleRate;
    return [file];
  });

  myspoti.on('playback', function (e) {
    if (!e || e.type !== 'start') return;
    if (s(e.origin) !== 'audio-source') return;
    var provider = s(e.providerId);
    var self = s(myspoti.extension && myspoti.extension.id);
    if (provider && self && provider !== self) return;
    var cfg = prefetchConfig();
    if (!cfg.enabled) return;
    try { prefetchUpcoming(cfg.count, e); }
    catch (err) { log('prefetch: failed'); }
  });

  // ---- Page -------------------------------------------------------------
  function ago(ms) {
    if (!ms) return '';
    var diff = Math.max(0, Date.now() - Number(ms));
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    return Math.floor(diff / 86400000) + ' d ago';
  }

  function pageState() {
    var list = loadAddons(), addons = [], enabled = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.enabled) enabled++;
      addons.push({
        index: i,
        name: a.name,
        version: a.version,
        host: addonHost(a.url),
        enabled: a.enabled,
        resources: a.resources || [],
        resourceText: resourceText(a),
        settings: a.settings || [],
        values: a.values || {},
        lastTest: a.lastTest || null,
        addedAt: a.addedAt || 0
      });
    }
    return {
      version: VERSION,
      addons: addons,
      enabledCount: enabled,
      lastPlay: safeGet(LAST_KEY) || null,
      prefetch: safeGet(PREFETCH_KEY) || null,
      prefetchConfig: prefetchConfig(),
      cache: cacheInfo()
    };
  }

  function pageReply(message, ok) {
    return {ok: ok !== false, message: s(message), state: pageState()};
  }

  function manifestError(res) {
    if (!res) return 'Addon manifest could not be read.';
    if (res.error === 'network') return 'Addon manifest timed out. Check the address and that the addon is online.';
    if (res.error === 'invalid-manifest') return 'Manifest is missing the stream resource or a search/resolve/isrc route.';
    if (res.error === 'invalid-json') return 'Manifest is not valid JSON.';
    if (res.error === 'http-401' || res.error === 'http-403') return 'The addon rejected the manifest request (HTTP ' + res.status + '). Check its token or access.';
    if (res.error === 'http-404') return 'Manifest not found (HTTP 404). Check the addon URL.';
    if (res.error && res.error.indexOf('http-') === 0) return 'Manifest request failed (HTTP ' + res.status + ').';
    return 'Addon manifest could not be read.';
  }

  function probeUrl(addon) {
    if (addonSupports(addon, 'resolve')) {
      return addonEndpoint(addon, '/resolve', {title: 'Connection Test', artist: 'Test', durationMs: 1000});
    }
    if (addonSupports(addon, 'search')) return addonEndpoint(addon, '/search', {q: 'connection test'});
    if (addonSupports(addon, 'isrc')) return addonEndpoint(addon, '/resolve-isrc', {isrc: 'USUM71700001'});
    return addon.url;
  }

  function testAddonMessage(msg) {
    var list = loadAddons();
    var index = Number(msg && msg.index);
    if (!isFinite(index) || index < 0 || index >= list.length) return pageReply('Addon not found.', false);
    var addon = list[index];
    deadline = Date.now() + 2600;
    budgetLeft = 2600;
    var started = Date.now();
    var parsed = parseAddonUrl(addon.url);
    var manifest = parsed ? fetchManifest(parsed, 1100, 'test') : {error: 'invalid-url'};
    if (!manifest.ok) {
      var failed = {ok: false, at: Date.now(), ms: Date.now() - started, status: manifest.status || 0, message: manifestError(manifest)};
      addon.lastTest = failed;
      saveAddons(list, false);
      return pageReply(failed.message, false);
    }
    var probeAddon = {
      base: addon.base,
      query: addon.query,
      name: manifest.name,
      resources: ['stream'].concat(
        manifest.capabilities.search ? ['search'] : [],
        manifest.capabilities.resolve ? ['resolve'] : [],
        manifest.capabilities.isrc ? ['isrc'] : []
      ),
      settings: manifest.settings,
      values: normalizeValues(manifest.settings, addon.values)
    };
    var probe = getJson(probeUrl(probeAddon), 1000, 'probe');
    var ok = probe.ok === true;
    var last = {
      ok: ok,
      at: Date.now(),
      ms: Date.now() - started,
      status: probe.status || 0,
      manifestStatus: manifest.status,
      message: ok ? 'Reachable' : (probe.error === 'network' ? 'No answer' : 'HTTP ' + (probe.status || 0))
    };
    addon.lastTest = last;
    saveAddons(list, false);
    log('test addon ' + index + ': HTTP ' + (probe.status || 0) + ' ok=' + ok);
    return pageReply(
      ok ? 'Reachable · HTTP ' + probe.status + ' · ' + last.ms + ' ms' : 'Test failed · ' + last.message,
      ok
    );
  }

  function addAddonMessage(msg) {
    var parsed = parseAddonUrl(msg && msg.url);
    if (!parsed) return pageReply('Enter a complete HTTPS addon manifest URL.', false);
    var list = loadAddons();
    if (list.length >= MAX_ADDONS) return pageReply('The addon list is full (max ' + MAX_ADDONS + ').', false);
    for (var i = 0; i < list.length; i++) {
      if (list[i].base === parsed.base) return pageReply('That addon is already in the list.', false);
    }
    deadline = Date.now() + 2800;
    budgetLeft = 2800;
    var manifest = fetchManifest(parsed, 2200, 'add');
    if (!manifest.ok) return pageReply(manifestError(manifest), false);
    var addon = {
      url: parsed.manifestUrl,
      base: parsed.base,
      query: parsed.query,
      name: manifest.name,
      version: manifest.version,
      resources: ['stream'].concat(
        manifest.capabilities.search ? ['search'] : [],
        manifest.capabilities.resolve ? ['resolve'] : [],
        manifest.capabilities.isrc ? ['isrc'] : []
      ),
      settings: manifest.settings,
      values: defaultsFor(manifest.settings),
      enabled: true,
      lastTest: {ok: true, at: Date.now(), ms: manifest.latencyMs, status: manifest.status, manifestStatus: manifest.status, message: 'Manifest loaded'},
      addedAt: Date.now()
    };
    list.push(addon);
    if (!saveAddons(list, true)) return pageReply('Could not save the addon list.', false);
    log('addon added: ' + addon.name + ' routes=' + addon.resources.join(','));
    return pageReply('Added ' + addon.name + ' · ' + resourceText(addon) + '.', true);
  }

  function removeAddonMessage(msg) {
    var list = loadAddons();
    var index = Number(msg && msg.index);
    if (!isFinite(index) || index < 0 || index >= list.length) return pageReply('Addon not found.', false);
    var name = list[index].name;
    list.splice(index, 1);
    if (!saveAddons(list, true)) return pageReply('Could not save the addon list.', false);
    log('addon removed: ' + name);
    return pageReply('Removed ' + name + '.', true);
  }

  function moveAddonMessage(msg) {
    var list = loadAddons();
    var index = Number(msg && msg.index);
    if (!isFinite(index) || index < 0 || index >= list.length) return pageReply('Addon not found.', false);
    var target = -1;
    if (msg && msg.to != null) target = Number(msg.to);
    else {
      var direction = s(msg && msg.direction).toLowerCase();
      if (direction === 'up') target = index - 1;
      else if (direction === 'down') target = index + 1;
    }
    if (!isFinite(target) || target < 0 || target >= list.length) return pageReply('Cannot move it further.', false);
    var item = list[index];
    list[index] = list[target];
    list[target] = item;
    if (!saveAddons(list, true)) return pageReply('Could not save the addon order.', false);
    log('addon moved ' + index + ' to ' + target);
    return pageReply('Order saved.', true);
  }

  function toggleAddonMessage(msg) {
    var list = loadAddons();
    var index = Number(msg && msg.index);
    if (!isFinite(index) || index < 0 || index >= list.length) return pageReply('Addon not found.', false);
    list[index].enabled = !!(msg && msg.enabled);
    if (!saveAddons(list, true)) return pageReply('Could not save the addon state.', false);
    log('addon ' + index + ' enabled=' + list[index].enabled);
    return pageReply(list[index].name + (list[index].enabled ? ' enabled.' : ' disabled.'), true);
  }

  function saveSettingsMessage(msg) {
    var list = loadAddons();
    var index = Number(msg && msg.index);
    if (!isFinite(index) || index < 0 || index >= list.length) return pageReply('Addon not found.', false);
    var addon = list[index];
    var values = msg && msg.values && typeof msg.values === 'object' ? msg.values : {};
    addon.values = normalizeValues(addon.settings, values);
    if (!saveAddons(list, true)) return pageReply('Could not save the settings.', false);
    log('settings saved for addon ' + index);
    return pageReply('Saved settings for ' + addon.name + '.', true);
  }

  function refreshAddonMessage(msg) {
    var list = loadAddons();
    var index = Number(msg && msg.index);
    if (!isFinite(index) || index < 0 || index >= list.length) return pageReply('Addon not found.', false);
    var addon = list[index];
    var parsed = parseAddonUrl(addon.url);
    if (!parsed) return pageReply('Invalid addon URL.', false);
    deadline = Date.now() + 2800;
    budgetLeft = 2800;
    var manifest = fetchManifest(parsed, 2200, 'refresh');
    if (!manifest.ok) return pageReply(manifestError(manifest), false);
    addon.name = manifest.name;
    addon.version = manifest.version;
    addon.resources = ['stream'].concat(
      manifest.capabilities.search ? ['search'] : [],
      manifest.capabilities.resolve ? ['resolve'] : [],
      manifest.capabilities.isrc ? ['isrc'] : []
    );
    addon.settings = manifest.settings;
    addon.values = normalizeValues(manifest.settings, addon.values);
    addon.lastTest = {ok: true, at: Date.now(), ms: manifest.latencyMs, status: manifest.status, manifestStatus: manifest.status, message: 'Manifest reloaded'};
    if (!saveAddons(list, true)) return pageReply('Could not save the addon.', false);
    log('addon refreshed: ' + addon.name);
    return pageReply('Reloaded ' + addon.name + ' · ' + resourceText(addon) + '.', true);
  }

  function savePrefetchMessage(msg) {
    var count = Number(msg && msg.count);
    if (!isFinite(count)) count = 2;
    count = Math.max(0, Math.min(3, Math.round(count)));
    var enabled = count > 0;
    try {
      myspoti.storage.set(PREFETCH_CFG_KEY, {enabled: enabled, count: enabled ? count : 2});
    } catch (e) {
      return pageReply('Could not save the prefetch setting.', false);
    }
    log('prefetch settings: ' + (enabled ? count : 'off'));
    pushLive();
    return pageReply(enabled ? 'Prefetch ' + count + ' upcoming song' + (count === 1 ? '' : 's') + '.' : 'Prefetch off.', true);
  }

  function pageMessage(input) {
    var msg = input;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (e) { msg = {}; }
    }
    if (!msg || typeof msg !== 'object') msg = {};
    var action = s(msg.action), reply;
    if (action === 'state') reply = pageReply('', true);
    else if (action === 'add') reply = addAddonMessage(msg);
    else if (action === 'remove') reply = removeAddonMessage(msg);
    else if (action === 'move') reply = moveAddonMessage(msg);
    else if (action === 'toggle') reply = toggleAddonMessage(msg);
    else if (action === 'test') reply = testAddonMessage(msg);
    else if (action === 'save_settings') reply = saveSettingsMessage(msg);
    else if (action === 'refresh') reply = refreshAddonMessage(msg);
    else if (action === 'clear_cache') {
      clearCache();
      reply = pageReply('Resolve cache cleared.', true);
    } else if (action === 'live') {
      reply = {ok: true, live: liveState()};
    } else if (action === 'save_prefetch') {
      reply = savePrefetchMessage(msg);
    } else reply = pageReply('Unknown action.', false);
    return reply;
  }

  function pageHtml() {
    var css = [
      ':root{--bg:#0d0f13;--panel:#15181f;--line:#252a34;--line2:#333a47;--text:#e8ebf1;--muted:#8b93a2;--muted2:#727b8a;--accent:#7aa2f7;--ok:#71c99a;--danger:#e58383;--r:12px}',
      '*{box-sizing:border-box}html{background:var(--bg);-webkit-text-size-adjust:100%}',
      'body{margin:0;padding:0 0 calc(340px + env(safe-area-inset-bottom,0px));background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
      '.wrap{max-width:560px;margin:0 auto;padding:26px 18px 0}',
      'header{padding-bottom:20px;border-bottom:1px solid var(--line)}',
      'h1{margin:0;font-size:26px;font-weight:650;letter-spacing:-.025em}',
      '.sub{margin:4px 0 0;font-size:13px;color:var(--muted)}',
      'section{margin-top:26px}',
      'h2{margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}h2 span{color:var(--muted2);font-weight:400;letter-spacing:0;text-transform:none;margin-left:5px}',
      '.add{display:flex;gap:8px}',
      'input,select{width:100%;min-height:44px;padding:0 12px;border:1px solid var(--line2);border-radius:10px;background:#101319;color:var(--text);font:inherit;font-size:14px}',
      'input::placeholder{color:#606978}input:focus,select:focus{outline:none;border-color:var(--accent)}',
      '.add input{flex:1;min-width:0}',
      'button{font:inherit}',
      '.btn{min-height:44px;padding:0 16px;border-radius:10px;border:1px solid transparent;background:var(--accent);color:#0a0f18;font-weight:600;font-size:14px;cursor:pointer}.btn:disabled{opacity:.5}',
      '.tbtn{background:none;border:0;padding:8px 5px;color:var(--accent);font-size:13px;font-weight:500;cursor:pointer}.tbtn.danger{color:var(--danger)}.tbtn.muted{color:var(--muted)}.tbtn:disabled{opacity:.35;cursor:default}',
      '.notice{margin-top:12px;padding:10px 12px;border:1px solid var(--line2);border-radius:10px;font-size:13px;color:var(--muted)}.notice.ok{color:var(--ok);border-color:rgba(113,201,154,.35)}.notice.err{color:var(--danger);border-color:rgba(229,131,131,.35)}',
      '.addon{padding:14px 0;border-bottom:1px solid var(--line)}.addon:last-child{border-bottom:0}.addon.off{opacity:.5}',
      '.addon-head{display:flex;align-items:flex-start;gap:10px}',
      '.num{width:20px;flex:0 0 20px;color:var(--muted2);font-size:12px;line-height:22px}',
      '.addon-main{flex:1;min-width:0}.addon-name{font-size:15px;font-weight:600}.addon-ver{font-size:11px;color:var(--muted2);margin-left:6px;font-weight:400}',
      '.addon-sub{font-size:12px;color:var(--muted2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.switch{position:relative;width:40px;height:24px;flex:0 0 40px;margin-top:2px}.switch input{position:absolute;opacity:0;width:0;height:0}.switch span{position:absolute;inset:0;border-radius:99px;background:#2a303b;transition:.15s}.switch span:after{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:#98a1af;transition:.15s}.switch input:checked+span{background:rgba(122,162,247,.35)}.switch input:checked+span:after{transform:translateX(16px);background:var(--accent)}',
      '.status{font-size:12px;margin-top:8px;color:var(--muted2)}.status.ok{color:var(--ok)}.status.err{color:var(--danger)}',
      '.actions{display:flex;align-items:center;gap:2px;margin-top:8px}.actions .grow{flex:1}',
      '.settings{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}',
      '.field{margin-top:12px}.field:first-child{margin-top:0}.field label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:5px}.field .help{font-size:11.5px;color:var(--muted2);margin:4px 0 0;line-height:1.4}',
      '.check{display:flex;align-items:center;gap:10px;min-height:44px}.check input{width:20px;min-height:20px;height:20px;padding:0;accent-color:var(--accent)}.check span{font-size:13.5px}',
      '.now{padding:14px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel)}.now-title{font-size:15px;font-weight:600}.now-sub{font-size:12.5px;color:var(--muted);margin-top:2px}.now-meta{font-size:11.5px;color:var(--muted2);margin-top:6px;min-height:16px}',
      '.rows{margin-top:4px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:13.5px;color:var(--muted)}.row:last-child{border-bottom:0}.row b{font-weight:500;color:var(--text);text-align:right}.row select{width:auto;min-width:128px;min-height:38px;font-size:13px}',
      '.note{font-size:11.5px;color:var(--muted2);line-height:1.5;margin:8px 0 0}.empty{color:var(--muted2);font-size:13px;margin:14px 0}',
      'footer{margin-top:30px;padding:16px 0;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted2)}',
      '.tail{height:160px}[hidden]{display:none!important}'
    ].join('');
    var h = [];
    h.push('<!doctype html><html><head><meta charset="utf-8">');
    h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    h.push('<title>Orpheon</title><style>' + css + '</style></head><body><div class="wrap">');
    h.push('<header><h1>Orpheon</h1><p class="sub">Eclipse addon bridge</p></header>');

    h.push('<section><h2>Addons <span id="addonCount">0</span></h2>');
    h.push('<div class="add"><input id="addonUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Addon manifest URL" aria-label="Addon manifest URL"><button type="button" class="btn" id="addAddon">Add</button></div>');
    h.push('<div id="pageStatus" class="notice" role="status" aria-live="polite" hidden></div>');
    h.push('<div id="addonList"><p class="empty">Loading addons…</p></div></section>');

    h.push('<section><h2>Playback</h2>');
    h.push('<div class="now"><div class="now-title" id="nowTitle">Nothing played yet</div><div class="now-sub" id="nowSub">Play a song to see which addon served it.</div><div class="now-meta" id="nowMeta"></div></div>');
    h.push('<div class="rows"><div class="row"><span>Resolve cache</span><b id="cacheCount">0 tracks</b></div>');
    h.push('<div class="row"><span>Prefetch</span><b id="prefetchState">Waiting for a song</b></div>');
    h.push('<div class="row"><span>Last cache write</span><b id="cacheLast">—</b></div></div>');
    h.push('<button type="button" class="tbtn" id="clearCache">Clear resolve cache</button>');
    h.push('<p class="note">The cache is local metadata: the addon\'s stream address, not audio. Audio still streams from the addon\'s CDN.</p></section>');

    h.push('<section><h2>Prefetch</h2><div class="row"><span>Upcoming songs</span><select id="prefetchCount"><option value="0">Off</option><option value="1">Next 1</option><option value="2">Next 2</option><option value="3">Next 3</option></select></div>');
    h.push('<p class="note">Uses MySpoti\'s queue when it is available. Shuffled queues are skipped; MySpoti still prefetches the immediate next song.</p></section>');

    h.push('<footer>v' + escapeHtml(VERSION) + ' · No Eclipse Cloud account or login</footer>');
    h.push('<div class="tail" aria-hidden="true"></div></div>');

    var js = [
      '(function(){var latest=null,openSettings={},confirmRemove={};',
      'function byId(id){return document.getElementById(id);}',
      'function mk(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e;}',
      'function clear(node){while(node.firstChild)node.removeChild(node.firstChild);}',
      'function setText(id,text){var e=byId(id);if(e)e.textContent=text==null?"":String(text);}',
      'function post(obj){try{MyspotiPage.postMessage(JSON.stringify(obj));}catch(e){show("Could not contact the extension.",false);}}',
      'function show(message,ok){var box=byId("pageStatus");if(!box)return;if(!message){box.hidden=true;box.textContent="";return;}box.hidden=false;box.className="notice "+(ok===true?"ok":(ok===false?"err":""));box.textContent=message;}',
      'function ago(ms){if(!ms)return "never";var d=Math.max(0,Date.now()-Number(ms));if(d<60000)return "just now";if(d<3600000)return Math.floor(d/60000)+" min ago";if(d<86400000)return Math.floor(d/3600000)+" h ago";return Math.floor(d/86400000)+" d ago";}',
      'function healthText(t){if(!t)return {text:"Not tested",cls:""};if(t.ok===true)return {text:"Reachable · HTTP "+(t.status||200)+" · "+(t.ms||0)+" ms · "+ago(t.at),cls:"ok"};return {text:(t.message||"Test failed")+(t.status?" (HTTP "+t.status+")":"")+" · "+ago(t.at),cls:"err"};}',
      'function actionBtn(label,op,index,cls){var b=mk("button","tbtn"+(cls?" "+cls:""),label);b.type="button";b.setAttribute("data-op",op);b.setAttribute("data-index",String(index));return b;}',
      'function settingField(def,val){var box=mk("div","field");box.appendChild(mk("label",null,def.label||def.key));var control;if(def.type==="select"){control=document.createElement("select");var opts=def.options||[];for(var oi=0;oi<opts.length;oi++){var op=document.createElement("option");op.value=opts[oi].value;op.textContent=opts[oi].label||opts[oi].value;if(opts[oi].value===val)op.selected=true;control.appendChild(op);}}else if(def.type==="toggle"){var wrap=mk("label","check");control=document.createElement("input");control.type="checkbox";control.checked=val===true||val==="true";var lab=mk("span",null,control.checked?"On":"Off");control.onchange=function(){lab.textContent=this.checked?"On":"Off";};control.setAttribute("data-key",def.key);wrap.appendChild(control);wrap.appendChild(lab);box.appendChild(wrap);if(def.help)box.appendChild(mk("p","help",def.help));return box;}else{control=document.createElement("input");control.type=def.secret?"password":(def.type==="number"?"number":"text");if(def.type==="number"){if(def.min!=null)control.min=String(def.min);if(def.max!=null)control.max=String(def.max);if(def.step!=null)control.step=String(def.step);}if(def.maxLength)control.maxLength=def.maxLength;control.value=val==null?"":String(val);}control.setAttribute("data-key",def.key);box.appendChild(control);if(def.help)box.appendChild(mk("p","help",def.help));return box;}',
      'function addonCard(a){var card=mk("div","addon"+(a.enabled?"":" off"));var head=mk("div","addon-head");head.appendChild(mk("span","num",String(a.index+1)));var main=mk("div","addon-main");var name=mk("div","addon-name",a.name||"Eclipse addon");if(a.version)name.appendChild(mk("span","addon-ver","v"+a.version));main.appendChild(name);main.appendChild(mk("div","addon-sub",(a.host||"addon")+" · "+(a.resourceText||"stream")));head.appendChild(main);var sw=mk("label","switch");var cb=document.createElement("input");cb.type="checkbox";cb.checked=!!a.enabled;cb.setAttribute("data-toggle","1");cb.setAttribute("data-index",String(a.index));sw.appendChild(cb);sw.appendChild(mk("span"));head.appendChild(sw);card.appendChild(head);var h=healthText(a.lastTest);card.appendChild(mk("div","status"+(h.cls?" "+h.cls:""),h.text));var actions=mk("div","actions");actions.appendChild(actionBtn("Test","test",a.index));actions.appendChild(actionBtn(openSettings[a.index]?"Hide":"Settings","settings",a.index));actions.appendChild(mk("span","grow"));var up=actionBtn("↑","up",a.index,"muted");up.disabled=a.index===0;actions.appendChild(up);var down=actionBtn("↓","down",a.index,"muted");down.disabled=latest&&latest.addons&&a.index===latest.addons.length-1;actions.appendChild(down);actions.appendChild(actionBtn(confirmRemove[a.index]?"Tap again":"Remove","remove",a.index,"danger"));card.appendChild(actions);var panel=mk("div","settings");panel.setAttribute("data-panel",String(a.index));panel.hidden=!openSettings[a.index];var defs=a.settings||[];if(defs.length){for(var si=0;si<defs.length;si++){var def=defs[si];var val=a.values&&a.values[def.key]!=null?a.values[def.key]:def.default;panel.appendChild(settingField(def,val));}panel.appendChild(actionBtn("Save addon settings","saveSettings",a.index));panel.appendChild(actionBtn("Reload manifest","refresh",a.index,"muted"));}else{panel.appendChild(mk("p","note","This addon has no settings in its manifest."));}card.appendChild(panel);return card;}',
      'function renderAddons(s){var box=byId("addonList");if(!box)return;clear(box);var list=s.addons||[];if(!list.length){box.appendChild(mk("p","empty","No addons yet. Paste a manifest URL above to add the first one."));return;}for(var i=0;i<list.length;i++)box.appendChild(addonCard(list[i]));}',
      'function renderLive(s){s=s||{};var lp=s.lastPlay;if(lp&&lp.title){setText("nowTitle",lp.title);setText("nowSub",(lp.artist||"")+(lp.addon?" · "+lp.addon:""));setText("nowMeta",[(lp.route||"resolve"),(lp.cache||"miss"),(lp.ms?lp.ms+" ms":""),ago(lp.at)].filter(Boolean).join(" · "));}else{setText("nowTitle","Nothing played yet");setText("nowSub","Play a song to see which addon served it.");setText("nowMeta","");}var cache=s.cache||{};setText("cacheCount",(cache.tracks||0)+" tracks");setText("cacheLast",cache.lastAt?ago(cache.lastAt):"—");var cfg=s.prefetchConfig||{enabled:true,count:2};var pf=s.prefetch;if(!cfg.enabled)setText("prefetchState","Off");else if(pf&&pf.total)setText("prefetchState",pf.warmed+"/"+pf.total+" warmed · "+ago(pf.at));else if(pf&&pf.reason==="queue hidden")setText("prefetchState","Queue hidden · "+ago(pf.at));else if(pf)setText("prefetchState","No upcoming · "+ago(pf.at));else setText("prefetchState","Waiting for a song");var sel=byId("prefetchCount");if(sel&&document.activeElement!==sel)sel.value=String(cfg.enabled?cfg.count:0);}',
      'function renderState(s){latest=s||{};confirmRemove={};setText("addonCount",String((s.addons||[]).length));renderAddons(s);renderLive(s);}',
      'function settingValues(index){var panel=document.querySelector(".settings[data-panel=\\""+index+"\\"]");var values={};if(!panel)return values;var inputs=panel.querySelectorAll("[data-key]");for(var i=0;i<inputs.length;i++){var el=inputs[i],key=el.getAttribute("data-key");if(!key)continue;values[key]=el.type==="checkbox"?el.checked:el.value;}return values;}',
      'function closestOp(el){while(el&&el!==document){if(el.getAttribute&&el.getAttribute("data-op"))return el;el=el.parentNode;}return null;}',
      'var listBox=byId("addonList");listBox.addEventListener("click",function(e){var b=closestOp(e.target);if(!b)return;var op=b.getAttribute("data-op"),idx=Number(b.getAttribute("data-index"));if(op==="settings"){openSettings[idx]=!openSettings[idx];var panel=document.querySelector(".settings[data-panel=\\""+idx+"\\"]");if(panel)panel.hidden=!openSettings[idx];b.textContent=openSettings[idx]?"Hide":"Settings";return;}if(op==="remove"){if(!confirmRemove[idx]){confirmRemove[idx]=1;b.textContent="Tap again";return;}post({action:"remove",index:idx});return;}if(op==="saveSettings"){post({action:"save_settings",index:idx,values:settingValues(idx)});show("Saving settings…",null);return;}if(op==="refresh"){post({action:"refresh",index:idx});show("Reloading manifest…",null);return;}if(op==="test"){post({action:"test",index:idx});show("Testing addon…",null);return;}if(op==="up"||op==="down"){post({action:"move",index:idx,direction:op});return;}});',
      'listBox.addEventListener("change",function(e){var t=e.target;if(!t||!t.getAttribute)return;if(t.getAttribute("data-toggle"))post({action:"toggle",index:Number(t.getAttribute("data-index")),enabled:!!t.checked});});',
      'byId("addAddon").onclick=function(){var input=byId("addonUrl"),url=input?input.value:"";if(!url){show("Paste an addon manifest URL first.",false);return;}this.disabled=true;post({action:"add",url:url});show("Checking addon manifest…",null);};',
      'byId("clearCache").onclick=function(){post({action:"clear_cache"});show("Clearing resolve cache…",null);};',
      'byId("prefetchCount").onchange=function(){post({action:"save_prefetch",count:Number(this.value)});show(Number(this.value)?"Saving prefetch…":"Turning prefetch off…",null);};',
      'window.addEventListener("message",function(e){var d=e.data;if(typeof d==="string"){try{d=JSON.parse(d);}catch(err){return;}}if(!d||typeof d!=="object")return;if(d.state)renderState(d.state);else if(d.live)renderLive(d.live);if(d.message)show(d.message,d.ok===true);else if(d.ok===false&&!d.message)show("Action failed.",false);if(d.state||d.message){var add=byId("addAddon");if(add)add.disabled=false;}if(d.ok===true&&d.message&&d.message.indexOf("Added ")===0){var input=byId("addonUrl");if(input)input.value="";}});',
      'setInterval(function(){post({action:"live"});},5000);',
      'post({action:"state"});})();'
    ].join('');
    h.push('<script>' + js + '</script></body></html>');
    return h.join('');
  }

  myspoti.provide('page', function () {
    return {title: 'Orpheon', html: pageHtml()};
  });

  myspoti.provide('message', function (input) {
    try {
      return pageMessage(input);
    } catch (e) {
      log('page: ' + (e && e.message ? e.message : 'failed'));
      return pageReply('The page action failed. Check the extension log.', false);
    }
  });

  log('loaded: version ' + VERSION);
})();
