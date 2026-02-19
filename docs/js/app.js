/* ============================================
   ESPRESSO DIAL-IN TRACKER - App Logic
   ============================================ */

(function () {
  'use strict';

  const BEANS_URL = 'data/beans.json';

  let allBeans = [];
  let activeRoast = 'all';

  // ── Bootstrap ──────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const res = await fetch(BEANS_URL);
      if (!res.ok) throw new Error('Failed to load beans data');
      allBeans = await res.json();
      renderStats();
      renderFilters();
      renderGrid(allBeans);
      bindEvents();
    } catch (err) {
      console.error(err);
      document.getElementById('beans-grid').innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">&#9749;</div>' +
        '<p class="empty-state-text">Could not load beans data.</p></div>';
    }
  }

  // ── Stats ──────────────────────────────────
  function renderStats() {
    const statsEl = document.getElementById('header-stats');
    const totalBeans = allBeans.length;
    const roasters = new Set(allBeans.map(b => b.roaster)).size;
    const origins = new Set(allBeans.flatMap(b => b.origin ? [b.origin] : [])).size;

    statsEl.innerHTML =
      `<div class="stat-item"><span class="stat-value">${totalBeans}</span> beans</div>` +
      `<div class="stat-item"><span class="stat-value">${roasters}</span> roasters</div>` +
      `<div class="stat-item"><span class="stat-value">${origins}</span> origins</div>`;
  }

  // ── Filters ────────────────────────────────
  function renderFilters() {
    const container = document.getElementById('filter-chips');
    const roasts = ['all', ...new Set(allBeans.map(b => b.roast_level).filter(Boolean))];

    container.innerHTML = roasts.map(r =>
      `<button class="chip${r === 'all' ? ' active' : ''}" data-roast="${r}">${capitalize(r)}</button>`
    ).join('');

    container.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      activeRoast = chip.dataset.roast;
      container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      applyFilters();
    });
  }

  // ── Search & Filter ────────────────────────
  function bindEvents() {
    const searchInput = document.getElementById('search');
    let debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(applyFilters, 200);
    });

    // Modal close
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
  }

  function applyFilters() {
    const query = document.getElementById('search').value.toLowerCase().trim();

    let filtered = allBeans;

    if (activeRoast !== 'all') {
      filtered = filtered.filter(b => b.roast_level === activeRoast);
    }

    if (query) {
      filtered = filtered.filter(b => {
        const haystack = [
          b.name, b.roaster, b.origin, b.roast_level,
          ...(b.tasting_notes || []),
          b.notes || ''
        ].join(' ').toLowerCase();
        return haystack.includes(query);
      });
    }

    renderGrid(filtered);
  }

  // ── Grid Rendering ─────────────────────────
  function renderGrid(beans) {
    const grid = document.getElementById('beans-grid');

    if (beans.length === 0) {
      grid.innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">&#128270;</div>' +
        '<p class="empty-state-text">No beans match your search.</p></div>';
      return;
    }

    grid.innerHTML = beans.map((bean, i) => {
      const roastClass = roastToClass(bean.roast_level);
      const stars = renderStars(bean.rating || 0);
      const tags = (bean.tasting_notes || [])
        .map(t => `<span class="bean-tag">${t}</span>`).join('');

      return `
        <div class="bean-card" data-index="${allBeans.indexOf(bean)}" style="animation-delay: ${i * 0.06}s">
          <div class="bean-card-header">
            <div>
              <div class="bean-name">${esc(bean.name)}</div>
              <div class="bean-roaster">${esc(bean.roaster)}</div>
            </div>
            <span class="bean-roast-badge ${roastClass}">${esc(bean.roast_level || 'N/A')}</span>
          </div>
          <div class="bean-params">
            <div class="param">
              <div class="param-label">Grind</div>
              <div class="param-value">${bean.grind_size}<span class="param-unit"></span></div>
            </div>
            <div class="param">
              <div class="param-label">Dose</div>
              <div class="param-value">${bean.dose_g}<span class="param-unit">g</span></div>
            </div>
            <div class="param">
              <div class="param-label">Yield</div>
              <div class="param-value">${bean.yield_g}<span class="param-unit">g</span></div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <div class="bean-tags">${tags}</div>
            <div class="bean-rating">${stars}</div>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.bean-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index, 10);
        openModal(allBeans[idx]);
      });
    });
  }

  // ── Modal ──────────────────────────────────
  function openModal(bean) {
    const body = document.getElementById('modal-body');
    const stars = renderStars(bean.rating || 0);
    const tags = (bean.tasting_notes || [])
      .map(t => `<span class="bean-tag">${t}</span>`).join('');

    const ratio = bean.dose_g && bean.yield_g
      ? `1:${(bean.yield_g / bean.dose_g).toFixed(1)}`
      : 'N/A';

    body.innerHTML = `
      <div class="modal-header">
        <div class="modal-bean-name">${esc(bean.name)}</div>
        <div class="modal-roaster">${esc(bean.roaster)}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Dial-In Settings</div>
        <div class="modal-params-grid">
          <div class="modal-param">
            <div class="modal-param-label">Grind Size</div>
            <div class="modal-param-value">${bean.grind_size}</div>
          </div>
          <div class="modal-param">
            <div class="modal-param-label">Dose</div>
            <div class="modal-param-value">${bean.dose_g}<span class="modal-param-unit">g</span></div>
          </div>
          <div class="modal-param">
            <div class="modal-param-label">Yield</div>
            <div class="modal-param-value">${bean.yield_g}<span class="modal-param-unit">g</span></div>
          </div>
          <div class="modal-param">
            <div class="modal-param-label">Ratio</div>
            <div class="modal-param-value">${ratio}</div>
          </div>
          ${bean.time_s ? `
          <div class="modal-param">
            <div class="modal-param-label">Shot Time</div>
            <div class="modal-param-value">${bean.time_s}<span class="modal-param-unit">s</span></div>
          </div>` : ''}
          ${bean.temp_c ? `
          <div class="modal-param">
            <div class="modal-param-label">Temp</div>
            <div class="modal-param-value">${typeof bean.temp_c === 'number' ? bean.temp_c + '<span class="modal-param-unit">&deg;C</span>' : esc(String(bean.temp_c))}</div>
          </div>` : ''}
        </div>
      </div>

      ${bean.tasting_notes && bean.tasting_notes.length ? `
      <div class="modal-section">
        <div class="modal-section-title">Tasting Notes</div>
        <div class="bean-tags">${tags}</div>
      </div>` : ''}

      ${bean.notes ? `
      <div class="modal-section">
        <div class="modal-section-title">Notes</div>
        <div class="modal-notes">${esc(bean.notes)}</div>
      </div>` : ''}

      <div class="modal-section">
        <div class="modal-section-title">Details</div>
        <div class="modal-meta">
          ${bean.origin ? `<div class="modal-meta-item"><span class="modal-origin-flag">${originFlag(bean.origin)}</span> ${esc(bean.origin)}</div>` : ''}
          ${bean.roast_level ? `<div class="modal-meta-item"><span class="bean-roast-badge ${roastToClass(bean.roast_level)}">${esc(bean.roast_level)}</span></div>` : ''}
          ${bean.rating ? `<div class="modal-meta-item">${stars}</div>` : ''}
          ${bean.date_added ? `<div class="modal-meta-item">Added ${esc(bean.date_added)}</div>` : ''}
        </div>
      </div>
    `;

    document.getElementById('modal-overlay').classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
    document.body.style.overflow = '';
  }

  // ── Helpers ────────────────────────────────
  function roastToClass(roast) {
    if (!roast) return '';
    const r = roast.toLowerCase().replace(/[\s-]+/g, '-');
    if (r.includes('light')) return 'roast-light';
    if (r === 'medium-dark' || r === 'medium dark') return 'roast-medium-dark';
    if (r.includes('medium')) return 'roast-medium';
    if (r.includes('dark')) return 'roast-dark';
    return 'roast-medium';
  }

  function renderStars(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += `<span class="bean-rating-star${i <= rating ? ' filled' : ''}">&#9733;</span>`;
    }
    return html;
  }

  function capitalize(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }

  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function originFlag(origin) {
    const flags = {
      'ethiopia': '\u{1F1EA}\u{1F1F9}',
      'colombia': '\u{1F1E8}\u{1F1F4}',
      'brazil': '\u{1F1E7}\u{1F1F7}',
      'guatemala': '\u{1F1EC}\u{1F1F9}',
      'kenya': '\u{1F1F0}\u{1F1EA}',
      'costa rica': '\u{1F1E8}\u{1F1F7}',
      'indonesia': '\u{1F1EE}\u{1F1E9}',
      'peru': '\u{1F1F5}\u{1F1EA}',
      'mexico': '\u{1F1F2}\u{1F1FD}',
      'honduras': '\u{1F1ED}\u{1F1F3}',
      'el salvador': '\u{1F1F8}\u{1F1FB}',
      'rwanda': '\u{1F1F7}\u{1F1FC}',
      'panama': '\u{1F1F5}\u{1F1E6}',
      'india': '\u{1F1EE}\u{1F1F3}',
      'vietnam': '\u{1F1FB}\u{1F1F3}',
      'jamaica': '\u{1F1EF}\u{1F1F2}',
      'tanzania': '\u{1F1F9}\u{1F1FF}',
      'nicaragua': '\u{1F1F3}\u{1F1EE}',
      'yemen': '\u{1F1FE}\u{1F1EA}',
      'blend': '\u{1F30D}',
    };
    const key = (origin || '').toLowerCase();
    for (const [country, flag] of Object.entries(flags)) {
      if (key.includes(country)) return flag;
    }
    return '\u{2615}';
  }

})();
