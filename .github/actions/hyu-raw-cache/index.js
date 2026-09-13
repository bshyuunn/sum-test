const crypto = require('crypto');

const op = process.env.INPUT_OPERATION;
const key = process.env.INPUT_KEY;
const version = process.env.INPUT_VERSION;
const marker = process.env.INPUT_MARKER || '';
const expectedHash = process.env['INPUT_EXPECTED-HASH'] || '';
const base = process.env.ACTIONS_CACHE_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;

function log(fields) {
  const rendered = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(' ');
  console.log(`[hyu-raw-cache] ${rendered}`);
}
async function request(url, init = {}, auth = true) {
  const headers = {...(init.headers || {})};
  if (auth) headers.Authorization = `Bearer ${token}`;
  headers.Accept = 'application/json;api-version=6.0-preview.1';
  return fetch(url, {...init, headers, redirect: 'follow'});
}
async function save() {
  if (!base || !token) {
    log({operation: 'save', capability_present: false});
    return;
  }
  const reserve = await request(`${base}_apis/artifactcache/caches`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({key, version})
  });
  let data = {};
  try { data = await reserve.json(); } catch {}
  const id = data.cacheId;
  log({operation: 'save', reserve_status: reserve.status, cache_id_present: Boolean(id)});
  if (!id) return;
  const body = Buffer.from(marker, 'utf8');
  const upload = await request(`${base}_apis/artifactcache/caches/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes 0-${body.length - 1}/*`
    },
    body
  });
  log({operation: 'save', upload_status: upload.status});
  if (!upload.ok) return;
  const commit = await request(`${base}_apis/artifactcache/caches/${id}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({size: body.length})
  });
  log({operation: 'save', commit_status: commit.status});
}
async function twirp(method, data) {
  const results = process.env.ACTIONS_RESULTS_URL;
  if (!results || !token) return {present: false};
  const url = new URL(`/twirp/github.actions.results.api.v1.CacheService/${method}`, results);
  const response = await request(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  return {present: true, response, body};
}
async function saveV2() {
  const created = await twirp('CreateCacheEntry', {key, version});
  if (!created.present) {
    log({operation: 'save-v2', capability_present: false});
    return;
  }
  const signed = created.body.signed_upload_url || created.body.signedUploadUrl;
  const denied = typeof created.body.message === 'string' && created.body.message.startsWith('cache write denied:');
  log({operation: 'save-v2', create_status: created.response.status, ok: Boolean(created.body.ok), signed_url_present: Boolean(signed), policy_denied: denied});
  if (!created.response.ok || !created.body.ok || !signed) return;
  const payload = Buffer.from(marker, 'utf8');
  const upload = await fetch(signed, {
    method: 'PUT',
    headers: {'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream'},
    body: payload
  });
  log({operation: 'save-v2', upload_status: upload.status});
  if (!upload.ok) return;
  const finalized = await twirp('FinalizeCacheEntryUpload', {key, version, size_bytes: String(payload.length)});
  const finalDenied = typeof finalized.body.message === 'string' && finalized.body.message.startsWith('cache write denied:');
  log({operation: 'save-v2', finalize_status: finalized.response.status, ok: Boolean(finalized.body.ok), policy_denied: finalDenied});
}
async function restoreV2() {
  const found = await twirp('GetCacheEntryDownloadURL', {key, version, restore_keys: []});
  if (!found.present) {
    log({operation: 'restore-v2', capability_present: false});
    return;
  }
  const signed = found.body.signed_download_url || found.body.signedDownloadUrl;
  const denied = typeof found.body.message === 'string' && found.body.message.startsWith('cache read denied:');
  log({operation: 'restore-v2', lookup_status: found.response.status, ok: Boolean(found.body.ok), hit: Boolean(signed), policy_denied: denied});
  if (!found.response.ok || !found.body.ok || !signed) return;
  const archive = await request(signed, {}, false);
  const body = Buffer.from(await archive.arrayBuffer());
  const actualHash = crypto.createHash('sha256').update(body).digest('hex');
  log({operation: 'restore-v2', download_status: archive.status, bytes: body.length, hash_match: expectedHash ? actualHash === expectedHash : 'unchecked', sha256: actualHash});
}
async function restore() {
  if (!base || !token) {
    log({operation: 'restore', capability_present: false});
    return;
  }
  const lookup = await request(`${base}_apis/artifactcache/cache?keys=${encodeURIComponent(key)}&version=${encodeURIComponent(version)}`);
  let data = {};
  try { data = await lookup.json(); } catch {}
  log({operation: 'restore', lookup_status: lookup.status, hit: Boolean(data.archiveLocation)});
  if (!data.archiveLocation) return;
  const archive = await request(data.archiveLocation, {}, false);
  const body = Buffer.from(await archive.arrayBuffer());
  const actualHash = crypto.createHash('sha256').update(body).digest('hex');
  log({operation: 'restore', download_status: archive.status, bytes: body.length, hash_match: expectedHash ? actualHash === expectedHash : 'unchecked', sha256: actualHash});
}
(async () => {
  if (op === 'save') await save();
  else if (op === 'restore') await restore();
  else if (op === 'save-v2') await saveV2();
  else if (op === 'restore-v2') await restoreV2();
  else throw new Error('unsupported operation');
})().catch(err => {
  log({operation: op, error_class: err && err.name ? err.name : 'Error'});
  process.exitCode = 1;
});
