(() => {
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const pipeSvg = $('pipe');
  const FONT = "system-ui, -apple-system, Segoe UI, Roboto, 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif";

  function log(msg){
    logEl.textContent += `[${new Date().toISOString()}] ${msg}
`;
    logEl.scrollTop = logEl.scrollHeight;
  }
  function origin(){ return window.location.origin; }
  function base(){ const v = $('baseUrl').value.trim(); return v ? v.replace(/\/$/, '') : origin(); }

  function b64urlToBytes(b64url){
    const b64 = b64url.replace(/-/g,'+').replace(/_/g,'/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function decodePlan(b64url){
    const bytes = b64urlToBytes(b64url);
    const json = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(json);
  }

  function parseServerTimingHeader(header){
    const items = header.split(',').map(s=>s.trim()).filter(Boolean);
    return items.map(it => {
      const parts = it.split(';').map(s=>s.trim());
      const name = parts[0];
      let dur = 0;
      let desc = '';
      for(const p of parts.slice(1)){
        if(p.startsWith('dur=')) dur = parseFloat(p.slice(4)) || 0;
        else if(p.startsWith('desc=')){
          desc = p.slice(5);
          if(desc.startsWith('"') && desc.endsWith('"')) desc = desc.slice(1,-1);
        }
      }
      return { name, dur, desc };
    });
  }

  // icons
  function iconStorageBig(cx,cy){
    const w=34, h=22;
    const x=cx-w/2, y=cy-h/2;
    return [
      `<ellipse cx="${cx}" cy="${y+5}" rx="${w/2}" ry="5" fill="#c9d1d9" opacity="0.95"/>`,
      `<rect x="${x}" y="${y+5}" width="${w}" height="${h}" rx="4" fill="#c9d1d9" opacity="0.9"/>`,
      `<ellipse cx="${cx}" cy="${y+5+h}" rx="${w/2}" ry="5" fill="#c9d1d9" opacity="0.9"/>`
    ].join('');
  }
  function iconNetworkBig(cx,cy){
    const x=cx-18, y=cy-12;
    const p = `M ${x+7} ${y+18} C ${x+2} ${y+18}, ${x+2} ${y+11}, ${x+7} ${y+11} C ${x+9} ${y+4}, ${x+18} ${y+4}, ${x+20} ${y+10} C ${x+26} ${y+10}, ${x+28} ${y+15}, ${x+24} ${y+18} Z`;
    return `<path d="${p}" fill="#c9d1d9" opacity="0.95"/>`;
  }
  function iconSpoolSmall(cx,cy){
    const w=22,h=14; const x=cx-w/2, y=cy-h/2;
    return [
      `<ellipse cx="${cx}" cy="${y+3}" rx="${w/2}" ry="3" fill="#c9d1d9" opacity="0.85"/>`,
      `<rect x="${x}" y="${y+3}" width="${w}" height="${h}" rx="3" fill="#c9d1d9" opacity="0.8"/>`,
      `<ellipse cx="${cx}" cy="${y+3+h}" rx="${w/2}" ry="3" fill="#c9d1d9" opacity="0.8"/>`
    ].join('');
  }
  function iconTeeCircle(cx,cy){
    return [
      `<circle cx="${cx}" cy="${cy}" r="10" fill="#0f1520" stroke="#c9d1d9" stroke-width="2" opacity="0.95"/>`,
      `<path d="M ${cx-5} ${cy-4} L ${cx} ${cy+1} L ${cx+5} ${cy-4} M ${cx} ${cy+1} L ${cx} ${cy+6}" stroke="#c9d1d9" stroke-width="2" stroke-linecap="round" fill="none"/>`
    ].join('');
  }
  function iconDeleteMarker(cx,cy){
    return `<circle cx="${cx}" cy="${cy}" r="8" fill="#0f1520" stroke="#c9d1d9" stroke-width="2" opacity="0.9"/>`;
  }
  function iconMarker(cx,cy){
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="#0f1520" stroke="#58a6ff" stroke-width="2" opacity="0.95"/>`;
  }
  function iconPipePill(cx,cy,label){
    const w=72, h=20;
    const x=cx-w/2, y=cy-h/2;
    return [
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#1b2536" stroke="#2b3852" opacity="0.95"/>`,
      `<text x="${x+10}" y="${y+14}" fill="#c9d1d9" font-size="11" style="font-family:${FONT}">${label}</text>`
    ].join('');
  }

  function draw(plan, timings){
    const viewportW = Math.floor(pipeSvg.parentElement.getBoundingClientRect().width || 800);
    const H = 580;

    const padX=24, padY=26;
    const taskW=150, taskH=22;
    const rowGap=28;
    const laneY = (r)=> padY + 170 + r*(taskH + rowGap);

    const tmap = new Map((timings||[]).map(t=>[t.name, t]));

    const parts=[];
    parts.push(`<rect x="0" y="0" width="100%" height="100%" fill="#0f1520"/>`);

    if(!plan){
      pipeSvg.style.width = `${viewportW}px`;
      pipeSvg.setAttribute('viewBox', `0 0 ${viewportW} ${H}`);
      parts.push(`<text x="${padX}" y="${padY+30}" fill="#9aa4af" font-size="12" style="font-family:${FONT}">Run upload/download…</text>`);
      pipeSvg.innerHTML = parts.join('');
      return;
    }

    const nodes = plan.nodes.slice();
    const minStage = Math.min(...nodes.map(n=>n.stage));
    const maxStage = Math.max(...nodes.map(n=>n.stage));
    const denom = Math.max(1e-6, (maxStage - minStage));

    // compute required width so nodes never overlap and we never need to scale the whole SVG
    const minStepPx = 120; // minimum distance per stage unit (tuned)
    const contentW = Math.ceil((denom * minStepPx) + padX*2 + taskW);
    const W = Math.max(viewportW, contentW);

    pipeSvg.style.width = `${W}px`;
    pipeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const step = (W - padX*2 - taskW) / denom;

    const pos = new Map();
    const xFor = (stage)=> padX + (stage - minStage) * step;

    function rowsFor(n){
      const baseRow = (n.row ?? 1);
      const sample = n.repeat?.sample ? Math.min(3, n.repeat.sample) : 1;
      if(sample === 1) return [baseRow];
      return [0,1,2].slice(0, sample);
    }

    for(const n of nodes){
      const x = xFor(n.stage);
      const rows = rowsFor(n);
      const tm = tmap.get(n.id);
      const dur = tm?.dur;

      if(n.kind === 'task'){
        const total = n.repeat?.total || 0;
        const suffix = n.repeat?.label || (total ? `×${total}` : '');
        const color = dur!=null ? '#2ea043' : '#58a6ff';
        const stack=[];
        for(const r of rows){
          const y = laneY(r);
          const cx = x + taskW/2;
          const cy = y + taskH/2;
          parts.push(`<rect x="${x}" y="${y}" width="${taskW}" height="${taskH}" rx="7" fill="${color}" opacity="0.9" stroke="#2b3852"/>`);
          stack.push({ inX:x, outX:x+taskW, cy, centerX:cx, centerY:cy });
        }
        pos.set(n.id, stack);
        const labelY = laneY(rows[0]) + 15;
        const label = dur!=null ? `${n.label} ${suffix} (${dur.toFixed(1)}ms)` : `${n.label} ${suffix}`;
        parts.push(`<text x="${x+8}" y="${labelY}" fill="#0b0f14" font-size="12" style="font-family:${FONT}">${label}</text>`);
        if(tm?.desc){
          parts.push(`<text x="${x}" y="${labelY+14}" fill="#9aa4af" font-size="10" style="font-family:${FONT}">${tm.desc}</text>`);
        }
        if(rows.length>=3 && total>rows.length){
          parts.push(`<text x="${x+taskW+8}" y="${laneY(2)+16}" fill="#9aa4af" font-size="11" style="font-family:${FONT}">… +${total-rows.length}</text>`);
        }
      } else if(n.kind === 'io' || n.kind === 'storage'){
        const cx = x + taskW/2;
        const cy = laneY(1) + 2;
        if(n.kind === 'io') parts.push(iconNetworkBig(cx, cy));
        else parts.push(iconStorageBig(cx, cy));
        parts.push(`<text x="${cx-28}" y="${cy+30}" fill="#9aa4af" font-size="12" style="font-family:${FONT}">${n.label}</text>`);
        const inX = cx - 18, outX = cx + 18;
        pos.set(n.id, [{ inX, outX, cy, centerX:cx, centerY:cy }]);
      } else if(n.kind === 'tee'){
        const cx = x + taskW/2;
        const cy = laneY(1) + taskH/2;
        parts.push(iconTeeCircle(cx, cy));
        parts.push(`<text x="${cx-14}" y="${cy+26}" fill="#9aa4af" font-size="11" style="font-family:${FONT}">tee</text>`);
        pos.set(n.id, [{ inX:cx-10, outX:cx+10, cy, centerX:cx, centerY:cy }]);
      } else if(n.kind === 'pipe'){
        const cx = x + taskW/2;
        const cy = laneY(1) + taskH/2;
        parts.push(iconPipePill(cx, cy, n.label));
        pos.set(n.id, [{ inX:cx-36, outX:cx+36, cy, centerX:cx, centerY:cy }]);
      } else if(n.kind === 'spool'){
        const cx = x + taskW/2;
        const cy = laneY(3) + taskH/2;
        parts.push(iconSpoolSmall(cx, cy));
        parts.push(`<text x="${cx-22}" y="${cy+24}" fill="#9aa4af" font-size="11" style="font-family:${FONT}">spool</text>`);
        const sw = tmap.get('spool_write');
        if(sw){
          parts.push(`<text x="${cx-46}" y="${cy+38}" fill="#9aa4af" font-size="10" style="font-family:${FONT}">${sw.dur.toFixed(1)}ms</text>`);
        }
        pos.set(n.id, [{ inX:cx-12, outX:cx+12, cy, centerX:cx, centerY:cy }]);
      } else if(n.kind === 'delete'){
        const cx = x + taskW/2;
        const cy = laneY(3) + taskH/2;
        parts.push(iconDeleteMarker(cx, cy));
        parts.push(`<text x="${cx-18}" y="${cy+24}" fill="#9aa4af" font-size="11" style="font-family:${FONT}">${n.label}</text>`);
        pos.set(n.id, [{ inX:cx-8, outX:cx+8, cy, centerX:cx, centerY:cy }]);
      } else if(n.kind === 'marker'){
        const cx = x + taskW/2;
        const cy = laneY(3) + taskH/2;
        parts.push(iconMarker(cx, cy));
        pos.set(n.id, [{ inX:cx-6, outX:cx+6, cy, centerX:cx, centerY:cy }]);
      }
    }

    const condActive = (when)=>{
      if(!when) return true;
      const inv = when.startsWith('!');
      const key = inv ? when.slice(1) : when;
      const v = tmap.get(key);
      const active = !!(v && v.dur > 0.01);
      return inv ? !active : active;
    };

    function connect(e){
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if(!a || !b) return;
      const p1=a[0], p2=b[0];

      const active = condActive(e.when);
      let stroke = active ? '#58a6ff' : '#3a475f';
      let opacity = active ? 0.85 : 0.45;
      let dash = e.optional ? (active ? '4 4' : '6 6') : '';
      let width = 1.5;
      if(e.style==='lifetime'){ stroke='#9aa4af'; opacity=0.65; dash='2 6'; width=2; }
      if(e.style==='use'){ stroke='#58a6ff'; opacity=active?0.9:0.15; dash=''; width=3.5; }

      if(e.shape==='straight'){
        const x1=p1.centerX ?? p1.outX, y1=p1.centerY ?? p1.cy;
        const x2=p2.centerX ?? p2.inX, y2=p2.centerY ?? p2.cy;
        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="${dash}" opacity="${opacity}"/>`);
        const dir = Math.abs(x2-x1) >= Math.abs(y2-y1) ? 'right' : 'down';
        if(dir==='right') parts.push(`<path d="M ${x2} ${y2} l -6 -4 l 0 8 z" fill="${stroke}" opacity="${opacity}"/>`);
        else parts.push(`<path d="M ${x2} ${y2} l -4 -6 l 8 0 z" fill="${stroke}" opacity="${opacity}"/>`);
      } else {
        const x1=p1.outX, y1=p1.cy, x2=p2.inX, y2=p2.cy;
        const mx=(x1+x2)/2;
        parts.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" stroke="${stroke}" stroke-width="${width}" stroke-dasharray="${dash}" fill="none" opacity="${opacity}"/>`);
        parts.push(`<path d="M ${x2} ${y2} l -6 -4 l 0 8 z" fill="${stroke}" opacity="${opacity}"/>`);
      }
      if(e.label){
        const tx=((p1.centerX ?? p1.outX)+(p2.centerX ?? p2.inX))/2;
        const ty=((p1.centerY ?? p1.cy)+(p2.centerY ?? p2.cy))/2 - 8;
        parts.push(`<text x="${tx}" y="${ty}" fill="#9aa4af" font-size="10" style="font-family:${FONT}">${e.label}</text>`);
      }
    }

    for(const e of (plan.edges||[])) connect(e);

    const total = tmap.get('total');
    if(total && plan.decorations){
      for(const d of plan.decorations){
        if(d.kind!=='totalSpan') continue;
        const a = pos.get(d.from);
        const b = pos.get(d.to);
        if(!a || !b) continue;
        const x1=a[0].inX ?? a[0].centerX;
        const x2=b[0].outX ?? b[0].centerX;
        const y=padY+110;
        const stroke='#9aa4af';
        parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${stroke}" opacity="0.9"/>`);
        parts.push(`<path d="M ${x1} ${y} l 8 -4 l 0 8 z" fill="${stroke}" opacity="0.9"/>`);
        parts.push(`<path d="M ${x2} ${y} l -8 -4 l 0 8 z" fill="${stroke}" opacity="0.9"/>`);
        parts.push(`<text x="${(x1+x2)/2 - 52}" y="${y-8}" fill="#9aa4af" font-size="12" style="font-family:${FONT}">total ${total.dur.toFixed(1)}ms</text>`);
      }
    }

    parts.push(`<text x="${padX}" y="${padY}" fill="#9aa4af" font-size="12" style="font-family:${FONT}">plan v${plan.version} (${plan.kind})</text>`);

    pipeSvg.innerHTML = parts.join('');
  }

  async function runDownload(url, filename){
    $('downloadStatus').textContent='running...';
    const res = await fetch(url);
    const planB64 = res.headers.get('x-pipeline-plan');
    const plan = planB64 ? decodePlan(planB64) : null;
    $('planInfo').textContent = plan ? `kind=${plan.kind} counts=${JSON.stringify(plan.counts)}` : 'no plan header';
    draw(plan, []);
    if(!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status}: ${t}`);
    }
    const blob = await res.blob();
    const a=document.createElement('a');
    const objUrl=URL.createObjectURL(blob);
    a.href=objUrl; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(objUrl), 60000);

    const st = res.headers.get('server-timing') || '';
    const timings = st ? parseServerTimingHeader(st) : [];
    $('timingInfo').textContent = st || 'no server-timing';
    draw(plan, timings);

    $('downloadStatus').textContent='ok';
    $('downloadStatus').className='status ok';
  }

  async function runUpload(url, file){
    $('uploadStatus').textContent='running...';
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:file });
    const txt = await res.text();
    if(!res.ok) throw new Error(txt);
    const planB64 = res.headers.get('x-pipeline-plan');
    const plan = planB64 ? decodePlan(planB64) : null;
    const st = res.headers.get('server-timing') || '';
    const timings = st ? parseServerTimingHeader(st) : [];
    $('planInfo').textContent = plan ? `kind=${plan.kind} counts=${JSON.stringify(plan.counts)}` : 'no plan header';
    $('timingInfo').textContent = st || 'no server-timing';
    draw(plan, timings);
    $('uploadStatus').textContent='ok';
    $('uploadStatus').className='status ok';
    log(txt);
  }

  async function refreshArchive(){
    $('listStatus').textContent='loading...';
    const res = await fetch(`${base()}/archive`);
    const data = await res.json();
    const tbody = $('archiveRows');
    tbody.innerHTML='';
    for(const a of (data.archives||[])){
      const tr=document.createElement('tr');
      const td1=document.createElement('td'); td1.textContent=a.id;
      const td2=document.createElement('td'); td2.textContent=a.mtime;
      const td3=document.createElement('td');
      const btn=document.createElement('button'); btn.textContent='download';
      btn.onclick = ()=> runDownload(`${base()}/archive/${encodeURIComponent(a.id)}`, `archive-${a.id}.zip`).catch(e=>log(String(e)));
      td3.appendChild(btn);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbody.appendChild(tr);
    }
    $('listStatus').textContent=`ok (${(data.archives||[]).length})`;
    $('listStatus').className='status ok';
  }

  $('baseUrl').value = origin();
  $('btnUseCurrent').onclick = ()=>{ $('baseUrl').value = origin(); };
  $('btnDownload').onclick = ()=> runDownload(`${base()}/content`, `content-${Date.now()}.zip`).catch(e=>log(String(e)));
  $('btnUpload').onclick = ()=>{
    const f = $('file').files && $('file').files[0];
    if(!f) return;
    runUpload(`${base()}/content`, f).then(refreshArchive).catch(e=>log(String(e)));
  };
  $('btnRefresh').onclick = ()=> refreshArchive().catch(e=>log(String(e)));

  // redraw on resize (re-layout, no scaling)
  window.addEventListener('resize', ()=>{
    // best-effort: if a plan is visible, redraw by reading current text from planInfo isn't reliable.
    // Users can rerun; keeping this minimal.
  });

  draw(null, null);
})();
