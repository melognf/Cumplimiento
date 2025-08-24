// v4.2 — Sabor manual (sin SKU), Modo Carga con "➕ Nuevo sabor"
import { app, db } from './firebase-config.js';
import { doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const FIREBASE_READY = !!(app?.options?.projectId && !String(app.options.projectId).includes('TU_PROJECT_ID'));
const ALL_LINEAS = ['LINEA001','LINEA002','LINEA003','LINEA005','LINEA006','LINEA007'];

let CURRENT_TURNO = 'total';
let unsubscribe = null;

let state = {
  fecha: new Date().toISOString().slice(0,10),
  lineas: {
    LINEA001: {},
    LINEA007: {}
  }
};

const $grid = document.getElementById('grid-lineas');
const $lista = document.getElementById('lista-desvios');
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

const fmt = (n) => (n==null?'-':n.toLocaleString('es-AR'));
const pct = (x) => (isFinite(x) && x>=0 ? (x).toFixed(1).replace('.',',')+'%' : '-');
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const colorBy = (p)=> p>=100? 'b-green' : p>=80? 'b-yellow' : 'b-red';
function cumplimiento(plan, real){ return plan>0? (real/plan*100) : NaN; }
function aggregateLinea(lineaObj){
  let plan={t1:0,t2:0,t3:0,total:0}, real={t1:0,t2:0,t3:0,total:0}, litros={t1:0,t2:0,t3:0};
  for(const sabor in lineaObj){
    const it=lineaObj[sabor];
    ['t1','t2','t3','total'].forEach(k=>{ plan[k]+=it.plan?.[k]||0; real[k]+=it.real?.[k]||0 });
    ['t1','t2','t3'].forEach(k=>{ litros[k]+=it.litros?.[k]||0 });
  }
  return {plan,real,litros};
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

const LS = {
  key: (f)=>`cumplimiento_state_${f}`,
  save(fecha, data){ try{ localStorage.setItem(this.key(fecha), JSON.stringify(data)); }catch{} },
  load(fecha){ try{ const raw = localStorage.getItem(this.key(fecha)); return raw? JSON.parse(raw): null; }catch{ return null } }
};
function notify(msg){ if(!$banner) return; $banner.textContent = msg; $banner.hidden = false; setTimeout(()=>{ $banner.hidden = true; }, 2200); }

function render(data){
  const showEmpty = document.getElementById('toggleEmpty')?.checked;
  const lineasBase = showEmpty ? ALL_LINEAS : Object.keys(data.lineas);
  const lineas = lineasBase;

  $grid.innerHTML='';
  lineas.forEach(linea=>{
    const lineaObj = data.lineas[linea] || {};
    const agg = aggregateLinea(lineaObj);
    const p = CURRENT_TURNO==='total' ? agg.plan.total : agg.plan[CURRENT_TURNO];
    const r = CURRENT_TURNO==='total' ? agg.real.total : agg.real[CURRENT_TURNO];
    const c = cumplimiento(p,r);
    const badge = isFinite(c) ? colorBy(c) : 'b-yellow';

    const card = document.createElement('div');
    const isEmpty = ((p||0)===0 && (r||0)===0);
    const isCarga = document.getElementById('toggleCarga')?.checked;
    card.className='card' + (isEmpty && !isCarga ? ' muted' : '');
    card.innerHTML = `
      <h3>${linea}</h3>
      <div class="badge ${badge}">Cumplimiento ${pct(c)}</div>
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
    const btn = card.querySelector('button');
    btn.addEventListener('click',()=>openDetalle(linea));
    if (isEmpty && !isCarga) btn.setAttribute('disabled','true');
    $grid.appendChild(card);
  });

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

function openDetalle(linea){
  $mTitle.textContent = `Detalle · ${linea}`;
  $btnNuevoSabor.style.display = document.getElementById('toggleCarga')?.checked ? 'inline-block' : 'none';
  $btnNuevoSabor.onclick = ()=>openCarga(linea, null, /*isNew*/true);
  renderDetalle(linea);
  $modal.showModal();
}

function renderDetalle(linea){
  const productos = state.lineas[linea] || {};
  const keys = Object.keys(productos);
  $mBody.innerHTML='';

  if (keys.length===0){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" class="td-center hint">Sin datos para esta línea en la fecha seleccionada.</td>`;
    $mBody.appendChild(tr);
    return;
  }
  for(const sabor of keys){
    const it = productos[sabor];
    const p = CURRENT_TURNO==='total'? it.plan?.total||0: it.plan?.[CURRENT_TURNO]||0;
    const r = CURRENT_TURNO==='total'? it.real?.total||0: it.real?.[CURRENT_TURNO]||0;
    const l = CURRENT_TURNO==='total'? ((it.litros?.t1||0) + (it.litros?.t2||0) + (it.litros?.t3||0)) : (it.litros?.[CURRENT_TURNO]||0);
    const c = cumplimiento(p,r);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${sabor}</td>
      <td class="num">${fmt(p)}</td>
      <td class="num">${fmt(r)}</td>
      <td class="num">${pct(c)}</td>
      <td>
        <div class="progress"><span style="width:${isFinite(c)? clamp(c,0,130) : 0}%; background:${isFinite(c) ? (c>=100? 'linear-gradient(90deg,#16a34a,#22c55e)' : c>=80? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : 'linear-gradient(90deg,#ef4444,#f87171)') : '#1b2433'}"></span></div>
        ${(p>0 && r===0) ? '<div class="hint">⚠️ Hubo plan y no se produjo en este turno</div>' : ''}
      </td>
      <td class="num">${fmt(l)}</td>
      <td class="td-center">${ document.getElementById('toggleCarga')?.checked ? `<button class="primary" data-linea="${linea}" data-sabor="${sabor}">✏️ Cargar</button>` : ''}</td>
    `;
    if (document.getElementById('toggleCarga')?.checked){
      const btn = tr.querySelector('button.primary');
      btn?.addEventListener('click',()=>openCarga(linea, sabor, /*isNew*/false));
    }
    $mBody.appendChild(tr);
  }
}

let cargaCtx = { linea:null, sabor:null, isNew:false };

function openCarga(linea, sabor, isNew){
  const it = state.lineas[linea]?.[sabor] || { producto:'', plan:{t1:0,t2:0,t3:0,total:0}, real:{t1:0,t2:0,t3:0,total:0} };
  cargaCtx = { linea, sabor, isNew: !!isNew };
  $cLinea.textContent = linea;

  if (isNew){
    $cSaborInput.style.display='block';
    $cSaborRead.style.display='none';
    $cSaborInput.value = '';
  } else {
    $cSaborInput.style.display='none';
    $cSaborRead.style.display='inline-flex';
    $cSaborRead.textContent = sabor;
  }

  $cProducto.textContent = it.producto || (sabor || '');
  $plan_t1.value = it.plan?.t1 || 0;
  $plan_t2.value = it.plan?.t2 || 0;
  $plan_t3.value = it.plan?.t3 || 0;
  $real_t1.value = it.real?.t1 || 0;
  $real_t2.value = it.real?.t2 || 0;
  $real_t3.value = it.real?.t3 || 0;

  recalcCarga();
  $modalCarga.showModal();
}

function num(v){ const n = parseInt(v,10); return isNaN(n)?0:n; }
function recalcCarga(){
  const pt = num($plan_t1.value)+num($plan_t2.value)+num($plan_t3.value);
  const rt = num($real_t1.value)+num($real_t2.value)+num($real_t3.value);
  $plan_total.textContent = fmt(pt);
  $real_total.textContent = fmt(rt);
  const c = pt>0? (rt/pt*100) : NaN;
  $cumpl_pct.textContent = pct(c);
}
['input','change'].forEach(ev=>{
  [$plan_t1,$plan_t2,$plan_t3,$real_t1,$real_t2,$real_t3].forEach(el=>el.addEventListener(ev, recalcCarga));
});

function uniqueKeyForSabor(linea, base){
  if (!state.lineas[linea]) state.lineas[linea] = {};
  if (!(base in state.lineas[linea])) return base;
  let i=2;
  while ((base + ' ('+i+')') in state.lineas[linea]) i++;
  return base + ' ('+i+')';
}

async function guardarCarga(){
  const linea = cargaCtx.linea;
  let saborKey = cargaCtx.sabor;
  if (cargaCtx.isNew){
    const typed = ($cSaborInput.value || '').trim();
    if (!typed){ alert('Ingresá un nombre de sabor'); return; }
    saborKey = uniqueKeyForSabor(linea, typed);
  }

  const plan = { t1:num($plan_t1.value), t2:num($plan_t2.value), t3:num($plan_t3.value) };
  const real = { t1:num($real_t1.value), t2:num($real_t2.value), t3:num($real_t3.value) };
  plan.total = plan.t1 + plan.t2 + plan.t3;
  real.total = real.t1 + real.t2 + real.t3;

  const producto = $cProducto.textContent || saborKey;

  if (!state.lineas[linea]) state.lineas[linea] = {};
  state.lineas[linea][saborKey] = { ...(state.lineas[linea][saborKey]||{}), producto, plan, real };

  const fechaISO = $fecha.value || state.fecha;
  LS.save(fechaISO, state);

  if (FIREBASE_READY){
    try{
      const ref = doc(db, 'cumplimiento', fechaISO);
      await setDoc(ref, { lineas: { [linea]: { [saborKey]: { producto, plan, real } } } }, { merge:true });
      notify('Guardado en Firestore ✓');
    }catch(e){
      console.error('Error Firestore', e);
      notify('Guardado local (sin Firestore)');
    }
  } else {
    notify('Guardado local (Firebase no configurado)');
  }

  render(state);
  const lineName = document.getElementById('m-title').textContent.replace('Detalle · ','');
  if (lineName===linea) renderDetalle(linea);
  document.getElementById('modal-carga').close();
}
$btnGuardar.addEventListener('click', guardarCarga);

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

(function init(){
  $fecha.value = state.fecha;
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
  onAuthStateChanged(auth, (user)=>{
    subscribeToDate($fecha.value);
  });
})();

for(const btn of document.querySelectorAll('.toggle button')){
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.toggle button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    CURRENT_TURNO = btn.dataset.turno;
    render(state);
    const lineName = document.getElementById('m-title').textContent.replace('Detalle · ','');
    if (document.getElementById('modal-detalle').open) renderDetalle(lineName);
  });
}
const mTurnos = document.getElementById('m-turnos');
for(const btn of mTurnos.querySelectorAll('button')){
  btn.addEventListener('click',()=>{
    mTurnos.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    CURRENT_TURNO = btn.dataset.turno;
    const lineName = document.getElementById('m-title').textContent.replace('Detalle · ','');
    renderDetalle(lineName);
    render(state);
  });
}
document.getElementById('toggleEmpty')?.addEventListener('change',()=>render(state));
document.getElementById('toggleCarga')?.addEventListener('change',(e)=>{
  document.body.classList.toggle('carga', !!e.target.checked);
  const show = e.target.checked;
  if (document.getElementById('modal-detalle').open){
    document.getElementById('btn-nuevo-sabor').style.display = show ? 'inline-block' : 'none';
    const lineName = document.getElementById('m-title').textContent.replace('Detalle · ','');
    renderDetalle(lineName);
  }
});
$fecha.addEventListener('change', ()=>{
  const f = $fecha.value;
  const local = LS.load(f);
  state.fecha = f;
  state.lineas = local?.lineas || {};
  render(state);
  subscribeToDate(f);
});

window.dashboard = { subscribeToDate };
