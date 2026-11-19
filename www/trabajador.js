/* ==========================================================================
   CONTROL ULISES — TRABAJADOR (POS + PERMISOS + COLA OFFLINE INDEXEDDB)
   ========================================================================== */

const SUPABASE_URL = 'https://locrbjklkpyxwlchjeri.supabase.co';
const SUPABASE_KEY = 'sb_publishable_k6VjN8Vn-aao-zKXMt6G2w_vXPNQFMq';

const db = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

/* ---------------- ESTADO GLOBAL ---------------- */
const state = {
  categorias: [],
  productos: [],
  config: {
    nombre_trabajador: 'Trabajador Tienda',
    puede_editar_precio: false,
    puede_registrar_pedido: false
  },
  carrito: [], // [{ producto_id, nombre, precio_unitario, cantidad }]
  pendientes: [],
  enviadasHoy: [],
  categoriaActiva: 'todas',
  busquedaPos: '',
  busquedaStock: '',
  online: navigator.onLine,
  sincronizando: false,
  guardandoVenta: false,
  editandoPrecioId: null,
  editandoCantidadId: null,
  editandoFactura: null
};

/* ---------------- UTILIDADES ---------------- */
const $ = (id) => document.getElementById(id);

function money(val) {
  return `C$ ${Number(val || 0).toLocaleString('es-NI', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function fmtNum(val) {
  const n = Number(val || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generarIdLocal() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `loc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function inicioDeHoyISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function horaCorta(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, tipo = 'info') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${tipo !== 'info' ? `toast-${tipo}` : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

/* ---------------- INDEXEDDB (ALMACENAMIENTO OFFLINE) ---------------- */
const IDB_NAME = 'ControlUlisesTrabajadorDB';
const IDB_VERSION = 1;
let idbInstance = null;

function abrirIDB() {
  if (idbInstance) return Promise.resolve(idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('pendientes_ventas')) {
        database.createObjectStore('pendientes_ventas', { keyPath: 'id_local' });
      }
      if (!database.objectStoreNames.contains('cache')) {
        database.createObjectStore('cache', { keyPath: 'clave' });
      }
    };
    req.onsuccess = () => {
      idbInstance = req.result;
      resolve(idbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const database = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const database = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const database = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(storeName) {
  const database = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function guardarCache(clave, valor) {
  try {
    await idbPut('cache', { clave, valor, actualizado_en: Date.now() });
  } catch (err) {
    console.warn('Error guardando caché local:', err);
  }
}

async function leerCache(clave, fallback = null) {
  try {
    const res = await idbGet('cache', clave);
    return res ? res.valor : fallback;
  } catch {
    return fallback;
  }
}

/* ---------------- ESTADO DE RED Y BANNER ---------------- */
function actualizarUIEstadoRed() {
  const badge = $('badge-red');
  const textoRed = $('texto-red');
  const btnSyncHeader = $('btn-sync-header');
  const contadorHeader = $('contador-pendientes-header');
  const banner = $('banner-offline');
  const textoBanner = $('texto-banner-offline');

  const numPendientes = state.pendientes.length;
  contadorHeader.textContent = String(numPendientes);
  btnSyncHeader.classList.toggle('oculto', numPendientes === 0);

  if (state.online) {
    badge.className = 'pill pill-online';
    textoRed.textContent = 'En línea';
  } else {
    badge.className = 'pill pill-offline';
    textoRed.textContent = 'Sin internet';
  }

  if (!state.online) {
    banner.classList.remove('oculto');
    document.body.classList.add('con-banner-offline');
    textoBanner.textContent =
      numPendientes > 0
        ? `Sin internet. Tienes ${numPendientes} factura(s) guardadas en el teléfono sin enviar.`
        : 'Sin internet. Las ventas se guardarán en el teléfono y se enviarán al reconectar.';
  } else if (numPendientes > 0) {
    banner.classList.remove('oculto');
    document.body.classList.add('con-banner-offline');
    textoBanner.textContent = `Conexión lista. Tienes ${numPendientes} factura(s) pendientes por enviar al dueño.`;
  } else {
    banner.classList.add('oculto');
    document.body.classList.remove('con-banner-offline');
  }
}

/* ---------------- CARGA DE DATOS (NUBE + RESPALDO OFFLINE) ---------------- */
async function cargarDesdeCacheLocal() {
  state.categorias = await leerCache('categorias', []);
  state.productos = await leerCache('productos', []);
  state.config = await leerCache('config', state.config);
  state.enviadasHoy = await leerCache('enviadasHoy', []);
  state.pendientes = await idbGetAll('pendientes_ventas');
  state.pendientes.sort((a, b) => new Date(b.creada_en) - new Date(a.creada_en));

  aplicarPermisosUI();
  renderTodo();
}

async function cargarDesdeNube(silencioso = false) {
  if (!navigator.onLine || !db) {
    state.online = false;
    actualizarUIEstadoRed();
    return false;
  }

  try {
    const [resCats, resProds, resCfg, resVentas] = await Promise.all([
      db.from('categorias').select('*').order('nombre'),
      db.from('productos').select('*').eq('activo', true).order('nombre'),
      db.from('configuracion_trabajador').select('*').eq('id', 1).maybeSingle(),
      db
        .from('ventas')
        .select('id, id_local, total, creada_en, detalle_ventas(id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)')
        .gte('creada_en', inicioDeHoyISO())
        .order('creada_en', { ascending: false })
    ]);

    if (resCats.error) throw resCats.error;
    if (resProds.error) throw resProds.error;
    if (resCfg.error) throw resCfg.error;
    if (resVentas.error) throw resVentas.error;

    state.online = true;
    state.categorias = resCats.data || [];
    state.productos = resProds.data || [];
    if (resCfg.data) state.config = resCfg.data;
    state.enviadasHoy = resVentas.data || [];

    // Descontar visualmente las ventas offline que todavía no suben
    aplicarDescuentoPendientesEnMemoria();

    await Promise.all([
      guardarCache('categorias', state.categorias),
      guardarCache('productos', state.productos),
      guardarCache('config', state.config),
      guardarCache('enviadasHoy', state.enviadasHoy)
    ]);

    aplicarPermisosUI();
    renderTodo();
    return true;
  } catch (err) {
    console.warn('No se pudo conectar con Supabase:', err);
    if (!silencioso) {
      showToast('Trabajando con datos guardados en el teléfono', 'warning');
    }
    return false;
  }
}

function aplicarDescuentoPendientesEnMemoria() {
  if (!state.pendientes.length) return;
  const descontado = {};
  state.pendientes.forEach((venta) => {
    (venta.items || []).forEach((it) => {
      descontado[it.producto_id] = (descontado[it.producto_id] || 0) + Number(it.cantidad);
    });
  });

  state.productos = state.productos.map((p) => {
    const resta = descontado[p.id] || 0;
    return resta > 0
      ? { ...p, stock_actual: Math.max(0, Number(p.stock_actual) - resta) }
      : p;
  });
}

/* ---------------- PERMISOS CONTROLADOS POR ULISES ---------------- */
function aplicarPermisosUI() {
  $('subtitulo-trabajador').textContent = state.config.nombre_trabajador || 'Distribuidora Ulises';

  const puedePedido = Boolean(state.config.puede_registrar_pedido);
  $('nav-btn-pedido').classList.toggle('oculto', !puedePedido);
  $('alerta-sin-permiso-pedido').classList.toggle('oculto', puedePedido);
  $('form-entrada-trabajador').classList.toggle('oculto', !puedePedido);

  // Si estaba en la pestaña Pedido y Ulises le quitó el permiso, regresarlo a Vender
  if (!puedePedido && $('vista-pedido').classList.contains('activa')) {
    cambiarVista('vista-vender');
  }
}

/* ---------------- NAVEGACIÓN ---------------- */
function cambiarVista(vistaId) {
  document.querySelectorAll('.vista').forEach((v) => v.classList.remove('activa'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activa'));

  const target = $(vistaId);
  if (target) target.classList.add('activa');

  const btn = document.querySelector(`.nav-item[data-vista="${vistaId}"]`);
  if (btn) btn.classList.add('activa');

  // Mostrar barra de carrito solo en la vista de ventas si hay ítems
  actualizarBarraCarrito();
}

/* ---------------- RENDERIZADO DE INTERFAZ ---------------- */
function nombreCategoria(catId) {
  const c = state.categorias.find((x) => x.id === catId);
  return c ? c.nombre : 'General';
}

function renderTodo() {
  actualizarUIEstadoRed();
  renderChipsCategorias();
  renderGridProductos();
  renderListaStock();
  renderSelectEntrada();
  renderHistorial();
  actualizarBarraCarrito();
}

function renderChipsCategorias() {
  const cont = $('chips-categorias-pos');
  const chips = [
    `<button type="button" class="chip ${state.categoriaActiva === 'todas' ? 'activa' : ''}" data-categoria="todas">Todos</button>`,
    ...state.categorias.map(
      (c) =>
        `<button type="button" class="chip ${state.categoriaActiva === c.id ? 'activa' : ''}" data-categoria="${esc(c.id)}">${esc(c.nombre)}</button>`
    )
  ];
  cont.innerHTML = chips.join('');
}

function renderGridProductos() {
  const grid = $('grid-productos-pos');
  const q = state.busquedaPos.trim().toLowerCase();

  const filtrados = state.productos.filter((p) => {
    const matchCat = state.categoriaActiva === 'todas' || p.categoria_id === state.categoriaActiva;
    const matchTexto = !q || p.nombre.toLowerCase().includes(q);
    return matchCat && matchTexto;
  });

  if (!filtrados.length) {
    grid.innerHTML = `<div class="empty-state">No hay productos que coincidan.</div>`;
    return;
  }

  const disponibles = filtrados.filter((p) => Number(p.stock_actual || 0) > 0);
  const agotados = filtrados.filter((p) => Number(p.stock_actual || 0) <= 0);

  const renderCard = (p) => {
    const enCarrito = state.carrito.find((i) => i.producto_id === p.id);
    const stock = Number(p.stock_actual || 0);
    const min = Number(p.stock_minimo || 5);

    let badgeClase = '';
    let badgeTexto = `Quedan ${fmtNum(stock)}`;
    if (stock <= 0) {
      badgeClase = 'agotado';
      badgeTexto = 'Agotado';
    } else if (stock <= min) {
      badgeClase = 'bajo';
    }

    return `
      <button type="button" class="prod-card ${enCarrito ? 'en-carrito' : ''} ${stock <= 0 ? 'sin-stock' : ''}" data-prod-id="${esc(p.id)}">
        <div class="prod-card-top">
          <span class="prod-cat-tag">${esc(nombreCategoria(p.categoria_id))}</span>
          <span class="prod-stock-badge ${badgeClase}">${badgeTexto}</span>
        </div>
        <div class="prod-name">${esc(p.nombre)}</div>
        <div class="prod-card-bottom">
          <span class="prod-price">${money(p.precio_venta)}</span>
          ${enCarrito ? `<span class="prod-qty-pill">${fmtNum(enCarrito.cantidad)}</span>` : ''}
        </div>
      </button>
    `;
  };

  let html = disponibles.map(renderCard).join('');
  if (!disponibles.length && agotados.length) {
    html += `<div class="empty-state-sm" style="grid-column: 1 / -1;">No hay productos con existencia en esta categoría.</div>`;
  }
  if (agotados.length) {
    html += `<div class="grid-divider">Agotados (${agotados.length})</div>`;
    html += agotados.map(renderCard).join('');
  }

  grid.innerHTML = html;
}

function renderListaStock() {
  const cont = $('lista-stock-trabajador');
  const q = state.busquedaStock.trim().toLowerCase();
  const lista = state.productos.filter((p) => !q || p.nombre.toLowerCase().includes(q));

  if (!lista.length) {
    cont.innerHTML = `<div class="empty-state-sm">No se encontraron productos.</div>`;
    return;
  }

  cont.innerHTML = lista
    .map((p) => {
      const stock = Number(p.stock_actual || 0);
      const min = Number(p.stock_minimo || 5);
      const estadoClase = stock <= 0 ? 'badge-low' : stock <= min ? 'badge-pending' : 'badge-ok';
      const estadoTexto = stock <= 0 ? 'Agotado' : stock <= min ? 'Bajo' : 'Disponible';

      return `
        <div class="item-row">
          <div class="item-main">
            <div class="item-title">${esc(p.nombre)}</div>
            <div class="item-meta">
              <span>${esc(nombreCategoria(p.categoria_id))}</span>
              <span>•</span>
              <span>${money(p.precio_venta)}</span>
            </div>
          </div>
          <div class="item-right">
            <span class="item-amount">${fmtNum(stock)}</span>
            <span class="badge-status ${estadoClase}">${estadoTexto}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderSelectEntrada() {
  const select = $('select-producto-entrada');
  const actual = select.value;
  select.innerHTML =
    `<option value="">Selecciona un producto...</option>` +
    state.productos
      .map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)} (Stock: ${fmtNum(p.stock_actual)})</option>`)
      .join('');
  if (actual) select.value = actual;
  actualizarStockSelectEntrada();
}

function actualizarStockSelectEntrada() {
  const prod = state.productos.find((p) => p.id === $('select-producto-entrada').value);
  $('mostrar-stock-actual').value = prod ? fmtNum(prod.stock_actual) : '—';
}

function renderHistorial() {
  const totalEnviado = state.enviadasHoy.reduce((acc, v) => acc + Number(v.total || 0), 0);
  const totalPendiente = state.pendientes.reduce((acc, v) => acc + Number(v.total || 0), 0);

  $('kpi-trabajador-total').textContent = money(totalEnviado + totalPendiente);
  $('kpi-trabajador-pendientes').textContent = String(state.pendientes.length);

  const contPend = $('lista-pendientes-offline');
  if (!state.pendientes.length) {
    contPend.innerHTML = `<div class="empty-state-sm">Todas las ventas están sincronizadas con el dueño.</div>`;
  } else {
    contPend.innerHTML = state.pendientes
      .map((v) => {
        const resumen = (v.items || []).map((i) => `${fmtNum(i.cantidad)}x ${i.nombre}`).join(', ');
        return `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">Factura guardada sin internet</div>
              <div class="item-meta">
                <span>${horaCorta(v.creada_en)}</span>
                <span>•</span>
                <span>${esc(resumen)}</span>
              </div>
            </div>
            <div class="item-right">
              <span class="item-amount">${money(v.total)}</span>
              <div class="item-actions">
                <span class="badge-status badge-pending">No enviada</span>
                <button type="button" class="btn-edit-price" data-edit-venta="pendiente" data-venta-key="${esc(v.id_local)}">Editar</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  const contEnv = $('lista-enviadas-hoy');
  if (!state.enviadasHoy.length) {
    contEnv.innerHTML = `<div class="empty-state-sm">Aún no hay ventas sincronizadas hoy.</div>`;
  } else {
    contEnv.innerHTML = state.enviadasHoy
      .map((v) => {
        const items = v.detalle_ventas || [];
        const resumen = items.map((i) => `${fmtNum(i.cantidad)}x ${i.nombre_producto}`).join(', ');
        return `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">Venta registrada</div>
              <div class="item-meta">
                <span>${horaCorta(v.creada_en)}</span>
                ${resumen ? `<span>•</span><span>${esc(resumen)}</span>` : ''}
              </div>
            </div>
            <div class="item-right">
              <span class="item-amount">${money(v.total)}</span>
              <div class="item-actions">
                <span class="badge-status badge-synced">Enviada</span>
                <button type="button" class="btn-edit-price" data-edit-venta="enviada" data-venta-key="${esc(v.id)}">Editar</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

/* ---------------- CARRITO Y COBRO ---------------- */
function agregarAlCarrito(productoId) {
  const prod = state.productos.find((p) => p.id === productoId);
  if (!prod) return;

  const existente = state.carrito.find((i) => i.producto_id === productoId);
  const nuevaCant = existente ? Number(existente.cantidad) + 1 : 1;

  if (Number(prod.stock_actual) <= 0) {
    showToast(`Sin stock registrado de ${prod.nombre}`, 'warning');
  } else if (nuevaCant > Number(prod.stock_actual)) {
    showToast(`Solo quedan ${fmtNum(prod.stock_actual)} de ${prod.nombre}`, 'warning');
  }

  if (existente) {
    existente.cantidad = nuevaCant;
  } else {
    state.carrito.push({
      producto_id: prod.id,
      nombre: prod.nombre,
      precio_unitario: Number(prod.precio_venta),
      cantidad: 1
    });
  }

  renderGridProductos();
  actualizarBarraCarrito();
}

function calcularTotalCarrito() {
  return state.carrito.reduce((sum, i) => sum + Number(i.cantidad) * Number(i.precio_unitario), 0);
}

function actualizarBarraCarrito() {
  const barra = $('barra-carrito');
  const enVistaVender = $('vista-vender').classList.contains('activa');

  if (!state.carrito.length || !enVistaVender) {
    barra.classList.add('oculto');
    return;
  }

  const totalItems = state.carrito.reduce((sum, i) => sum + Number(i.cantidad), 0);
  $('carrito-cantidad-badge').textContent = fmtNum(totalItems);
  $('carrito-total-barra').textContent = money(calcularTotalCarrito());
  barra.classList.remove('oculto');
}

function abrirModalCarrito() {
  renderModalCarrito();
  $('input-pago-con').value = '';
  actualizarVuelto();
  $('modal-carrito').classList.remove('oculto');
}

function cerrarModalCarrito() {
  $('modal-carrito').classList.add('oculto');
}

function renderModalCarrito() {
  const cont = $('lista-items-carrito');
  const puedeEditarPrecio = Boolean(state.config.puede_editar_precio);

  if (!state.carrito.length) {
    cerrarModalCarrito();
    renderGridProductos();
    actualizarBarraCarrito();
    return;
  }

  cont.innerHTML = state.carrito
    .map((item) => {
      const sub = Number(item.cantidad) * Number(item.precio_unitario);
      return `
        <div class="cart-item" data-id="${esc(item.producto_id)}">
          <div class="cart-item-info">
            <div class="cart-item-title">${esc(item.nombre)}</div>
            <div class="cart-item-price-row">
              <span>${money(item.precio_unitario)} c/u</span>
              <span>•</span>
              <strong>${money(sub)}</strong>
              ${
                puedeEditarPrecio
                  ? `<button type="button" class="btn-edit-price" data-action="edit-price" data-id="${esc(item.producto_id)}">Cambiar precio</button>`
                  : ''
              }
            </div>
          </div>

          <div class="qty-control">
            <button type="button" class="qty-btn" data-action="minus" data-id="${esc(item.producto_id)}" aria-label="Restar">−</button>
            <button type="button" class="qty-val" data-action="manual-qty" data-id="${esc(item.producto_id)}" title="Toca para escribir cantidad exacta (ej. 0.5)">${fmtNum(item.cantidad)}</button>
            <button type="button" class="qty-btn" data-action="plus" data-id="${esc(item.producto_id)}" aria-label="Sumar">+</button>
          </div>
        </div>
      `;
    })
    .join('');

  $('total-modal-carrito').textContent = money(calcularTotalCarrito());
  actualizarVuelto();
}

function actualizarVuelto() {
  const total = calcularTotalCarrito();
  const pagaCon = Number($('input-pago-con').value || 0);
  const el = $('texto-vuelto');
  if (pagaCon <= 0) {
    el.textContent = 'C$ 0.00';
    el.className = '';
    return;
  }
  const diff = pagaCon - total;
  if (diff < 0) {
    el.textContent = `Faltan ${money(Math.abs(diff))}`;
    el.className = 'text-danger';
  } else {
    el.textContent = money(diff);
    el.className = 'text-success';
  }
}

/* ---------------- MODAL CANTIDAD INTELIGENTE POR CATEGORÍA ---------------- */
function obtenerPresetsCantidad(producto) {
  const nombre = (producto?.nombre || '').toLowerCase();
  const cat = nombreCategoria(producto?.categoria_id).toLowerCase();

  if (nombre.includes('huevo')) {
    return {
      etiqueta: 'Unidades / Cajillas',
      opciones: [
        { val: 1, txt: '1' },
        { val: 6, txt: '6' },
        { val: 12, txt: '12' },
        { val: 15, txt: '15' },
        { val: 30, txt: '30 (Caj)' },
        { val: 60, txt: '60' }
      ]
    };
  }

  const esGranoOAlimento =
    cat.includes('grano') ||
    cat.includes('alimento') ||
    /ma[ií]z|arroz|frijol|az[uú]car|purina|semolina|ponedora|campe[oó]n|comida|girasol|mijo|nugallo|vio pic/.test(nombre);

  if (esGranoOAlimento) {
    return {
      etiqueta: 'Libras / Quintales rápidos',
      opciones: [
        { val: 1, txt: '1 lb' },
        { val: 5, txt: '5 lb' },
        { val: 10, txt: '10 lb' },
        { val: 15, txt: '15 lb' },
        { val: 25, txt: '25 lb' },
        { val: 50, txt: '50 lb' },
        { val: 75, txt: '75 lb' },
        { val: 100, txt: '100 lb' }
      ]
    };
  }

  const esLacteo = cat.includes('lácteo') || cat.includes('lacteo') || /queso|crema|cuajada|quesillo/.test(nombre);
  if (esLacteo) {
    return {
      etiqueta: 'Libras rápidas (Lácteos)',
      opciones: [
        { val: 0.25, txt: '¼ lb' },
        { val: 0.5, txt: '½ lb' },
        { val: 1, txt: '1 lb' },
        { val: 1.5, txt: '1.5 lb' },
        { val: 2, txt: '2 lb' },
        { val: 3, txt: '3 lb' },
        { val: 5, txt: '5 lb' },
        { val: 10, txt: '10 lb' }
      ]
    };
  }

  return {
    etiqueta: 'Cantidades rápidas',
    opciones: [
      { val: 1, txt: '1' },
      { val: 2, txt: '2' },
      { val: 3, txt: '3' },
      { val: 5, txt: '5' },
      { val: 10, txt: '10' },
      { val: 12, txt: '12' },
      { val: 20, txt: '20' },
      { val: 25, txt: '25' }
    ]
  };
}

function abrirModalCantidad(productoId) {
  const item = state.carrito.find((i) => i.producto_id === productoId);
  if (!item) return;

  const prod = state.productos.find((p) => p.id === productoId);
  const { etiqueta, opciones } = obtenerPresetsCantidad(prod || { nombre: item.nombre });

  state.editandoCantidadId = productoId;
  $('titulo-modal-cantidad').textContent = item.nombre;
  $('subtitulo-modal-cantidad').textContent = `${nombreCategoria(prod?.categoria_id)} • Stock: ${fmtNum(prod?.stock_actual || 0)}`;
  $('label-presets-cantidad').textContent = etiqueta;
  $('input-cantidad-manual').value = fmtNum(item.cantidad);

  $('grid-presets-cantidad').innerHTML = opciones
    .map(
      (op) => `
        <button type="button" class="preset-btn ${Number(item.cantidad) === op.val ? 'activo' : ''}" data-preset-val="${op.val}">
          ${op.txt}
        </button>
      `
    )
    .join('');

  $('modal-cantidad').classList.remove('oculto');
  $('input-cantidad-manual').focus();
}

function cerrarModalCantidad() {
  $('modal-cantidad').classList.add('oculto');
  state.editandoCantidadId = null;
}

function aplicarCantidadManual(valorDirecto = null) {
  const val = valorDirecto !== null ? Number(valorDirecto) : Number($('input-cantidad-manual').value);
  if (isNaN(val) || val < 0) {
    showToast('Ingresa una cantidad válida', 'error');
    return;
  }

  const id = state.editandoCantidadId;
  if (val === 0) {
    state.carrito = state.carrito.filter((i) => i.producto_id !== id);
  } else {
    const item = state.carrito.find((i) => i.producto_id === id);
    if (item) item.cantidad = val;
  }

  cerrarModalCantidad();
  renderModalCarrito();
  renderGridProductos();
  actualizarBarraCarrito();
}

/* ---------------- EDITAR PRECIO (SI TIENE PERMISO) ---------------- */
function abrirModalEditarPrecio(productoId) {
  if (!state.config.puede_editar_precio) {
    showToast('Ulises no ha habilitado la edición de precios', 'warning');
    return;
  }
  const item = state.carrito.find((i) => i.producto_id === productoId);
  if (!item) return;

  state.editandoPrecioId = productoId;
  $('nombre-producto-precio').textContent = item.nombre;
  $('input-nuevo-precio').value = item.precio_unitario;
  $('check-actualizar-precio-base').checked = false;
  $('modal-editar-precio').classList.remove('oculto');
}

async function aplicarNuevoPrecio() {
  const nuevoPrecio = Number($('input-nuevo-precio').value);
  if (isNaN(nuevoPrecio) || nuevoPrecio < 0) {
    showToast('Ingresa un precio válido', 'error');
    return;
  }

  const item = state.carrito.find((i) => i.producto_id === state.editandoPrecioId);
  if (item) {
    item.precio_unitario = nuevoPrecio;
  }

  // Opcionalmente actualizar en el catálogo general si hay conexión
  if ($('check-actualizar-precio-base').checked && state.editandoPrecioId) {
    const prod = state.productos.find((p) => p.id === state.editandoPrecioId);
    if (prod) prod.precio_venta = nuevoPrecio;
    await guardarCache('productos', state.productos);

    if (navigator.onLine && db) {
      const { error } = await db
        .from('productos')
        .update({ precio_venta: nuevoPrecio, actualizado_en: new Date().toISOString() })
        .eq('id', state.editandoPrecioId);
      if (error) {
        showToast('Precio cambiado solo en esta venta (sin conexión al catálogo)', 'warning');
      } else {
        showToast('Precio actualizado en el catálogo', 'success');
      }
    }
  }

  $('modal-editar-precio').classList.add('oculto');
  state.editandoPrecioId = null;
  renderModalCarrito();
  renderGridProductos();
  actualizarBarraCarrito();
}

/* ---------------- GUARDAR VENTA (ONLINE U OFFLINE) ---------------- */
async function subirVentaASupabase(ventaPayload) {
  if (!db) throw new Error('Cliente Supabase no disponible');

  // 1. Insertar cabecera de venta (id_local único evita duplicados)
  const { data: ventaCreada, error: errVenta } = await db
    .from('ventas')
    .insert({
      id_local: ventaPayload.id_local,
      total: ventaPayload.total,
      origen_dispositivo: 'android_trabajador',
      creada_en: ventaPayload.creada_en
    })
    .select()
    .single();

  if (errVenta) {
    // Código 23505 = ya existía esa venta (sincronizada antes)
    if (errVenta.code === '23505') {
      return { yaExistia: true };
    }
    throw errVenta;
  }

  // 2. Insertar detalle de productos vendidos
  const detalles = ventaPayload.items.map((it) => ({
    venta_id: ventaCreada.id,
    producto_id: it.producto_id,
    nombre_producto: it.nombre,
    cantidad: Number(it.cantidad),
    precio_unitario: Number(it.precio_unitario),
    subtotal: Number(it.cantidad) * Number(it.precio_unitario)
  }));

  const { error: errDet } = await db.from('detalle_ventas').insert(detalles);
  if (errDet) throw errDet;

  // 3. Descontar stock real y registrar movimientos de salida
  for (const it of ventaPayload.items) {
    const { data: prodActual } = await db
      .from('productos')
      .select('stock_actual')
      .eq('id', it.producto_id)
      .maybeSingle();

    if (prodActual) {
      const nuevoStock = Math.max(0, Number(prodActual.stock_actual) - Number(it.cantidad));
      await db
        .from('productos')
        .update({ stock_actual: nuevoStock, actualizado_en: new Date().toISOString() })
        .eq('id', it.producto_id);
    }

    await db.from('movimientos_inventario').insert({
      producto_id: it.producto_id,
      tipo: 'venta',
      cantidad: -Math.abs(Number(it.cantidad)),
      nota: `Venta ${ventaPayload.id_local.slice(0, 8)}`
    });
  }

  return { yaExistia: false, venta: ventaCreada };
}

async function confirmarVenta() {
  if (!state.carrito.length || state.guardandoVenta) return;
  state.guardandoVenta = true;

  const btn = $('btn-confirmar-venta');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  const ventaPayload = {
    id_local: generarIdLocal(),
    total: Number(calcularTotalCarrito().toFixed(2)),
    creada_en: new Date().toISOString(),
    items: state.carrito.map((i) => ({ ...i }))
  };

  let enviada = false;

  if (navigator.onLine && db) {
    try {
      await subirVentaASupabase(ventaPayload);
      enviada = true;
    } catch (err) {
      console.warn('Fallo de red al enviar venta, guardando offline:', err);
      enviada = false;
    }
  }

  if (enviada) {
    state.carrito = [];
    cerrarModalCarrito();
    showToast('Venta registrada y enviada al dueño', 'success');
    await cargarDesdeNube(true);
  } else {
    // Guardar en cola offline IndexedDB
    await idbPut('pendientes_ventas', ventaPayload);
    state.pendientes.unshift(ventaPayload);

    // Restar del stock local en caché para mantener control inmediato
    ventaPayload.items.forEach((it) => {
      const p = state.productos.find((x) => x.id === it.producto_id);
      if (p) p.stock_actual = Math.max(0, Number(p.stock_actual) - Number(it.cantidad));
    });
    await guardarCache('productos', state.productos);

    state.online = navigator.onLine;
    state.carrito = [];
    cerrarModalCarrito();
    renderTodo();

    showToast(
      'Guardada en el teléfono (SIN INTERNET). Aún no se ha enviado al dueño.',
      'warning'
    );
  }

  btn.disabled = false;
  btn.textContent = 'Confirmar y guardar venta';
  state.guardandoVenta = false;
}

/* ---------------- SINCRONIZACIÓN DE FACTURAS PENDIENTES ---------------- */
async function sincronizarPendientes(manual = false) {
  if (state.sincronizando) return;
  if (!state.pendientes.length) {
    if (manual) showToast('No hay facturas pendientes por enviar', 'success');
    return;
  }
  if (!navigator.onLine || !db) {
    state.online = false;
    actualizarUIEstadoRed();
    if (manual) showToast('Aún sin internet. Intenta cuando tengas señal.', 'warning');
    return;
  }

  state.sincronizando = true;
  const btn = $('btn-sincronizar-ahora');
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  let subidas = 0;
  // Subir de la más antigua a la más reciente
  const cola = [...state.pendientes].reverse();

  for (const venta of cola) {
    try {
      await subirVentaASupabase(venta);
      await idbDelete('pendientes_ventas', venta.id_local);
      state.pendientes = state.pendientes.filter((v) => v.id_local !== venta.id_local);
      subidas++;
    } catch (err) {
      console.warn('Error sincronizando factura:', venta.id_local, err);
      break; // Si se volvió a caer el internet, detener y conservar las restantes
    }
  }

  btn.disabled = false;
  btn.textContent = 'Sincronizar';
  state.sincronizando = false;

  if (subidas > 0) {
    showToast(`${subidas} factura(s) enviadas y actualizadas al dueño`, 'success');
    await cargarDesdeNube(true);
  } else if (manual) {
    showToast('No se pudo conectar todavía. Se conservan guardadas.', 'warning');
  }
  renderTodo();
}

/* ---------------- REGISTRO DE PEDIDO (SI TIENE PERMISO) ---------------- */
async function registrarEntradaTrabajador(e) {
  e.preventDefault();
  if (!state.config.puede_registrar_pedido) {
    showToast('No tienes permiso para registrar pedidos', 'warning');
    return;
  }
  if (!navigator.onLine || !db) {
    showToast('Necesitas internet para registrar llegada de mercadería', 'warning');
    return;
  }

  const productoId = $('select-producto-entrada').value;
  const cantidad = Number($('input-cantidad-entrada').value);
  const nota = $('input-nota-entrada').value.trim();

  if (!productoId || isNaN(cantidad) || cantidad <= 0) {
    showToast('Selecciona un producto y una cantidad válida', 'error');
    return;
  }

  try {
    const { data: prodActual, error: errProd } = await db
      .from('productos')
      .select('stock_actual, nombre')
      .eq('id', productoId)
      .single();
    if (errProd) throw errProd;

    const nuevoStock = Number(prodActual.stock_actual) + cantidad;

    const { error: errUpd } = await db
      .from('productos')
      .update({ stock_actual: nuevoStock, actualizado_en: new Date().toISOString() })
      .eq('id', productoId);
    if (errUpd) throw errUpd;

    const { error: errMov } = await db.from('movimientos_inventario').insert({
      producto_id: productoId,
      tipo: 'entrada',
      cantidad,
      nota: nota || 'Entrada registrada por trabajador'
    });
    if (errMov) throw errMov;

    $('form-entrada-trabajador').reset();
    showToast(`Se sumaron ${fmtNum(cantidad)} a ${prodActual.nombre}`, 'success');
    await cargarDesdeNube(true);
  } catch (err) {
    console.error(err);
    showToast('Error al guardar el pedido. Intenta de nuevo.', 'error');
  }
}

/* ---------------- EDITAR FACTURA / DEVOLUCIONES ---------------- */
function abrirModalEditarFactura(tipo, key) {
  let venta = null;
  let items = [];

  if (tipo === 'pendiente') {
    venta = state.pendientes.find((v) => v.id_local === key);
    if (!venta) return;
    items = (venta.items || []).map((i) => ({
      producto_id: i.producto_id,
      nombre: i.nombre,
      precio_unitario: Number(i.precio_unitario || 0),
      cantidad: Number(i.cantidad || 0)
    }));
  } else {
    if (!navigator.onLine || !db) {
      showToast('Necesitas internet para editar una factura ya enviada al dueño', 'warning');
      return;
    }
    venta = state.enviadasHoy.find((v) => v.id === key);
    if (!venta) return;
    items = (venta.detalle_ventas || []).map((i) => ({
      producto_id: i.producto_id,
      nombre: i.nombre_producto,
      precio_unitario: Number(i.precio_unitario || 0),
      cantidad: Number(i.cantidad || 0)
    }));
  }

  state.editandoFactura = {
    tipo,
    venta,
    totalOriginal: Number(venta.total || 0),
    itemsOriginales: items.map((i) => ({ ...i })),
    itemsEditados: items.map((i) => ({ ...i }))
  };

  $('subtitulo-editar-factura').textContent = `Hora: ${horaCorta(venta.creada_en)} • Pon en 0 lo devuelto`;
  $('input-motivo-edicion').value = '';

  const sel = $('select-agregar-prod-factura');
  sel.innerHTML =
    `<option value="">+ Agregar producto faltante...</option>` +
    state.productos
      .map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)} (${money(p.precio_venta)})</option>`)
      .join('');

  renderModalEditarFactura();
  $('modal-editar-factura').classList.remove('oculto');
}

function cerrarModalEditarFactura() {
  $('modal-editar-factura').classList.add('oculto');
  state.editandoFactura = null;
}

function renderModalEditarFactura() {
  const ed = state.editandoFactura;
  if (!ed) return;

  const cont = $('lista-items-editar-factura');
  cont.innerHTML = ed.itemsEditados
    .map((item, idx) => {
      const sub = Number(item.cantidad) * Number(item.precio_unitario);
      return `
        <div class="cart-item">
          <div class="cart-item-info">
            <div class="cart-item-title">${esc(item.nombre)}</div>
            <div class="cart-item-price-row">
              <span>${money(item.precio_unitario)} c/u</span>
              <span>•</span>
              <strong>${money(sub)}</strong>
              ${Number(item.cantidad) === 0 ? `<span class="badge-status badge-low">Devuelto</span>` : ''}
            </div>
          </div>

          <div class="qty-control">
            <button type="button" class="qty-btn" data-ed-action="minus" data-idx="${idx}">−</button>
            <input type="number" step="0.01" min="0" class="edit-qty-input" data-ed-input="${idx}" value="${fmtNum(item.cantidad)}" />
            <button type="button" class="qty-btn" data-ed-action="plus" data-idx="${idx}">+</button>
          </div>
        </div>
      `;
    })
    .join('');

  actualizarResumenEdicionFactura();
}

function actualizarResumenEdicionFactura() {
  const ed = state.editandoFactura;
  if (!ed) return;

  const nuevoTotal = ed.itemsEditados.reduce(
    (s, i) => s + Number(i.cantidad || 0) * Number(i.precio_unitario || 0),
    0
  );
  const diff = nuevoTotal - ed.totalOriginal;

  $('total-antes-edicion').textContent = money(ed.totalOriginal);
  $('total-nuevo-edicion').textContent = money(nuevoTotal);

  const lbl = $('label-dif-edicion');
  const txt = $('texto-dif-edicion');
  if (Math.abs(diff) < 0.005) {
    lbl.textContent = 'Diferencia:';
    txt.textContent = 'Sin cambio';
    txt.className = '';
  } else if (diff < 0) {
    lbl.textContent = 'Devolver al cliente:';
    txt.textContent = money(Math.abs(diff));
    txt.className = 'text-danger';
  } else {
    lbl.textContent = 'Cobrar diferencia:';
    txt.textContent = `+${money(diff)}`;
    txt.className = 'text-success';
  }
}

function agregarProductoAFacturaEditada() {
  const ed = state.editandoFactura;
  const prodId = $('select-agregar-prod-factura').value;
  if (!ed || !prodId) return;

  const prod = state.productos.find((p) => p.id === prodId);
  if (!prod) return;

  const existente = ed.itemsEditados.find((i) => i.producto_id === prodId);
  if (existente) {
    existente.cantidad = Number((Number(existente.cantidad) + 1).toFixed(2));
  } else {
    ed.itemsEditados.push({
      producto_id: prod.id,
      nombre: prod.nombre,
      precio_unitario: Number(prod.precio_venta || 0),
      cantidad: 1
    });
  }

  $('select-agregar-prod-factura').value = '';
  renderModalEditarFactura();
}

async function guardarEdicionFactura() {
  const ed = state.editandoFactura;
  if (!ed) return;

  const itemsValidos = ed.itemsEditados.filter((i) => Number(i.cantidad) > 0);
  const anularCompleta = itemsValidos.length === 0;

  if (
    anularCompleta &&
    !confirm('Todas las cantidades están en 0. ¿Anular esta factura y devolver todo el stock al inventario?')
  ) {
    return;
  }

  const nuevoTotal = Number(
    itemsValidos.reduce((s, i) => s + Number(i.cantidad) * Number(i.precio_unitario), 0).toFixed(2)
  );
  const motivo = $('input-motivo-edicion').value.trim();

  // Calcular diferencia exacta de cantidad por cada producto
  const mapaAntes = new Map();
  ed.itemsOriginales.forEach((i) => {
    if (!i.producto_id) return;
    const prev = mapaAntes.get(i.producto_id) || { nombre: i.nombre, cantidad: 0 };
    prev.cantidad += Number(i.cantidad || 0);
    mapaAntes.set(i.producto_id, prev);
  });

  const mapaDespues = new Map();
  itemsValidos.forEach((i) => {
    if (!i.producto_id) return;
    const prev = mapaDespues.get(i.producto_id) || { nombre: i.nombre, cantidad: 0 };
    prev.cantidad += Number(i.cantidad || 0);
    mapaDespues.set(i.producto_id, prev);
  });

  const todosIds = new Set([...mapaAntes.keys(), ...mapaDespues.keys()]);
  const cambiosStock = [];
  todosIds.forEach((pid) => {
    const qAntes = mapaAntes.get(pid)?.cantidad || 0;
    const qDespues = mapaDespues.get(pid)?.cantidad || 0;
    const diffVenta = Number((qDespues - qAntes).toFixed(2));
    if (diffVenta !== 0) {
      const nombre = mapaDespues.get(pid)?.nombre || mapaAntes.get(pid)?.nombre || 'Producto';
      // Si se vendió menos (devolución), deltaStock es positivo (entra al inventario)
      cambiosStock.push({
        producto_id: pid,
        nombre,
        qAntes,
        qDespues,
        deltaStock: Number((-diffVenta).toFixed(2))
      });
    }
  });

  const btn = $('btn-guardar-edicion-factura');
  btn.disabled = true;
  btn.textContent = 'Actualizando...';

  try {
    if (ed.tipo === 'pendiente') {
      // Actualizar factura offline en IndexedDB y stock en caché local
      cambiosStock.forEach((c) => {
        const p = state.productos.find((x) => x.id === c.producto_id);
        if (p) p.stock_actual = Math.max(0, Number(p.stock_actual) + c.deltaStock);
      });
      await guardarCache('productos', state.productos);

      if (anularCompleta) {
        await idbDelete('pendientes_ventas', ed.venta.id_local);
        state.pendientes = state.pendientes.filter((v) => v.id_local !== ed.venta.id_local);
        showToast('Factura offline anulada y stock restaurado', 'success');
      } else {
        const actualizada = {
          ...ed.venta,
          total: nuevoTotal,
          items: itemsValidos.map((i) => ({ ...i }))
        };
        await idbPut('pendientes_ventas', actualizada);
        state.pendientes = state.pendientes.map((v) =>
          v.id_local === actualizada.id_local ? actualizada : v
        );
        showToast('Factura offline corregida', 'success');
      }

      cerrarModalEditarFactura();
      renderTodo();
    } else {
      if (!navigator.onLine || !db) throw new Error('Sin conexión a internet');

      const idCorto = String(ed.venta.id_local || ed.venta.id).slice(0, 8);

      // 1. Actualizar stock real y dejar historial exacto en movimientos_inventario
      for (const c of cambiosStock) {
        const { data: prodActual } = await db
          .from('productos')
          .select('stock_actual')
          .eq('id', c.producto_id)
          .maybeSingle();

        if (prodActual) {
          const stockFinal = Math.max(0, Number(prodActual.stock_actual) + c.deltaStock);
          const { error: errSt } = await db
            .from('productos')
            .update({ stock_actual: stockFinal, actualizado_en: new Date().toISOString() })
            .eq('id', c.producto_id);
          if (errSt) throw errSt;
        }

        const accionTexto = c.deltaStock > 0 ? 'Devolución' : 'Ajuste venta';
        const notaMov = `${accionTexto} fact. ${idCorto} (${fmtNum(c.qAntes)} → ${fmtNum(c.qDespues)})${motivo ? `: ${motivo}` : ''}`;

        const { error: errMov } = await db.from('movimientos_inventario').insert({
          producto_id: c.producto_id,
          tipo: 'ajuste',
          cantidad: c.deltaStock,
          nota: notaMov
        });
        if (errMov) throw errMov;
      }

      // 2. Actualizar factura y su detalle completo
      if (anularCompleta) {
        const { error: errDelV } = await db.from('ventas').delete().eq('id', ed.venta.id);
        if (errDelV) throw errDelV;
        showToast('Factura anulada y stock devuelto al inventario', 'success');
      } else {
        const { error: errDelD } = await db
          .from('detalle_ventas')
          .delete()
          .eq('venta_id', ed.venta.id);
        if (errDelD) throw errDelD;

        const nuevosDetalles = itemsValidos.map((it) => ({
          venta_id: ed.venta.id,
          producto_id: it.producto_id,
          nombre_producto: it.nombre,
          cantidad: Number(it.cantidad),
          precio_unitario: Number(it.precio_unitario),
          subtotal: Number((Number(it.cantidad) * Number(it.precio_unitario)).toFixed(2))
        }));

        const { error: errInsD } = await db.from('detalle_ventas').insert(nuevosDetalles);
        if (errInsD) throw errInsD;

        const { error: errUpdV } = await db
          .from('ventas')
          .update({ total: nuevoTotal })
          .eq('id', ed.venta.id);
        if (errUpdV) throw errUpdV;

        showToast('Factura y stock actualizados correctamente', 'success');
      }

      cerrarModalEditarFactura();
      await cargarDesdeNube(true);
    }
  } catch (err) {
    console.error('Error editando factura:', err);
    showToast(`No se pudo actualizar: ${err.message || 'intenta de nuevo'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios y actualizar stock';
  }
}

/* ---------------- EVENTOS E INICIO ---------------- */
function bindEventos() {
  // Navegación inferior
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => cambiarVista(btn.dataset.vista));
  });

  // Buscadores
  $('input-buscar-pos').addEventListener('input', (e) => {
    state.busquedaPos = e.target.value;
    renderGridProductos();
  });
  $('input-buscar-stock').addEventListener('input', (e) => {
    state.busquedaStock = e.target.value;
    renderListaStock();
  });

  // Categorías
  $('chips-categorias-pos').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.categoriaActiva = chip.dataset.categoria;
    renderChipsCategorias();
    renderGridProductos();
  });

  // Tocar producto en el POS
  $('grid-productos-pos').addEventListener('click', (e) => {
    const card = e.target.closest('.prod-card');
    if (!card) return;
    agregarAlCarrito(card.dataset.prodId);
  });

  // Carrito
  $('btn-abrir-carrito').addEventListener('click', abrirModalCarrito);
  $('btn-cerrar-carrito').addEventListener('click', cerrarModalCarrito);
  $('btn-vaciar-carrito').addEventListener('click', () => {
    state.carrito = [];
    cerrarModalCarrito();
    renderGridProductos();
    actualizarBarraCarrito();
  });
  $('input-pago-con').addEventListener('input', actualizarVuelto);
  $('btn-confirmar-venta').addEventListener('click', confirmarVenta);

  // Acciones dentro del carrito (+, -, cantidad manual, editar precio)
  $('lista-items-carrito').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const item = state.carrito.find((i) => i.producto_id === id);
    if (!item) return;

    if (action === 'plus') {
      item.cantidad = Number((Number(item.cantidad) + 1).toFixed(2));
    } else if (action === 'minus') {
      item.cantidad = Number((Number(item.cantidad) - 1).toFixed(2));
      if (item.cantidad <= 0) {
        state.carrito = state.carrito.filter((i) => i.producto_id !== id);
      }
    } else if (action === 'manual-qty') {
      abrirModalCantidad(id);
      return;

    } else if (action === 'edit-price') {
      abrirModalEditarPrecio(id);
      return;
    }

    renderModalCarrito();
    renderGridProductos();
    actualizarBarraCarrito();
  });

  // Modal editar precio
  $('btn-cerrar-modal-precio').addEventListener('click', () => $('modal-editar-precio').classList.add('oculto'));
  $('btn-cancelar-precio').addEventListener('click', () => $('modal-editar-precio').classList.add('oculto'));
  $('btn-aplicar-precio').addEventListener('click', aplicarNuevoPrecio);

  $('btn-cerrar-modal-cantidad').addEventListener('click', cerrarModalCantidad);
  $('btn-cancelar-cantidad').addEventListener('click', cerrarModalCantidad);
  $('btn-aplicar-cantidad').addEventListener('click', () => aplicarCantidadManual());
  $('grid-presets-cantidad').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset-val]');
    if (!btn) return;
    aplicarCantidadManual(btn.dataset.presetVal);
  });

  // Pedido / Stock / Sincronización
  $('select-producto-entrada').addEventListener('change', actualizarStockSelectEntrada);
  $('form-entrada-trabajador').addEventListener('submit', registrarEntradaTrabajador);
  $('btn-recargar-stock').addEventListener('click', () => cargarDesdeNube(false));
  $('btn-sync-header').addEventListener('click', () => sincronizarPendientes(true));
  $('btn-sincronizar-ahora').addEventListener('click', () => sincronizarPendientes(true));

  // Editar facturas en historial
  $('vista-historial').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit-venta]');
    if (!btn) return;
    abrirModalEditarFactura(btn.dataset.editVenta, btn.dataset.ventaKey);
  });

  $('btn-cerrar-editar-factura').addEventListener('click', cerrarModalEditarFactura);
  $('btn-agregar-prod-factura').addEventListener('click', agregarProductoAFacturaEditada);
  $('btn-guardar-edicion-factura').addEventListener('click', guardarEdicionFactura);

  $('lista-items-editar-factura').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ed-action]');
    if (!btn || !state.editandoFactura) return;
    const idx = Number(btn.dataset.idx);
    const item = state.editandoFactura.itemsEditados[idx];
    if (!item) return;

    if (btn.dataset.edAction === 'plus') {
      item.cantidad = Number((Number(item.cantidad) + 1).toFixed(2));
    } else if (btn.dataset.edAction === 'minus') {
      item.cantidad = Math.max(0, Number((Number(item.cantidad) - 1).toFixed(2)));
    }
    renderModalEditarFactura();
  });

  $('lista-items-editar-factura').addEventListener('input', (e) => {
    const inp = e.target.closest('[data-ed-input]');
    if (!inp || !state.editandoFactura) return;
    const idx = Number(inp.dataset.edInput);
    const item = state.editandoFactura.itemsEditados[idx];
    if (!item) return;
    const val = Number(inp.value);
    item.cantidad = !isNaN(val) && val >= 0 ? val : 0;
    actualizarResumenEdicionFactura();
  });

  // Eventos de conexión del teléfono
  window.addEventListener('online', async () => {
    state.online = true;
    actualizarUIEstadoRed();
    showToast('Conexión recuperada. Sincronizando...', 'info');
    await sincronizarPendientes(false);
    await cargarDesdeNube(true);
  });

  window.addEventListener('offline', () => {
    state.online = false;
    actualizarUIEstadoRed();
    showToast('Sin internet. Puedes seguir vendiendo en modo offline.', 'warning');
  });

  // Refresco suave de permisos y catálogo cada 45s si hay internet
  setInterval(() => {
    if (navigator.onLine && !state.sincronizando && !state.guardandoVenta) {
      if (state.pendientes.length > 0) {
        sincronizarPendientes(false);
      } else {
        cargarDesdeNube(true);
      }
    }
  }, 45000);
}

async function initTrabajador() {
  bindEventos();
  await cargarDesdeCacheLocal();
  if (navigator.onLine) {
    await sincronizarPendientes(false);
    await cargarDesdeNube(true);
  }
}

document.addEventListener('DOMContentLoaded', initTrabajador);