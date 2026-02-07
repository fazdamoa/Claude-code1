/**
 * Main application logic for the Torrent Library.
 * Handles login, data loading, search, filtering, and UI rendering.
 */
const App = (() => {
  // State
  let library = null;       // Decrypted library data
  let searchIndex = [];      // Precomputed search text for each item
  let filteredItems = [];    // Current filtered/search results
  let currentView = "grid";  // "grid" or "list"
  let currentFilter = "all"; // "all", "movie", "tv"

  // DOM refs
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Initialization ----

  function init() {
    // Check for existing session
    const savedPassword = Crypto.getSession();
    if (savedPassword) {
      attemptLogin(savedPassword, true);
    }

    // Bind events
    $("#login-form").addEventListener("submit", onLoginSubmit);
    $("#search-input").addEventListener("input", debounce(onSearch, 150));
    $(".modal-overlay").addEventListener("click", onModalOverlayClick);
    $(".modal-close").addEventListener("click", closeModal);

    // Filter buttons
    $$(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentFilter = btn.dataset.filter;
        $$(".filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyFilters();
      });
    });

    // View toggle
    $$(".view-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentView = btn.dataset.view;
        $$(".view-toggle button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        toggleView();
      });
    });

    // Logout
    $(".btn-logout").addEventListener("click", logout);

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const input = $("#search-input");
        if (document.activeElement !== input) {
          e.preventDefault();
          input.focus();
        }
      }
    });
  }

  // ---- Login Flow ----

  async function onLoginSubmit(e) {
    e.preventDefault();
    const password = $("#password-input").value;
    if (!password) return;

    const btn = $("#login-btn");
    btn.disabled = true;
    btn.textContent = "Decrypting...";
    $(".login-error").style.display = "none";

    // Small delay so the UI updates
    await sleep(50);
    await attemptLogin(password, false);

    btn.disabled = false;
    btn.textContent = "Unlock";
  }

  async function attemptLogin(password, isSession) {
    try {
      // Fetch encrypted library
      const resp = await fetch("../data/library.enc");
      if (!resp.ok) {
        if (!isSession) showLoginError("Library data not found. Has the GitHub Action run yet?");
        return;
      }
      const encryptedData = await resp.text();

      // Decrypt
      const jsonStr = await Crypto.decrypt(encryptedData.trim(), password);
      library = JSON.parse(jsonStr);

      // Save session
      Crypto.saveSession(password);

      // Build search index
      searchIndex = library.items.map((item) => Parser.searchText(item));
      filteredItems = [...library.items];

      // Show app
      $(".login-container").style.display = "none";
      $(".app-container").classList.add("active");

      renderLibrary();
      updateStats();
      showLastUpdated();

    } catch (err) {
      if (isSession) {
        // Session expired or data changed, clear session
        Crypto.clearSession();
        return;
      }
      console.error("Decryption failed:", err);
      showLoginError("Wrong password. Please try again.");
    }
  }

  function showLoginError(msg) {
    const el = $(".login-error");
    el.textContent = msg;
    el.style.display = "block";
  }

  function logout() {
    Crypto.clearSession();
    library = null;
    searchIndex = [];
    filteredItems = [];
    $(".app-container").classList.remove("active");
    $(".login-container").style.display = "flex";
    $("#password-input").value = "";
    $(".login-error").style.display = "none";
  }

  // ---- Search & Filter ----

  function onSearch() {
    applyFilters();
  }

  function applyFilters() {
    if (!library) return;

    const query = ($("#search-input").value || "").toLowerCase().trim();
    const items = library.items;

    filteredItems = items.filter((item, i) => {
      // Type filter
      if (currentFilter !== "all" && item.type !== currentFilter) return false;

      // Search
      if (query) {
        return searchIndex[i].includes(query);
      }
      return true;
    });

    renderLibrary();
    updateStats();
  }

  // ---- Rendering ----

  function renderLibrary() {
    renderGrid();
    renderList();
  }

  function renderGrid() {
    const container = $(".library-grid");
    if (!filteredItems.length) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="icon">&#128269;</div>
          <p>No results found</p>
        </div>`;
      return;
    }

    container.innerHTML = filteredItems.map((item, i) => {
      const title = Parser.displayTitle(item);
      const poster = item.tmdb?.poster;
      const rating = item.tmdb?.rating;
      const genres = item.tmdb?.genres?.slice(0, 2).join(", ") || "";

      return `
        <div class="card" data-index="${i}" onclick="App.openDetail(${i})">
          <div class="card-poster">
            ${poster
              ? `<img src="${escapeAttr(poster)}" alt="${escapeAttr(title)}" loading="lazy">`
              : `<span class="no-poster">&#127916;</span>`
            }
            <span class="card-type-badge ${item.type}">${item.type === "tv" ? "TV" : "Film"}</span>
            ${rating ? `<span class="card-rating">&#9733; ${rating.toFixed(1)}</span>` : ""}
          </div>
          <div class="card-info">
            <div class="card-title">${escapeHtml(title)}</div>
            <div class="card-meta">${Parser.formatSize(item.size)}</div>
            ${genres ? `<div class="card-genres">${escapeHtml(genres)}</div>` : ""}
          </div>
        </div>`;
    }).join("");
  }

  function renderList() {
    const container = $(".library-list");
    if (!filteredItems.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">&#128269;</div>
          <p>No results found</p>
        </div>`;
      return;
    }

    container.innerHTML = filteredItems.map((item, i) => {
      const title = Parser.displayTitle(item);
      const poster = item.tmdb?.poster;

      return `
        <div class="list-item" onclick="App.openDetail(${i})">
          <div class="list-poster">
            ${poster
              ? `<img src="${escapeAttr(poster)}" alt="" loading="lazy">`
              : `<span class="no-poster">&#127916;</span>`
            }
          </div>
          <div class="list-info">
            <div class="list-title">${escapeHtml(title)}</div>
            <div class="list-meta">${escapeHtml(item.filename)}</div>
          </div>
          <span class="list-type-badge ${item.type}">${item.type === "tv" ? "TV" : "Film"}</span>
          <span class="list-size">${Parser.formatSize(item.size)}</span>
        </div>`;
    }).join("");
  }

  function toggleView() {
    const grid = $(".library-grid");
    const list = $(".library-list");
    if (currentView === "grid") {
      grid.classList.add("active");
      list.classList.remove("active");
    } else {
      grid.classList.remove("active");
      list.classList.add("active");
    }
  }

  function updateStats() {
    const total = library ? library.items.length : 0;
    const shown = filteredItems.length;
    $(".stats").textContent = shown === total
      ? `${total} items`
      : `${shown} of ${total} items`;
  }

  function showLastUpdated() {
    if (library?.updated) {
      $(".last-updated").textContent = `Last updated: ${Parser.formatDate(library.updated)}`;
    }
  }

  // ---- Detail Modal ----

  function openDetail(index) {
    const item = filteredItems[index];
    if (!item) return;

    const modal = $(".modal");
    const title = Parser.displayTitle(item);

    // Backdrop
    const backdropHtml = item.tmdb?.backdrop
      ? `<img class="modal-backdrop" src="${escapeAttr(item.tmdb.backdrop)}" alt="">`
      : `<div class="modal-backdrop-placeholder"></div>`;

    // Poster
    const posterHtml = item.tmdb?.poster
      ? `<img src="${escapeAttr(item.tmdb.poster)}" alt="">`
      : "";

    // Meta line
    const metaParts = [];
    if (item.tmdb?.year || item.year) metaParts.push(item.tmdb?.year || item.year);
    if (item.tmdb?.rating) metaParts.push(`&#9733; ${item.tmdb.rating.toFixed(1)}`);
    metaParts.push(Parser.formatSize(item.size));
    metaParts.push(Parser.formatDate(item.added));

    // Genres
    const genresHtml = (item.tmdb?.genres || [])
      .map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`)
      .join("");

    // Overview
    const overview = item.tmdb?.overview || "";

    // Files / episodes
    let filesHtml = "";
    if (item.is_pack && item.episodes?.length) {
      filesHtml = `
        <div class="modal-section-title">Episodes / Files</div>
        <div class="modal-file-list">
          ${item.episodes.map((ep) => {
            const label = Parser.episodeLabel(ep);
            const url = ep.stream_url || "";
            return fileItemHtml(label, ep.size, url);
          }).join("")}
        </div>`;
    } else if (item.links?.length) {
      filesHtml = `
        <div class="modal-section-title">Files</div>
        <div class="modal-file-list">
          ${item.links.map((link) => {
            const label = link.filename || "Download";
            return fileItemHtml(label, link.filesize, link.download);
          }).join("")}
        </div>`;
    }

    modal.querySelector(".modal-header").innerHTML = `
      ${backdropHtml}
      <button class="modal-close" onclick="App.closeModal()">&#10005;</button>
    `;

    modal.querySelector(".modal-body").innerHTML = `
      <div class="modal-title-row">
        ${posterHtml ? `<div class="modal-poster">${posterHtml}</div>` : ""}
        <div class="modal-title-info">
          <h2>${escapeHtml(title)}</h2>
          <div class="modal-title-meta">${metaParts.join(" &bull; ")}</div>
          ${genresHtml ? `<div class="modal-genres">${genresHtml}</div>` : ""}
        </div>
      </div>
      ${overview ? `<p class="modal-overview">${escapeHtml(overview)}</p>` : ""}
      <div class="modal-section-title">Original Filename</div>
      <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:20px;word-break:break-all;">${escapeHtml(item.filename)}</p>
      ${filesHtml}
    `;

    $(".modal-overlay").classList.add("active");
    document.body.style.overflow = "hidden";
  }

  function fileItemHtml(label, size, url) {
    const hasUrl = !!url;
    return `
      <div class="file-item">
        <span class="file-label" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
        <span class="file-size">${Parser.formatSize(size)}</span>
        <div class="file-actions">
          ${hasUrl ? `
            <button class="btn-copy" onclick="App.copyUrl(this, '${escapeAttr(url)}'); event.stopPropagation();">Copy URL</button>
            <a class="btn-vlc" href="${escapeAttr(Parser.vlcUrl(url))}" onclick="event.stopPropagation();">VLC</a>
          ` : `<span style="color:var(--text-muted);font-size:0.8rem;">No link</span>`}
        </div>
      </div>`;
  }

  function closeModal() {
    $(".modal-overlay").classList.remove("active");
    document.body.style.overflow = "";
  }

  function onModalOverlayClick(e) {
    if (e.target === $(".modal-overlay")) {
      closeModal();
    }
  }

  // ---- Actions ----

  async function copyUrl(btn, url) {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      showToast("URL copied to clipboard");
      setTimeout(() => {
        btn.textContent = "Copy URL";
        btn.classList.remove("copied");
      }, 2000);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      showToast("URL copied to clipboard");
      setTimeout(() => {
        btn.textContent = "Copy URL";
        btn.classList.remove("copied");
      }, 2000);
    }
  }

  function showToast(msg) {
    const toast = $(".toast");
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2500);
  }

  // ---- Utilities ----

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function escapeHtml(str) {
    if (!str) return "";
    const s = String(str);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Public API
  return { init, openDetail, closeModal, copyUrl };
})();

// Boot
document.addEventListener("DOMContentLoaded", App.init);
