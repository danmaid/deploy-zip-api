// Patch: download via fetch (visible in DevTools Network) without opening new window.
(function () {
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const baseUrlEl = $('baseUrl');

  function now() { return new Date().toISOString(); }
  function log(msg) {
    logEl.textContent += `[${now()}] ${msg}
`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function origin() { return window.location.origin; }
  function getBase() {
    return '/v1/deploy';
  }

  function setCurlSamples() {
    const b = getBase();
    $('curlUpload').textContent = `curl -L -X POST --data-binary @sharepoint.zip ${b}/content`;
    $('curlDownload').textContent = [
      `curl -L -o content.zip ${b}/content`,
      `curl -s ${b}/archive`,
      `curl -L -o archive-<id>.zip ${b}/archive/<id>`
    ].join('\n');

    $('linkDocs').href = `${b}/docs`;
    $('linkYaml').href = `${b}/openapi.yaml`;
    $('linkJson').href = `${b}/openapi.json`;
    $('linkHealth').href = `${b}/healthz`;
  }

  async function downloadViaFetch(url, filename) {
    log(`FETCH download: ${url}`);
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 30_000);
  }

  $('btnUseCurrent').addEventListener('click', () => {
    baseUrlEl.value = origin();
    setCurlSamples();
    log(`Base URL set to ${getBase()}`);
  });

  baseUrlEl.value = origin();
  setCurlSamples();
  baseUrlEl.addEventListener('change', setCurlSamples);

  $('btnDownloadContent').addEventListener('click', async () => {
    try {
      await downloadViaFetch(`${getBase()}/content`, `content-${Date.now()}.zip`);
    } catch (e) {
      log(`ERROR: ${e}`);
      alert(String(e));
    }
  });

  $('btnRefresh').addEventListener('click', async () => {
    const status = $('listStatus');
    status.textContent = 'loading...';
    status.className = 'status';
    try {
      const url = `${getBase()}/archive`;
      log(`GET ${url}`);
      const res = await fetch(url, { method: 'GET' });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
      const data = JSON.parse(txt);
      renderArchiveRows(data.archives || []);
      status.textContent = `ok (${(data.archives || []).length})`;
      status.classList.add('ok');
    } catch (e) {
      status.textContent = String(e);
      status.classList.add('bad');
      log(`ERROR: ${e}`);
    }
  });

  function renderArchiveRows(archives) {
    const tbody = $('archiveRows');
    tbody.innerHTML = '';
    for (const a of archives) {
      const tr = document.createElement('tr');
      const tdId = document.createElement('td');
      tdId.textContent = a.id;
      const tdMt = document.createElement('td');
      tdMt.textContent = a.mtime;
      const tdDl = document.createElement('td');

      const btn = document.createElement('button');
      btn.textContent = 'download zip';
      btn.addEventListener('click', async () => {
        try {
          await downloadViaFetch(`${getBase()}/archive/${encodeURIComponent(a.id)}`, `archive-${a.id}.zip`);
        } catch (e) {
          log(`ERROR: ${e}`);
          alert(String(e));
        }
      });
      tdDl.appendChild(btn);

      tr.appendChild(tdId);
      tr.appendChild(tdMt);
      tr.appendChild(tdDl);
      tbody.appendChild(tr);
    }
  }

  $('btnUpload').addEventListener('click', async () => {
    const f = $('file').files && $('file').files[0];
    const status = $('uploadStatus');
    status.textContent = '';
    status.className = 'status';

    if (!f) {
      status.textContent = 'ZIPファイルを選択してください';
      status.classList.add('bad');
      return;
    }

    try {
      const url = `${getBase()}/content`;
      status.textContent = 'uploading...';
      log(`POST ${url} (${f.name}, ${f.size} bytes)`);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f
      });

      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
      const data = JSON.parse(txt);
      status.textContent = `ok: id=${data.id}`;
      status.classList.add('ok');
      log(`OK: ${txt}`);

      $('btnRefresh').click();

    } catch (e) {
      status.textContent = String(e);
      status.classList.add('bad');
      log(`ERROR: ${e}`);
    }
  });

  $('btnRefresh').click();
})();
