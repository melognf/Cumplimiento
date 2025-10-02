import { app, db } from './firebase-config.js';
import { doc, onSnapshot, setDoc, deleteField } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } 
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

/* ---------------- Config & estado ---------------- */
const FIREBASE_READY = !!(app?.options?.projectId && !String(app.options.projectId).includes('TU_PROJECT_ID'));
const ALL_LINEAS = ['LINEA001','LINEA002','LINEA003','LINEA005','LINEA006','LINEA007'];
let CURRENT_TURNO = 'total';
let unsubscribe = null;

const stateDefaultFecha = (()=> {
  const now = new Date();
  const localISO = new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0,10);
  return localISO;
})();

let state = { fecha: stateDefaultFecha, lineas: { LINEA001:{}, LINEA007:{} } };

/* ---------------- DOM refs ---------------- */
const $grid = document.getElementById('grid-lineas');
const $lista = document.getElementById('lista-desvios') || null;
const $fecha = document.getElementById('fecha');
const $modal = document.getElementById('modal-detalle');
const $mTitle = document.getElementById('m-title');
const $mBody = document.getElementById('m-body');
const $btnNuevoSabor = document.getElementById('btn-nuevo-sabor');
const $banner = document.getElementById('banner');

const $modalCarga = document.getElementById('modal-carga');
const $cLinea = document.getElementById('c-linea');
const $cSaborInput = document.getElementById('c-sabor-input');
const $cSaborRead = document.getElementById('c-sabor-read');
const $cProducto = document.getElementById('c-producto');
const $plan_t1 = document.getElementById('plan_t1');
const $plan_t2 = document.getElementById('plan_t2');
const $plan_t3 = document.getElementById('plan_t3');
const $real_t1 = document.getElementById('real_t1');
const $real_t2 = document.getElementById('real_t2');
const $real_t3 = document.getElementById('real_t3');
const $plan_total = document.getElementById('plan_total');
const $real_total = document.getElementById('real_total');
const $cumpl_pct = document.getElementById('cumpl_pct');
const $btnGuardar = document.getElementById('btn-guardar');

/* ---- Segundo input de sabor (inyectado si no existe) ---- */
let $cSabor2Input = document.getElementById('c-sabor2-input');
function ensureSecondSaborInput(){
  const row2 = document.querySelector('#modal-carga .row2');
  if (!row2) return;
  if (!document.getElementById('c-sabor2-input')){
    const wrap = document.createElement('div');
    wrap.style.gridColumn = '2 / span 1';
    wrap.innerHTML = `
      <label class="hint">Sabor 2 (opcional)</label>
      <input id="c-sabor2-input" type="text" placeholder="Otro sabor · formato" />
    `;
    row2.appendChild(wrap);
  }
  $cSabor2Input = document.getElementById('c-sabor2-input');
}

/* ---------------- UX: “0 inteligente” ---------------- */
function attachSmartZero(el){
  if(!el) return;
  function clearIfZero(){
    if (el.hasAttribute('readonly') || el.disabled) return;
    if (el.value === '0') { el.value = ''; } else { try{ el.select(); }catch{} }
  }
  function restoreIfEmpty(){
    if (el.value === '' || el.value == null) {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  el.addEventListener('focus', clearIfZero);
  el.addEventListener('blur', restoreIfEmpty);
}
[$plan_t1,$plan_t2,$plan_t3,$real_t1,$real_t2,$real_t3].forEach(attachSmartZero);

/* ---------------- Helpers ---------------- */
const fmt  = (n) => (n==null?'-':Number(n).toLocaleString('es-AR'));
const pct  = (x) => (isFinite(x) && x>=0 ? (x).toFixed(1).replace('.',',')+'%' : '-');
const clamp= (n,min,max)=>Math.max(min,Math.min(max,n));
const colorBy = (p)=> p>=100? 'b-green' : p>=80? 'b-yellow' : 'b-red';
function cumplimiento(plan, real){ return plan>0? (real/plan*100) : NaN; }

function aggregateLinea(lineaObj){
  let plan={t1:0,t2:0,t3:0,total:0}, real={t1:0,t2:0,t3:0,total:0};
  for(const sabor in lineaObj){
    const it=lineaObj[sabor];
    ['t1','t2','t3','total'].forEach(k=>{ plan[k]+=it.plan?.[k]||0; real[k]+=it.real?.[k]||0 });
  }
  return {plan,real};
}
function worstSkus(data, turno){
  const items=[];
  for(const linea in data.lineas){
    for(const sabor in data.lineas[linea]){
      const it=data.lineas[linea][sabor];
      const p = turno==='total'? it.plan?.total||0: it.plan?.[turno]||0;
      const r = turno==='total'? it.real?.total||0: it.real?.[turno]||0;
      const c = cumplimiento(p,r);
      items.push({linea,sabor,producto:it.producto||sabor,plan:p,real:r,cumpl:c});
    }
  }
  return items.filter(x=>x.plan>0).sort((a,b)=>a.cumpl-b.cumpl).slice(0,8);
}

// Normalización para evitar duplicados
function normalizeKey(s){
  return (s||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[·•\-]/g,' ')
    .trim().replace(/\s+/g,' ')
    .toUpperCase();
}
function findExistingKey(linea, typed){
  const target = normalizeKey(typed);
  const obj = state.lineas[linea] || {};
  for (const k of Object.keys(obj)){
    if (normalizeKey(k) === target) return k;
  }
  return null;
}

// === Crear PDF con los datos actuales (Totales y por turno) ===
async function crearPDFDesdeState() {
  // jsPDF UMD
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const fecha = state.fecha || new Date().toISOString().slice(0,10);
  const mm = 40;  // margen
  let y  = 48;

  // Título
  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text(`Informe PP — ${fecha}`, mm, y); y += 18;
  doc.setFont('helvetica','normal'); doc.setFontSize(11);
  doc.text(`Generado desde Cumplimiento Diario`, mm, y); y += 18;

  // Recorro líneas
  for (const linea of Object.keys(state.lineas || {})) {
    const agg = aggregateLinea(state.lineas[linea]);
    // Salto de página si hace falta
    if (y > 760) { doc.addPage(); y = 48; }

    doc.setFont('helvetica','bold'); doc.setFontSize(13);
    doc.text(linea, mm, y); y += 14;

    doc.setFont('helvetica','normal'); doc.setFontSize(11);
    const filas = [
      ['T1', agg.plan.t1, agg.real.t1],
      ['T2', agg.plan.t2, agg.real.t2],
      ['T3', agg.plan.t3, agg.real.t3],
      ['TOTAL', agg.plan.total, agg.real.total],
    ];

    filas.forEach(([lbl, p, r]) => {
      const c = cumplimiento(p, r);
      doc.text(`${lbl}  ·  Plan: ${fmt(p)}   Real: ${fmt(r)}   Cump.: ${isFinite(c)?c.toFixed(1)+'%':'-'}`, mm+12, y);
      y += 14;
    });

    y += 8;
    // línea separadora
    doc.setDrawColor(220); doc.line(mm, y, 555, y); y += 12;
  }

  const filename = `informe-pp-${fecha}.pdf`;
  const blob = doc.output('blob');
  return { blob, filename };
}

// === Subir a Firebase Storage y devolver URL pública ===
async function subirPdfYObtenerURL(blob, filename) {
  const storage = getStorage();
  const path = `reportes/${state.fecha}/${filename}`;
  const ref  = sRef(storage, path);
  await uploadBytes(ref, blob, { contentType: 'application/pdf' });
  return await getDownloadURL(ref);
}

// === Compartir por WhatsApp (móvil primero) ===
async function compartirPorWhatsApp() {
  try {
    const { blob, filename } = await crearPDFDesdeState();

    // 1) Si el dispositivo soporta compartir archivos (Android/iOS)
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: 'application/pdf' })] })) {
      const file = new File([blob], filename, { type:'application/pdf' });
      await navigator.share({ title: 'Informe PP', text: `Informe PP ${state.fecha}`, files: [file] });
      notify('Compartido ✔');
      return;
    }

    // 2) Fallback: subir a Storage y abrir WhatsApp Web con el link
    const url = await subirPdfYObtenerURL(blob, filename);
    const texto = `Informe PP ${state.fecha} → ${url}`;
    const wa = `https://wa.me/?text=${encodeURIComponent(texto)}`;
    window.open(wa, '_blank');
    notify('Abrí WhatsApp para enviar el enlace del PDF.');
  } catch (e) {
    console.error(e);
    notify('No se pudo generar/compartir el PDF');
  }
}

// (opcional) exporto a window para enganchar un botón
window.exportarYCompartirPP = compartirPorWhatsApp;

/* ---------------- LocalStorage ---------------- */
const LS = {
  key: (f)=>`cumplimiento_state_${f}`,
  save(fecha, data){ try{ localStorage.setItem(this.key(fecha), JSON.stringify(data)); }catch{} },
  load(fecha){ try{ const raw = localStorage.getItem(this.key(fecha)); return raw? JSON.parse(raw): null; }catch{ return null } }
};
function notify(msg){ if(!$banner) return; $banner.textContent = msg; $banner.hidden = false; setTimeout(()=>{ $banner.hidden = true; }, 2200); }

/* ---------------- Turno global ---------------- */
function setTurno(newTurno){
  CURRENT_TURNO = newTurno;
  // Header
  document.querySelectorAll('.toggle button').forEach(b=>{
    if (b.dataset.turno === newTurno) b.classList.add('active'); else b.classList.remove('active');
  });
  // Modal detalle
  const mTurnos = document.getElementById('m-turnos');
  if (mTurnos){
    mTurnos.querySelectorAll('button').forEach(b=>{
      if (b.dataset.turno === newTurno) b.classList.add('active'); else b.classList.remove('active');
    });
  }
  render(state);
  const lineName = document.getElementById('m-title')?.textContent?.replace('Detalle · ','');
  if (document.getElementById('modal-detalle')?.open && lineName) renderDetalle(lineName);
  if (document.getElementById('modal-carga')?.open) setExclusiveTurnoUI();
}

/* ---------------- Render grid ---------------- */
function render(data){
  if (!$grid) return;
  const showEmpty = document.getElementById('toggleEmpty')?.checked;
  const lineas = showEmpty ? ALL_LINEAS : Object.keys(data.lineas);

  $grid.innerHTML='';
  lineas.forEach(linea=>{
    const lineaObj = data.lineas[linea] || {};
    const agg = aggregateLinea(lineaObj);
    const p = CURRENT_TURNO==='total' ? agg.plan.total : agg.plan[CURRENT_TURNO];
    const r = CURRENT_TURNO==='total' ? agg.real.total : agg.real[CURRENT_TURNO];
    const c = cumplimiento(p,r);

    const badge = isFinite(c) ? colorBy(c) : 'b-yellow';
    const tone  = isFinite(c) ? (c>=100? 'tone-ok' : c>=80? 'tone-warn' : 'tone-bad') : 'tone-unk';

    const card = document.createElement('div');
    const isEmpty = ((p||0)===0 && (r||0)===0);
    const isCarga = document.getElementById('toggleCarga')?.checked;
    card.className = `card ${tone}` + (isEmpty && !isCarga ? ' muted' : '');

    card.innerHTML = `
      <h3 style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span>${linea}</span>
        ${isCarga ? '<button class="primary" data-new="1" title="Editar / Nuevo sabor">✏️</button>' : ''}
      </h3>
      <div class="badge ${badge}">Cumplimiento ${pct(c)}</div>
      <div class="pill pill-card" style="margin-top:6px;gap:6px;">
        <button data-turno="t1" class="${CURRENT_TURNO==='t1'?'active':''}">T1</button>
        <button data-turno="t2" class="${CURRENT_TURNO==='t2'?'active':''}">T2</button>
        <button data-turno="t3" class="${CURRENT_TURNO==='t3'?'active':''}">T3</button>
      </div>
      <div class="kpis">
        <div class="kpi"><span class="label">Plan ${CURRENT_TURNO.toUpperCase()}</span><span class="val">${fmt(p||0)}</span></div>
        <div class="kpi"><span class="label">Real ${CURRENT_TURNO.toUpperCase()}</span><span class="val">${fmt(r||0)}</span></div>
      </div>
      <div class="progress">
        <span style="width:${isFinite(c)? clamp(c,0,130) : 0}%;
               background:${isFinite(c) ? (c>=100? 'linear-gradient(90deg,#16a34a,#22c55e)' : c>=80? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : 'linear-gradient(90deg,#ef4444,#f87171)') : '#1b2433'}">
        </span>
      </div>
      <button aria-label="Ver detalle" style="align-self:flex-start;margin-top:6px;border:1px solid #243248;background:#162032;color:var(--text);padding:8px 10px;border-radius:10px;cursor:pointer">Ver detalle</button>
    `;

    card.querySelector('button[aria-label="Ver detalle"]')?.addEventListener('click',()=>openDetalle(linea));
    if (isEmpty && !isCarga) card.querySelector('button[aria-label="Ver detalle"]')?.setAttribute('disabled','true');

    const btnNew = card.querySelector('button[data-new]');
    if (btnNew) {
      btnNew.addEventListener('click', (e) => {
        e.stopPropagation();
        const sabores = Object.keys(state.lineas[linea] || []);
        if (sabores.length === 0) {
          openCarga(linea, null, true);
        } else if (sabores.length === 1) {
          openCarga(linea, sabores[0], false);
        } else {
          openDetalle(linea);
          notify('Elegí el sabor a editar en el detalle.');
        }
      });
    }

    $grid.appendChild(card);
  });

  if ($lista){
    $lista.innerHTML='';
    for(const item of worstSkus(data, CURRENT_TURNO)){
      const row = document.createElement('div');
      row.className='row';
      row.innerHTML = `
        <div class="title">${item.producto} <span class="hint">(${item.linea})</span></div>
        <div class="num">${fmt(item.real)} / ${fmt(item.plan)}</div>
        <div class="pct">${pct(item.cumpl)}</div>
      `;
      $lista.appendChild(row);
    }
  }
}

/* ---------------- Detalle ---------------- */
function openDetalle(linea){
  if (!$modal) return;
  $mTitle.textContent = `Detalle · ${linea}`;
  const showCarga = !!document.getElementById('toggleCarga')?.checked;
  if ($btnNuevoSabor){
    $btnNuevoSabor.style.display = showCarga ? 'inline-block' : 'none';
    $btnNuevoSabor.onclick = ()=>openCarga(linea, null, true);
  }
  renderDetalle(linea);
  $modal.showModal();
}

// Switch mobile/desktop
const mq = window.matchMedia('(max-width: 600px)');
function applyMobileMode(){
  if (!$mBody) return;
  const isMobile = mq.matches;
  $mBody.querySelectorAll('tr.desktop').forEach(tr=>tr.style.display = isMobile ? 'none' : '');
  $mBody.querySelectorAll('tr.mobile').forEach(tr=>tr.style.display = isMobile ? '' : 'none');
}
mq.addEventListener?.('change', applyMobileMode);

function renderDetalle(linea){
  const productos = state.lineas[linea] || {};
  const keys = Object.keys(productos);
  $mBody.innerHTML='';

  if (keys.length===0){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" class="td-center hint">Sin datos para esta línea en la fecha seleccionada.</td>`;
    $mBody.appendChild(tr);
    applyMobileMode();
    return;
  }

  const hasDataInTurno = keys.some(k=>{
    const it = productos[k]; 
    const p = CURRENT_TURNO==='total' ? (it.plan?.total||0) : (it.plan?.[CURRENT_TURNO]||0);
    const r = CURRENT_TURNO==='total' ? (it.real?.total||0) : (it.real?.[CURRENT_TURNO]||0);
    return (p>0 || r>0);
  });

  for(const sabor of keys){
    const it = productos[sabor];
    const p = CURRENT_TURNO==='total'? it.plan?.total||0: it.plan?.[CURRENT_TURNO]||0;
    const r = CURRENT_TURNO==='total'? it.real?.total||0: it.real?.[CURRENT_TURNO]||0;
    const l = CURRENT_TURNO==='total'? ((it.litros?.t1||0) + (it.litros?.t2||0) + (it.litros?.t3||0)) : (it.litros?.[CURRENT_TURNO]||0);
    const c = cumplimiento(p,r);
    const label = it.producto || sabor;

    if (hasDataInTurno && p===0 && r===0) continue;

    // Desktop
    const tr = document.createElement('tr');
    tr.className = 'desktop';
    tr.innerHTML = `
      <td>${label}</td>
      <td class="num">${fmt(p)}</td>
      <td class="num">${fmt(r)}</td>
      <td class="num">${pct(c)}</td>
      <td>
        <div class="progress"><span style="width:${isFinite(c)? clamp(c,0,130) : 0}%; background:${isFinite(c) ? (c>=100? 'linear-gradient(90deg,#16a34a,#22c55e)' : c>=80? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : 'linear-gradient(90deg,#ef4444,#f87171)') : '#1b2433'}"></span></div>
        ${(p>0 && r===0) ? '<div class="hint">⚠️ Hubo plan y no se produjo en este turno</div>' : ''}
      </td>
      <td class="num">${fmt(l)}</td>
      <td class="td-center">${ document.getElementById('toggleCarga')?.checked ? `<button class="primary btn-xs" data-linea="${linea}" data-sabor="${sabor}">✏️ Cargar</button>` : ''}</td>
    `;
    tr.querySelector('button.primary')?.addEventListener('click',()=>openCarga(linea, sabor, false));
    $mBody.appendChild(tr);

    // Mobile (una sola barra)
    const trM = document.createElement('tr');
    trM.className = 'mobile';
    trM.style.display = 'none';
    trM.innerHTML = `
      <td colspan="7">
        <div class="m-item">
          <div class="m-line1">
            <div class="m-sabor"><strong>${label}</strong></div>
            <div class="m-plr">
              <span>Plan: <strong>${fmt(p)}</strong></span>
              <span>Real: <strong>${fmt(r)}</strong></span>
              <span>Cump.: <strong>${pct(c)}</strong></span>
            </div>
          </div>
          <div class="progress"><span style="width:${isFinite(c)? clamp(c,0,130) : 0}%; background:${isFinite(c) ? (c>=100? 'linear-gradient(90deg,#16a34a,#22c55e)' : c>=80? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : 'linear-gradient(90deg,#ef4444,#f87171)') : '#1b2433'}"></span></div>
          <div class="m-actions">
            ${ document.getElementById('toggleCarga')?.checked ? `<button class="primary btn-xs" data-linea="${linea}" data-sabor="${sabor}">✏️ Cargar</button>` : '' }
          </div>
        </div>
      </td>
    `;
    trM.querySelector('button.primary')?.addEventListener('click',()=>openCarga(linea, sabor, false));
    $mBody.appendChild(trM);
  }
  applyMobileMode();
}

/* ---------------- Carga ---------------- */
let cargaCtx = { linea:null, sabor:null, isNew:false };

function openCarga(linea, sabor, isNew){
  if (!$modalCarga) return;
  ensureSecondSaborInput();

  const it = state.lineas[linea]?.[sabor] || { producto:'', plan:{t1:0,t2:0,t3:0,total:0}, real:{t1:0,t2:0,t3:0,total:0} };
  cargaCtx = { linea, sabor, isNew: !!isNew };
  $cLinea.textContent = linea;

  if (isNew){
    if ($cSaborInput){
      $cSaborInput.style.display='block';
      $cSaborInput.value = '';
      $cSaborInput.placeholder = ''; // sin “Ej: …”
      setTimeout(()=>{ try{ $cSaborInput.focus(); }catch{} }, 60);
    }
    if ($cSabor2Input){
      $cSabor2Input.style.display='block';
      $cSabor2Input.value = '';
    }
    if ($cSaborRead) $cSaborRead.style.display='none';
  } else {
    if ($cSaborInput)  $cSaborInput.style.display='none';
    if ($cSabor2Input) $cSabor2Input.style.display='none';
    if ($cSaborRead){
      $cSaborRead.textContent = (it.producto || sabor || '-');
      $cSaborRead.style.display='inline-flex';
    }
  }

  if ($cProducto) {
    const txt = (it?.producto ?? sabor ?? '').trim();
    if (!txt || txt === '.') { $cProducto.textContent = ''; $cProducto.style.display = 'none'; }
    else { $cProducto.textContent = txt; $cProducto.style.display = ''; }
  }

  $plan_t1.value = it.plan?.t1 || 0;
  $plan_t2.value = it.plan?.t2 || 0;
  $plan_t3.value = it.plan?.t3 || 0;
  $real_t1.value = it.real?.t1 || 0;
  $real_t2.value = it.real?.t2 || 0;
  $real_t3.value = it.real?.t3 || 0;

  setExclusiveTurnoUI();
  setPlanLockUI(it);
  recalcCarga();
  $modalCarga.showModal();
}

function num(v){ const n = parseInt(v,10); return isNaN(n)?0:n; }
function recalcCarga(){
  const exclusive = (CURRENT_TURNO==='t1' || CURRENT_TURNO==='t2' || CURRENT_TURNO==='t3');
  if (exclusive){
    const p = num(document.getElementById('plan_' + CURRENT_TURNO).value);
    const r = num(document.getElementById('real_' + CURRENT_TURNO).value);
    $cumpl_pct.textContent = pct(p>0 ? (r/p*100) : NaN);
  } else {
    const pt = num($plan_t1.value)+num($plan_t2.value)+num($plan_t3.value);
    const rt = num($real_t1.value)+num($real_t2.value)+num($real_t3.value);
    if ($plan_total) $plan_total.textContent = fmt(pt);
    if ($real_total) $real_total.textContent = fmt(rt);
    const c = pt>0? (rt/pt*100) : NaN;
    $cumpl_pct.textContent = pct(c);
  }
}
['input','change'].forEach(ev=>{
  [$plan_t1,$plan_t2,$plan_t3,$real_t1,$real_t2,$real_t3].forEach(el=>el?.addEventListener(ev, recalcCarga));
});

// Subtítulos en exclusivo
function addSubLabels(row){
  const planCell = row.children?.[1];
  const realCell = row.children?.[2];
  if (planCell && !planCell.querySelector('.subhint')){
    const l = document.createElement('div'); l.className='subhint'; l.textContent='Plan (cajas)';
    planCell.prepend(l);
  }
  if (realCell && !realCell.querySelector('.subhint')){
    const l = document.createElement('div'); l.className='subhint'; l.textContent='Real (cajas)';
    realCell.prepend(l);
  }
}
function removeSubLabels(row){
  row?.querySelectorAll('.subhint')?.forEach(n=>n.remove());
}

function setExclusiveTurnoUI(){
  if (!$modalCarga) return;
  const exclusive = (CURRENT_TURNO==='t1' || CURRENT_TURNO==='t2' || CURRENT_TURNO==='t3');

  const headerRow = Array.from($modalCarga.querySelectorAll('.form_grid .row3')).find(r=>{
    const hints = r.querySelectorAll('.hint');
    return hints.length===2 &&
      /plan/i.test(hints[0]?.textContent||'') &&
      /real/i.test(hints[1]?.textContent||'');
  });
  if (headerRow) headerRow.style.display = exclusive ? 'none' : 'grid';

  const filas = Array.from($modalCarga.querySelectorAll('.form_grid .row3'));
  const filaT1 = filas.find(r=>/^\s*T1\s*$/i.test(r.querySelector('strong')?.textContent||''));
  const filaT2 = filas.find(r=>/^\s*T2\s*$/i.test(r.querySelector('strong')?.textContent||''));
  const filaT3 = filas.find(r=>/^\s*T3\s*$/i.test(r.querySelector('strong')?.textContent||''));

  [filaT1,filaT2,filaT3].forEach(f=>{
    if (!f) return;
    const isThis = (f===filaT1 && CURRENT_TURNO==='t1') || (f===filaT2 && CURRENT_TURNO==='t2') || (f===filaT3 && CURRENT_TURNO==='t3');
    f.style.display = (!exclusive || isThis) ? 'grid' : 'none';
    if (isThis && exclusive) addSubLabels(f); else removeSubLabels(f);
  });

  const totalRow = $modalCarga.querySelector('.total_row')?.closest('.row3');
  if (totalRow) totalRow.style.display = exclusive ? 'none' : 'grid';

  $plan_t1?.toggleAttribute('disabled', exclusive && CURRENT_TURNO!=='t1');
  $real_t1?.toggleAttribute('disabled', exclusive && CURRENT_TURNO!=='t1');
  $plan_t2?.toggleAttribute('disabled', exclusive && CURRENT_TURNO!=='t2');
  $real_t2?.toggleAttribute('disabled', exclusive && CURRENT_TURNO!=='t2');
  $plan_t3?.toggleAttribute('disabled', exclusive && CURRENT_TURNO!=='t3');
  $real_t3?.toggleAttribute('disabled', exclusive && CURRENT_TURNO!=='t3');

  const cumpRow = $cumpl_pct?.closest('.row3');
  const labelEl = cumpRow?.querySelector('strong');
  if (labelEl){
    labelEl.textContent = exclusive ? ('Cumplimiento ' + CURRENT_TURNO.toUpperCase()) : 'Cumplimiento';
  }
  recalcCarga();
}

// Lock del plan: NO bloquear en Modo Carga
function setPlanLockUI(it){
  const exclusive = (CURRENT_TURNO==='t1' || CURRENT_TURNO==='t2' || CURRENT_TURNO==='t3');
  const isCarga = !!document.getElementById('toggleCarga')?.checked;

  [$plan_t1,$plan_t2,$plan_t3].forEach(el=>{
    if (!el) return;
    el.removeAttribute('readonly');
    el.classList.remove('is-locked');
    if (!exclusive) el.removeAttribute('disabled');
  });

  if (!isCarga){
    const lock = exclusive
      ? ((it?.plan?.[CURRENT_TURNO]||0) > 0)
      : (((it?.plan?.t1||0)+(it?.plan?.t2||0)+(it?.plan?.t3||0)) > 0);

    if (lock){
      if (exclusive){
        const el = document.getElementById('plan_' + CURRENT_TURNO);
        if (el){ el.setAttribute('readonly','readonly'); el.classList.add('is-locked'); }
      } else {
        [$plan_t1,$plan_t2,$plan_t3].forEach(el=>{
          if (el){ el.setAttribute('readonly','readonly'); el.classList.add('is-locked'); }
        });
      }
    }
  }

  if (exclusive){
    ({ t1:$plan_t1, t2:$plan_t2, t3:$plan_t3 }[CURRENT_TURNO])?.removeAttribute('disabled');
  }
}

// No duplicar claves
function uniqueKeyForSabor(linea, base){ return base; }

/* ---------------- Guardar ---------------- */
// Si se carga Sabor 2, lo combinamos en el “producto” del mismo ítem.
async function guardarCarga(){
  try{
    const linea = cargaCtx.linea;
    let saborKey = cargaCtx.sabor;

    if (cargaCtx.isNew){
      const typedRaw = ($cSaborInput?.value || '').trim();
      const typed = (typedRaw === '.') ? '' : typedRaw;
      if (!typed){ alert('Ingresá “sabor y formato”'); return; }
      const existing = findExistingKey(linea, typed);
      saborKey = existing || uniqueKeyForSabor(linea, typed);
    }

    const formPlan = { t1:num($plan_t1.value), t2:num($plan_t2.value), t3:num($plan_t3.value) };
    const formReal = { t1:num($real_t1.value), t2:num($real_t2.value), t3:num($real_t3.value) };
    const prev = state.lineas[linea]?.[saborKey] || null;
    let plan = prev?.plan ? { ...prev.plan } : { t1:0,t2:0,t3:0,total:0 };
    let real = prev?.real ? { ...prev.real } : { t1:0,t2:0,t3:0,total:0 };

    if (CURRENT_TURNO === 't1' || CURRENT_TURNO === 't2' || CURRENT_TURNO === 't3'){
      plan[CURRENT_TURNO] = formPlan[CURRENT_TURNO];
      real[CURRENT_TURNO] = formReal[CURRENT_TURNO];
    } else {
      plan = { ...plan, ...formPlan };
      real = { ...real, ...formReal };
    }
    plan.total = plan.t1 + plan.t2 + plan.t3;
    real.total = real.t1 + real.t2 + real.t3;

    const s1 = saborKey;
    const s2Raw = ($cSabor2Input?.value || '').trim();
    const s2 = (cargaCtx.isNew && s2Raw && normalizeKey(s2Raw) !== normalizeKey(s1)) ? ` / ${s2Raw}` : '';
    const producto = (s1 + s2).trim();

    if (!state.lineas[linea]) state.lineas[linea] = {};
    state.lineas[linea][saborKey] = { ...(state.lineas[linea][saborKey]||{}), producto, plan, real };

    const fechaISO = $fecha?.value || state.fecha;
    LS.save(fechaISO, state);

    if (FIREBASE_READY){
      const ref = doc(db, 'cumplimiento', fechaISO);
      await setDoc(ref, { lineas: { [linea]: { [saborKey]: { producto, plan, real } } } }, { merge:true });
      notify('Guardado en Firestore ✓');
    } else {
      notify('Guardado local (Firebase no configurado)');
    }

    render(state);
    const lineName = $mTitle?.textContent?.replace('Detalle · ','');
    if (lineName===linea) renderDetalle(linea);
    $modalCarga?.close();
  }catch(err){
    console.error('guardarCarga EXCEPTION', err);
  }
}
$btnGuardar?.addEventListener('click', guardarCarga);

/* ---------------- Firestore sync ---------------- */
async function subscribeToDate(fechaISO){
  if (!FIREBASE_READY) return;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  const ref = doc(db, 'cumplimiento', fechaISO);
  unsubscribe = onSnapshot(ref, (snap)=>{
    if (snap.exists()){
      const data = snap.data();
      state.fecha = fechaISO;
      state.lineas = data.lineas || {};
      LS.save(fechaISO, state);
      render(state);
    } else {
      const local = LS.load(fechaISO);
      state.fecha = fechaISO;
      state.lineas = local?.lineas || {};
      render(state);
    }
  }, (err)=>{
    console.error('onSnapshot error', err);
    const local = LS.load(fechaISO);
    if (local){ state = local; render(state); }
  });
}

/* ---------------- Init & eventos ---------------- */
(function init(){
  if ($fecha) $fecha.value = state.fecha;
  const local = LS.load(state.fecha);
  if (local) state = local;
  render(state);
  document.body.classList.toggle('carga', document.getElementById('toggleCarga')?.checked);

  if (!FIREBASE_READY){
    notify('Modo local: configurá Firebase para sincronizar en tiempo real.');
    return;
  }
  const auth = getAuth();
  signInAnonymously(auth).catch(console.error);
  onAuthStateChanged(auth, ()=>{ subscribeToDate($fecha?.value || state.fecha); });
})();

// Delegación de clicks para cambiar de turno (header, cards y modal)
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-turno]');
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  setTurno(btn.dataset.turno);
});

document.getElementById('toggleEmpty')?.addEventListener('change',()=>render(state));
document.getElementById('toggleCarga')?.addEventListener('change',(e)=>{
  const show = e.target.checked;
  document.body.classList.toggle('carga', !!show);
  if ($modal?.open){
    if ($btnNuevoSabor) $btnNuevoSabor.style.display = show ? 'inline-block' : 'none';
    const lineName = $mTitle?.textContent?.replace('Detalle · ','');
    renderDetalle(lineName);
  } else {
    render(state);
  }
});
$fecha?.addEventListener('change', ()=>{
  const f = $fecha.value;
  const local = LS.load(f);
  state.fecha = f;
  state.lineas = local?.lineas || {};
  render(state);
  subscribeToDate(f);
});

window.dashboard = { subscribeToDate };

/* ---------------- UI extras (botones & borrar) ---------------- */
(function uiEnhancements(){
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const $  = (sel, root=document) => root.querySelector(sel);

  // A) Checkboxes -> Botones
  function initTogglesAsButtons(){
    const headerWrap = document.querySelector('header .wrap.bar');
    const chkSinPlan = document.getElementById('toggleEmpty');
    const chkModo    = document.getElementById('toggleCarga');
    if (!headerWrap || !chkSinPlan || !chkModo) return;

    const oldLabels = [...headerWrap.querySelectorAll('label.switch')];
    oldLabels.forEach(l => { l.style.display = 'none'; });

    let btnbar = headerWrap.querySelector('.btnbar');
    if (!btnbar){
      btnbar = document.createElement('div');
      btnbar.className = 'btnbar';
      const ref = headerWrap.querySelector('.toggle');
      headerWrap.insertBefore(btnbar, ref);
    }

    let btnSinPlan = document.getElementById('btnSinPlan');
    let btnModo    = document.getElementById('btnModoCarga');

    if (!btnSinPlan){
      btnSinPlan = document.createElement('button');
      btnSinPlan.id = 'btnSinPlan';
      btnSinPlan.type = 'button';
      btnSinPlan.className = 'btn-toggle';
      btnSinPlan.textContent = 'Mostrar líneas sin plan';
      btnbar.appendChild(btnSinPlan);
    }
    if (!btnModo){
      btnModo = document.createElement('button');
      btnModo.id = 'btnModoCarga';
      btnModo.type = 'button';
      btnModo.className = 'btn-toggle';
      btnModo.textContent = 'Modo Carga';
      btnbar.appendChild(btnModo);
    }

    const syncBtn = (btn, checked)=>{
      btn.classList.toggle('is-active', checked);
      btn.setAttribute('aria-pressed', String(checked));
    };
    const toggleFromButton = (btn, chk)=>{
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change', { bubbles:true }));
      syncBtn(btn, chk.checked);
    };

    btnSinPlan.addEventListener('click', ()=> toggleFromButton(btnSinPlan, chkSinPlan));
    btnModo.addEventListener('click',    ()=> toggleFromButton(btnModo,    chkModo));
    chkSinPlan.addEventListener('change',()=> syncBtn(btnSinPlan, chkSinPlan.checked));
    chkModo.addEventListener('change',   ()=> syncBtn(btnModo,    chkModo.checked));

    syncBtn(btnSinPlan, chkSinPlan.checked);
    syncBtn(btnModo,    chkModo.checked);
  }

  // B) Botón 🗑 Borrar por fila (desktop y móvil)
  function lineaActualDesdeTitulo(){
    const t = document.getElementById('m-title')?.textContent || '';
    const m = t.match(/·\s*(.+)$/);
    return m ? m[1].trim() : null;
  }

  async function deleteRowFromBackend({ fecha, linea, sabor }){
    if (!FIREBASE_READY) return false;
    try{
      const ref = doc(db, 'cumplimiento', fecha);
      await setDoc(ref, { lineas: { [linea]: { [sabor]: deleteField() } } }, { merge:true });
      return true;
    }catch(e){
      console.error('Firestore delete error', e);
      return false;
    }
  }

  function deleteRowLocal({ fecha, linea, sabor }){
    if (state?.lineas?.[linea]) {
      delete state.lineas[linea][sabor];
    }
    LS.save(fecha, state);
  }

  async function handleDeleteRow(sabor){
    const linea = lineaActualDesdeTitulo();
    const fecha = document.getElementById('fecha')?.value || state.fecha;
    if (!linea) { alert('No se pudo identificar la línea.'); return; }
    if (!confirm(`¿Borrar los datos de "${sabor}" en ${linea}?`)) return;

    const okRemote = await deleteRowFromBackend({ fecha, linea, sabor });
    if (!okRemote) deleteRowLocal({ fecha, linea, sabor });

    const tb = document.getElementById('m-body');
    const tr  = [...tb.querySelectorAll('tr.desktop')].find(r => (r.querySelector('td')?.textContent || '').trim() === sabor);
    const trM = [...tb.querySelectorAll('tr.mobile')].find(r => (r.querySelector('strong')?.textContent || '').trim() === sabor);
    tr?.remove(); trM?.remove();

    render(state);
  }

  function injectDeleteButtons(){
    const tb = document.getElementById('m-body'); 
    if (!tb) return;

    // Desktop
    [...tb.querySelectorAll('tr.desktop')].forEach(tr=>{
      const tds = tr.querySelectorAll('td'); if (!tds.length) return;
      const tdAcc = tds[tds.length - 1];
      if (tdAcc.querySelector('.btn-del')) return;
      const sabor = (tds[0]?.textContent || '').trim();

      const group = document.createElement('div');
      group.className = 'btn-group';

      const btnCargar = tdAcc.querySelector('button.primary, a');
      if (btnCargar) group.appendChild(btnCargar);

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn-small danger btn-del';
      btnDel.textContent = '🗑 Borrar';
      btnDel.dataset.sabor = sabor;
      group.appendChild(btnDel);

      tdAcc.innerHTML = '';
      tdAcc.appendChild(group);
    });

    // Móvil
    [...tb.querySelectorAll('tr.mobile')].forEach(tr=>{
      const sabor = (tr.querySelector('.m-sabor strong')?.textContent || '').trim();
      const actions = tr.querySelector('.m-actions');
      if (!actions) return;
      if (actions.querySelector('.btn-del')) return;

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn-small danger btn-del';
      btnDel.textContent = '🗑 Borrar';
      btnDel.dataset.sabor = sabor;
      btnDel.style.width = '100%';
      btnDel.style.marginTop = '6px';

      actions.appendChild(btnDel);
    });
  }

  document.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('.btn-del'); if (!btn) return;
    handleDeleteRow(btn.dataset.sabor || '');
  });

  const mBody = document.getElementById('m-body');
  if (mBody){
    const obs = new MutationObserver(injectDeleteButtons);
    obs.observe(mBody, { childList:true, subtree:true });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ()=>{
      initTogglesAsButtons();
      injectDeleteButtons();
    });
  } else {
    initTogglesAsButtons();
    injectDeleteButtons();
  }
})();
