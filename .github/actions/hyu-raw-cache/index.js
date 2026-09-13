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
  else throw new Error('unsupported operation');
})().catch(err => {
  log({operation: op, error_class: err && err.name ? err.name : 'Error'});
  process.exitCode = 1;
});
