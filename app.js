/**
 * app.js — Scout Pro · Mundial 2026
 * ============================================================
 * Arquitectura: ES6 Modules + Firebase v10 (CDN)
 * Responsabilidades:
 *   1. Inicialización de Firebase
 *   2. Listeners reactivos con onSnapshot (partidos + noticias)
 *   3. Renderizado de tarjetas de partido
 *   4. Algoritmo matemático de apuesta de valor (EV)
 *   5. Filtros por fase / grupo
 *   6. Reloj en tiempo real
 *   7. Toggle de tema claro/oscuro
 *   8. Sistema de toasts para errores
 * ============================================================
 */

// ============================================================
// IMPORTS — Firebase v10 (CDN)
// Ajusta la versión (10.x.x) según la release más reciente de Firebase.
// https://firebase.google.com/support/release-notes/js
// ============================================================
import { initializeApp }                  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, collection, onSnapshot, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ============================================================
// CONFIGURACIÓN DE FIREBASE
// ⚠️  REEMPLAZA ESTOS VALORES con los de tu proyecto en:
//     https://console.firebase.google.com → Configuración del proyecto
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBw4aBVVfhwQhPlzu1eg3UJLCt1dERkBcE",
  authDomain: "apuestale-al-mundial.firebaseapp.com",
  projectId: "apuestale-al-mundial",
  storageBucket: "apuestale-al-mundial.firebasestorage.app",
  messagingSenderId: "1006112947114",
  appId: "1:1006112947114:web:1b4e85bffac9c340c889d3",
  measurementId: "G-HBJS255ZR9"
};

// ============================================================
// INICIALIZACIÓN
// ============================================================
const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);

// ============================================================
// ESTADO DE LA APLICACIÓN
// ============================================================
/** @type {Map<string, Object>} Mapa docId → datos del partido */
const matchesStore = new Map();

/** @type {string} Filtro activo: 'all' | 'eliminatoria' | string de grupo 'A'–'L' */
let activeFilter = 'all';

// ============================================================
// SELECTORES DEL DOM
// ============================================================
const matchesContainer = /** @type {HTMLElement} */ (document.getElementById('matches-container'));
const loadingState     = /** @type {HTMLElement} */ (document.getElementById('loading-state'));
const emptyState       = /** @type {HTMLElement} */ (document.getElementById('empty-state'));
const matchCount       = /** @type {HTMLElement} */ (document.getElementById('match-count'));
const clockDisplay     = /** @type {HTMLElement} */ (document.getElementById('clock-display'));
const newsList         = /** @type {HTMLElement} */ (document.getElementById('news-list'));
const newsLoading      = /** @type {HTMLElement} */ (document.getElementById('news-loading'));
const toastContainer   = /** @type {HTMLElement} */ (document.getElementById('toast-container'));
const themeSwitch      = /** @type {HTMLInputElement} */ (document.getElementById('theme-switch'));
const navButtons       = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.nav-btn'));
const groupSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('group-select'));

// ============================================================
// RELOJ EN TIEMPO REAL
// ============================================================

/**
 * Inicia un interval que actualiza el elemento del reloj cada segundo.
 * Usa el locale 'es-CO' para formato HH:mm:ss en zona UTC-5.
 */
function startClock() {
  const updateClock = () => {
    const now = new Date();
    clockDisplay.textContent = now.toLocaleTimeString('es-CO', {
      timeZone:    'America/Bogota',
      hour12:      false,
      hour:        '2-digit',
      minute:      '2-digit',
      second:      '2-digit',
    });
  };
  updateClock();
  setInterval(updateClock, 1000);
}

// ============================================================
// TEMA CLARO / OSCURO
// ============================================================

/**
 * Aplica el tema al <html> y persiste la preferencia en localStorage.
 * @param {'dark' | 'light'} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeSwitch.checked        = theme === 'light';
  themeSwitch.ariaChecked    = String(theme === 'light');
  localStorage.setItem('scout-pro-theme', theme);
}

/**
 * Inicializa el tema: respeta la preferencia guardada o la del sistema.
 */
function initTheme() {
  const saved    = localStorage.getItem('scout-pro-theme');
  const prefDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ?? (prefDark ? 'dark' : 'light'));
}

themeSwitch.addEventListener('change', () => {
  applyTheme(themeSwitch.checked ? 'light' : 'dark');
});

// ============================================================
// SISTEMA DE TOASTS
// ============================================================

/**
 * Muestra una notificación tipo toast.
 * @param {string}  message  Texto a mostrar
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 * @param {number}  [duration=4000]  ms antes de desaparecer
 */
function showToast(message, type = 'info', duration = 4000) {
  const ICONS = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };

  const toast = document.createElement('div');
  toast.className    = `toast ${type}`;
  toast.role         = 'alert';
  toast.innerHTML    = `
    <span class="toast-icon" aria-hidden="true">${ICONS[type]}</span>
    <span class="toast-msg">${message}</span>
  `;
  toastContainer.appendChild(toast);

  // Auto-eliminar después de `duration` ms
  setTimeout(() => {
    toast.style.opacity   = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================
// ALGORITMO DE APUESTA DE VALOR
// ============================================================

/**
 * Calcula si una cuota representa una apuesta de valor positivo (+EV).
 *
 * Reglas aplicadas:
 *  1. Sólo evaluar cuotas decimales entre 1.30 y 2.00 (mercados líquidos)
 *  2. EV = (probabilidad * cuota) - 1; si EV > 0 → apuesta de valor
 *  3. Badge: probabilidad > 0.75 = 🟢 Fuerte | 0.50–0.75 = 🟡 Moderado | <0.50 = 🔴 Descartado
 *
 * @param {number} probability  Probabilidad implícita (0–1) de que ocurra el evento
 * @param {number} odds         Cuota decimal ofrecida por la casa de apuestas
 * @returns {{
 *   isValue: boolean,
 *   ev: number,
 *   confidence: 'strong' | 'moderate' | 'discard',
 *   label: string,
 *   emoji: string
 * } | null}  null si la cuota está fuera del rango evaluable
 */
function calculateValueBet(probability, odds) {
  // Regla 1: rango de cuotas evaluable
  if (odds < 1.30 || odds > 2.00) return null;

  // Regla 2: Valor Esperado
  const ev = (probability * odds) - 1;

  // Regla 3: badge de confiabilidad por probabilidad
  let confidence, label, emoji;
  if (probability > 0.75) {
    confidence = 'strong';
    label      = 'Fuerte';
    emoji      = '🟢';
  } else if (probability >= 0.50) {
    confidence = 'moderate';
    label      = 'Moderado';
    emoji      = '🟡';
  } else {
    confidence = 'discard';
    label      = 'Descartado';
    emoji      = '🔴';
  }

  return {
    isValue: ev > 0,
    ev:      parseFloat(ev.toFixed(4)),
    confidence,
    label,
    emoji,
  };
}

// ============================================================
// FUNCIONES DE RENDERIZADO
// ============================================================

/**
 * Genera el HTML de los 5 últimos resultados de un equipo.
 * @param {string[]} formArray  Array de 'W' | 'D' | 'L', máx. 5 elementos
 * @returns {string}  HTML de los puntos de racha
 */
function renderFormDots(formArray = []) {
  if (!Array.isArray(formArray) || formArray.length === 0) {
    return '<span style="color:var(--text-muted);font-size:0.7rem">Sin datos</span>';
  }
  return formArray
    .slice(0, 5)
    .map(result => {
      const safeResult = ['W', 'D', 'L'].includes(result) ? result : 'D';
      const labels = { W: 'G', D: 'E', L: 'P' };
      return `<span class="form-dot ${safeResult}" title="${safeResult}">${labels[safeResult]}</span>`;
    })
    .join('');
}

/**
 * Renderiza el bloque de apuesta de valor dentro de la tarjeta.
 * Devuelve string vacío si no aplica o si la cuota está fuera del rango.
 *
 * @param {Object} partido  Documento de Firestore
 * @returns {string}  HTML del bloque de apuesta o ''
 */
function renderValueBetBlock(partido) {
  const { odds = {}, probabilidad } = partido;

  // Sólo evaluamos si tenemos datos de cuotas y probabilidad
  if (!odds.local || !probabilidad) return '';

  const result = calculateValueBet(probabilidad, odds.local);
  if (!result) return '';

  const evClass = result.ev > 0 ? 'vb-ev-positive' : result.ev === 0 ? 'vb-ev-neutral' : 'vb-ev-negative';
  const evSign  = result.ev >= 0 ? '+' : '';

  return `
    <div class="card-value-bet">
      <div class="value-bet-header">
        <span class="value-bet-title">Análisis de Valor</span>
        <span class="confidence-badge ${result.confidence}">
          ${result.emoji} ${result.label}
        </span>
      </div>
      <div class="value-bet-details">
        <div class="vb-item">
          <span class="vb-label">Cuota</span>
          <span class="vb-value">${odds.local.toFixed(2)}</span>
        </div>
        <div class="vb-item">
          <span class="vb-label">Prob.</span>
          <span class="vb-value">${(probabilidad * 100).toFixed(0)}%</span>
        </div>
        <div class="vb-item">
          <span class="vb-label">EV</span>
          <span class="vb-value ${evClass}">${evSign}${result.ev.toFixed(3)}</span>
        </div>
        <div class="vb-item">
          <span class="vb-label">Mercado</span>
          <span class="vb-value">${result.isValue ? '✅ Valor' : '❌ Sin valor'}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Función pura que genera el HTML completo de una tarjeta de partido.
 * No produce efectos secundarios: recibe datos, devuelve string HTML.
 *
 * Estructura del documento Firestore esperado:
 * {
 *   id:          string,
 *   grupo:       string,          // 'A'–'L' o null para eliminatoria
 *   fase:        string,          // 'grupo' | 'octavos' | 'cuartos' | 'semis' | 'final'
 *   fechaHora:   Timestamp,       // Firebase Timestamp
 *   estado:      string,          // 'programado' | 'en_curso' | 'finalizado'
 *   equipoLocal:  { nombre, bandera, goles },
 *   equipoVisita: { nombre, bandera, goles },
 *   stats: {
 *     posesionLocal:  number (0–100),
 *     tarjetasLocal:  number,
 *     cornersLocal:   number,
 *     tarjetasVisita: number,
 *     cornersVisita:  number,
 *   },
 *   formaLocal:   string[],  // últimos 5: ['W','D','L','W','W']
 *   formaVisita:  string[],
 *   odds:         { local: number, empate: number, visita: number },
 *   probabilidad: number (0–1),
 * }
 *
 * @param {Object} partido  Documento de Firestore (con .id)
 * @returns {string}  HTML de la tarjeta
 */
function renderMatchCard(partido) {
  const {
    id,
    grupo,
    fase        = 'grupo',
    fechaHora,
    estado      = 'programado',
    equipoLocal  = {},
    equipoVisita = {},
    stats        = {},
    formaLocal   = [],
    formaVisita  = [],
    odds         = {},
    probabilidad,
  } = partido;

  // --- Determinar si tiene apuesta de valor para aplicar clase CSS ---
  const valueBetResult = probabilidad && odds.local
    ? calculateValueBet(probabilidad, odds.local)
    : null;
  const isValueBet = valueBetResult?.isValue === true;

  // --- Formatear fecha ---
  let fechaFormateada = '—';
  if (fechaHora?.toDate) {
    // Es un Firebase Timestamp
    fechaFormateada = fechaHora.toDate().toLocaleDateString('es-CO', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } else if (fechaHora) {
    // Puede ser un string ISO desde datos mock
    fechaFormateada = new Date(fechaHora).toLocaleDateString('es-CO', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  // --- Estado del partido ---
  const ESTADO_MAP = {
    programado: { label: 'Programado', cls: 'scheduled' },
    en_curso:   { label: '● EN VIVO',  cls: 'live' },
    finalizado: { label: 'Final',      cls: 'finished' },
  };
  const estadoInfo = ESTADO_MAP[estado] ?? ESTADO_MAP.programado;

  // --- Marcador ---
  const golesLocal  = equipoLocal.goles  ?? '—';
  const golesVisita = equipoVisita.goles ?? '—';
  const marcador    = estado !== 'programado'
    ? `${golesLocal} – ${golesVisita}`
    : 'VS';

  // --- Etiqueta de fase/grupo ---
  const faseLabel = grupo
    ? `Grupo ${grupo}`
    : (fase.charAt(0).toUpperCase() + fase.slice(1));

  // --- Posesión ---
  const posLocal  = stats.posesionLocal  ?? 50;
  const posVisita = 100 - posLocal;

  // --- HTML de la tarjeta ---
  return `
    <article
      class="match-card${isValueBet ? ' is-value-bet' : ''}"
      data-id="${id}"
      data-grupo="${grupo ?? ''}"
      data-fase="${fase}"
      aria-label="Partido: ${equipoLocal.nombre ?? 'Local'} vs ${equipoVisita.nombre ?? 'Visitante'}"
    >

      <!-- Cabecera: fase + fecha -->
      <div class="card-meta">
        <span class="card-phase">${faseLabel}</span>
        <time class="card-date" datetime="${fechaHora?.toDate?.()?.toISOString?.() ?? fechaHora ?? ''}">
          ${fechaFormateada}
        </time>
      </div>

      <!-- Enfrentamiento -->
      <div class="card-matchup">
        <div class="team team--home">
          <span class="team-flag" role="img" aria-label="Bandera de ${equipoLocal.nombre ?? 'equipo local'}">
            ${equipoLocal.bandera ?? '🏳️'}
          </span>
          <span class="team-name">${equipoLocal.nombre ?? 'Local'}</span>
        </div>

        <div class="score-block">
          <span class="score-main">${marcador}</span>
          <span
            class="score-status ${estadoInfo.cls}"
            aria-label="Estado: ${estadoInfo.label}"
          >
            ${estadoInfo.label}
          </span>
        </div>

        <div class="team team--away">
          <span class="team-flag" role="img" aria-label="Bandera de ${equipoVisita.nombre ?? 'equipo visitante'}">
            ${equipoVisita.bandera ?? '🏳️'}
          </span>
          <span class="team-name">${equipoVisita.nombre ?? 'Visitante'}</span>
        </div>
      </div>

      <!-- Estadísticas clave -->
      <div class="card-stats" aria-label="Estadísticas del partido">
        <div class="stat-item">
          <span class="stat-value">${stats.tarjetasLocal ?? 0}</span>
          <span class="stat-label">🟨 Local</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${stats.cornersLocal ?? 0}</span>
          <span class="stat-label">🚩 Córn. L</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${stats.tarjetasVisita ?? 0}</span>
          <span class="stat-label">🟨 Visit.</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${stats.cornersVisita ?? 0}</span>
          <span class="stat-label">🚩 Córn. V</span>
        </div>

        <!-- Barra de posesión -->
        <div class="possession-bar-wrapper" aria-label="Posesión: ${posLocal}% local, ${posVisita}% visitante">
          <div class="possession-labels">
            <span>${equipoLocal.nombre ?? 'Local'} ${posLocal}%</span>
            <span>${posVisita}% ${equipoVisita.nombre ?? 'Visitante'}</span>
          </div>
          <div class="possession-bar" role="progressbar" aria-valuenow="${posLocal}" aria-valuemin="0" aria-valuemax="100">
            <div class="possession-fill" style="width: ${posLocal}%"></div>
          </div>
        </div>
      </div>

      <!-- Racha de forma -->
      <div class="card-form">
        <span class="form-label">Forma</span>
        <div class="form-dots" aria-label="Últimos 5 partidos del equipo local">
          ${renderFormDots(formaLocal)}
        </div>
        <span class="form-label" style="margin-left: auto;">vs</span>
        <div class="form-dots" aria-label="Últimos 5 partidos del equipo visitante">
          ${renderFormDots(formaVisita)}
        </div>
      </div>

      <!-- Bloque de apuesta de valor (solo si aplica) -->
      ${renderValueBetBlock(partido)}

    </article>
  `;
}

/**
 * Genera el HTML de un item de noticia para el panel lateral.
 * @param {Object} noticia  Documento de Firestore de la colección `noticias`
 * @returns {string}  HTML del item
 */
function renderNewsItem(noticia) {
  const {
    equipo     = 'General',
    titular    = 'Sin titular',
    timestamp,
  } = noticia;

  let tiempoRelativo = '';
  if (timestamp?.toDate) {
    const diffMs  = Date.now() - timestamp.toDate().getTime();
    const diffMin = Math.floor(diffMs / 60000);
    tiempoRelativo = diffMin < 60
      ? `Hace ${diffMin} min`
      : `Hace ${Math.floor(diffMin / 60)} h`;
  }

  return `
    <li class="news-item" role="listitem">
      <span class="news-item-team">${equipo}</span>
      <p class="news-item-headline">${titular}</p>
      ${tiempoRelativo ? `<time class="news-item-time">${tiempoRelativo}</time>` : ''}
    </li>
  `;
}

// ============================================================
// FILTRADO Y RENDERIZADO DEL GRID
// ============================================================

/**
 * Filtra el store de partidos según el filtro activo y
 * (re)renderiza todas las tarjetas en el grid.
 * Gestiona también la visibilidad de loading/empty states.
 */
function renderFilteredMatches() {
  let partidos = Array.from(matchesStore.values());

  // Aplicar filtro
  if (activeFilter === 'eliminatoria') {
    partidos = partidos.filter(p => p.fase !== 'grupo');
  } else if (activeFilter !== 'all') {
    // Filtro por grupo (A–L)
    partidos = partidos.filter(p => p.grupo === activeFilter);
  }

  // Actualizar contador
  matchCount.textContent = String(partidos.length);

  if (partidos.length === 0) {
    matchesContainer.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  matchesContainer.classList.remove('hidden');

  // Generar y reinyectar HTML en el contenedor
  matchesContainer.innerHTML = partidos
    .map(p => renderMatchCard(p))
    .join('');
}

/**
 * Muestra el estado de carga (skeletons) y oculta el grid.
 */
function showLoading() {
  loadingState.classList.remove('hidden');
  matchesContainer.classList.add('hidden');
  emptyState.classList.add('hidden');
}

/**
 * Oculta el estado de carga y muestra el grid.
 */
function hideLoading() {
  loadingState.classList.add('hidden');
}

// ============================================================
// LISTENERS DE FIREBASE (onSnapshot)
// ============================================================

/**
 * Inicia el listener reactivo de la colección `partidos`.
 * onSnapshot se vuelve a llamar cada vez que cambia un documento.
 */
function subscribeToMatches() {
  const q = query(
    collection(db, 'partidos'),
    orderBy('fechaHora', 'asc')
  );

  return onSnapshot(
    q,
    (snapshot) => {
      // Actualizar el store local con los cambios incrementales
      snapshot.docChanges().forEach(change => {
        if (change.type === 'removed') {
          matchesStore.delete(change.doc.id);
        } else {
          // 'added' o 'modified'
          matchesStore.set(change.doc.id, {
            id: change.doc.id,
            ...change.doc.data(),
          });
        }
      });

      hideLoading();
      renderFilteredMatches();
    },
    (error) => {
      // Error del listener (ej. permiso denegado, red caída)
      console.error('[Scout Pro] Error en listener de partidos:', error);
      hideLoading();
      showToast(
        `Error al cargar partidos: ${error.message}`,
        'error',
        6000
      );
    }
  );
}

/**
 * Inicia el listener reactivo de la colección `noticias`.
 * Renderiza las últimas 20 noticias ordenadas por timestamp desc.
 */
function subscribeToNews() {
  const q = query(
    collection(db, 'noticias'),
    orderBy('timestamp', 'desc')
  );

  return onSnapshot(
    q,
    (snapshot) => {
      // Tomar hasta 20 documentos más recientes
      const noticias = snapshot.docs
        .slice(0, 20)
        .map(doc => ({ id: doc.id, ...doc.data() }));

      newsLoading.classList.add('hidden');
      newsList.classList.remove('hidden');

      if (noticias.length === 0) {
        newsList.innerHTML = `
          <li class="news-item">
            <p class="news-item-headline" style="color:var(--text-muted)">Sin novedades recientes.</p>
          </li>
        `;
        return;
      }

      newsList.innerHTML = noticias.map(renderNewsItem).join('');
    },
    (error) => {
      console.error('[Scout Pro] Error en listener de noticias:', error);
      newsLoading.classList.add('hidden');
      showToast(`Error al cargar noticias: ${error.message}`, 'warning');
    }
  );
}

// ============================================================
// CONTROLES DE FILTRO
// ============================================================

/**
 * Actualiza el estado visual de los botones de navegación y
 * asigna el filtro activo.
 * @param {string} filter
 */
function setActiveFilter(filter) {
  activeFilter = filter;

  // Actualizar estado ARIA de botones
  navButtons.forEach(btn => {
    const isActive = btn.dataset.filter === filter;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // Si es un filtro de grupo, limpiar los botones de fase
  if (['all', 'eliminatoria'].includes(filter)) {
    groupSelect.value = '';
  }

  renderFilteredMatches();
}

// Botones de fase (Todos / Eliminatoria)
navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    setActiveFilter(btn.dataset.filter);
  });
});

// Selector de grupo A–L
groupSelect.addEventListener('change', () => {
  const value = groupSelect.value;
  if (!value) {
    // Restaurar a "Todos" si se selecciona la opción vacía
    setActiveFilter('all');
    return;
  }
  // Desactivar botones de fase
  navButtons.forEach(btn => {
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
  });
  activeFilter = value;
  renderFilteredMatches();
});

// ============================================================
// PUNTO DE ENTRADA PRINCIPAL
// ============================================================

/**
 * Bootstrap de la aplicación.
 * Orden: tema → reloj → estado inicial → listeners Firebase.
 */
function init() {
  initTheme();
  startClock();
  showLoading();

  // Suscribirse a Firestore (los unsubscribers se guardan por si
  // se necesita limpiar en una SPA con router)
  const unsubMatches = subscribeToMatches();
  const unsubNews    = subscribeToNews();

  // Limpiar suscripciones si la página se descarga
  window.addEventListener('beforeunload', () => {
    unsubMatches();
    unsubNews();
  });
}

// Arrancar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', init);
