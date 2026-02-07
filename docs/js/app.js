/**
 * Main application logic for the Torrent Library.
 * Handles login, data loading, search, filtering, and UI rendering.
 * Unrestricts RD links on-demand when user clicks play/copy.
 */
const App = (() => {
  // State
  let library = null;       // Decrypted library data
  let rdKey = null;          // RD API key from encrypted blob
  let searchIndex = [];      // Precomputed search text for each item
  let filteredItems = [];    // Current filtered/search results
  let currentView = "grid";  // "grid" or "list"
  let currentFilter = "all"; // "all", "movie", "tv"

  // Cache for unrestricted URLs (raw_link -> stream_url)
  const unrestrictCache = {};

  // DOM refs
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Initialization ----

  function init() {
    const savedPassword = Crypto.getSession();
    if (savedPassword) {
      attemptLogin(savedPassword, true);
    }

    $("#login-form").addEventListener("submit", onLoginSubmit);
    $("#search-input").addEventListener("input", debounce(onSearch, 150));
    $(".modal-overlay").addEventListener("click", onModalOverlayClick);
    $(".modal-close").addEventListener("click", closeModal);

    $$(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentFilter = btn.dataset.filter;
        $$(".filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyFilters();
      });
    });

    $$(".view-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentView = btn.dataset.view;
        $$(".view-toggle button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        toggleView();
      });
    });

    $(".btn-logout").addEventListener("click", logout);

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

    await sleep(50);
    await attemptLogin(password, false);

    btn.disabled = false;
    btn.textContent = "Unlock";
  }

  async function attemptLogin(password, isSession) {
    try {
      const resp = await fetch("data/library.enc");
      if (!resp.ok) {
        if (!isSession) showLoginError("Library data not found. Has the GitHub Action run yet?");
        return;
      }
      const encryptedData = await resp.text();

      const jsonStr = await Crypto.decrypt(encryptedData.trim(), password);
      library = JSON.parse(jsonStr);
      rdKey = library.rd_key || null;

      Crypto.saveSession(password);

      searchIndex = library.items.map((item) => Parser.searchText(item));
      filteredItems = [...library.items];

      $(".login-container").style.display = "none";
      $(".app-container").classList.add("active");

      renderLibrary();
      updateStats();
      showLastUpdated();

    } catch (err) {
      if (isSession) {
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
    rdKey = null;
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
      if (currentFilter !== "all" && item.type !== currentFilter) return false;
      if (query) return searchIndex[i].includes(query);
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

    const backdropHtml = item.tmdb?.backdrop
      ? `<img class="modal-backdrop" src="${escapeAttr(item.tmdb.backdrop)}" alt="">`
      : `<div class="modal-backdrop-placeholder"></div>`;

    const posterHtml = item.tmdb?.poster
      ? `<img src="${escapeAttr(item.tmdb.poster)}" alt="">`
      : "";

    const metaParts = [];
    if (item.tmdb?.year || item.year) metaParts.push(item.tmdb?.year || item.year);
    if (item.tmdb?.rating) metaParts.push(`&#9733; ${item.tmdb.rating.toFixed(1)}`);
    metaParts.push(Parser.formatSize(item.size));
    metaParts.push(Parser.formatDate(item.added));

    const genresHtml = (item.tmdb?.genres || [])
      .map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`)
      .join("");

    const overview = item.tmdb?.overview || "";

    // Build file/link list
    // raw_links are RD hoster URLs that need unrestricting on-demand
    const rawLinks = item.raw_links || [];
    let filesHtml = "";

    if (rawLinks.length > 0) {
      const label = item.is_pack ? "Collection" : "Files";
      const count = rawLinks.length > 1 ? ` (${rawLinks.length})` : "";
      filesHtml = `
        <div class="modal-section-title">${label}${count}</div>
        <div class="modal-file-list" id="modal-files">
          ${rawLinks.map((link, idx) => {
            // Use a safe data attribute to pass the link
            return `
              <div class="file-item" data-raw-link="${escapeAttr(link)}" data-idx="${idx}">
                <span class="file-label">${item.is_pack ? `File ${idx + 1}` : escapeHtml(item.filename)}</span>
                <div class="file-actions">
                  <button class="btn-copy" onclick="App.unrestrictAndCopy(this); event.stopPropagation();">Copy URL</button>
                  <button class="btn-vlc" onclick="App.unrestrictAndPlay(this); event.stopPropagation();">VLC</button>
                </div>
              </div>`;
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

  function closeModal() {
    $(".modal-overlay").classList.remove("active");
    document.body.style.overflow = "";
  }

  function onModalOverlayClick(e) {
    if (e.target === $(".modal-overlay")) {
      closeModal();
    }
  }

  // ---- On-demand unrestricting ----

  async function unrestrictLink(rawLink) {
    // Return cached result if available
    if (unrestrictCache[rawLink]) return unrestrictCache[rawLink];

    if (!rdKey) throw new Error("No RD API key available");

    const resp = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${rdKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `link=${encodeURIComponent(rawLink)}`,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`RD API ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    const streamUrl = data.download;
    if (!streamUrl) throw new Error("No download URL in response");

    unrestrictCache[rawLink] = streamUrl;
    return streamUrl;
  }

  function getRawLinkFromButton(btn) {
    const fileItem = btn.closest(".file-item");
    return fileItem?.dataset?.rawLink;
  }

  async function unrestrictAndCopy(btn) {
    const rawLink = getRawLinkFromButton(btn);
    if (!rawLink) return;

    const origText = btn.textContent;
    btn.textContent = "Loading...";
    btn.disabled = true;

    try {
      const streamUrl = await unrestrictLink(rawLink);
      await clipboardWrite(streamUrl);
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      showToast("Streaming URL copied to clipboard");
      setTimeout(() => {
        btn.textContent = origText;
        btn.classList.remove("copied");
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      console.error("Unrestrict failed:", err);
      btn.textContent = "Error";
      showToast(`Failed: ${err.message}`);
      setTimeout(() => {
        btn.textContent = origText;
        btn.disabled = false;
      }, 3000);
    }
  }

  async function unrestrictAndPlay(btn) {
    const rawLink = getRawLinkFromButton(btn);
    if (!rawLink) return;

    const origText = btn.textContent;
    btn.textContent = "Loading...";
    btn.disabled = true;

    try {
      const streamUrl = await unrestrictLink(rawLink);
      window.location.href = Parser.vlcUrl(streamUrl);
      btn.textContent = "Opened!";
      setTimeout(() => {
        btn.textContent = origText;
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      console.error("Unrestrict failed:", err);
      btn.textContent = "Error";
      showToast(`Failed: ${err.message}`);
      setTimeout(() => {
        btn.textContent = origText;
        btn.disabled = false;
      }, 3000);
    }
  }

  // ---- Utilities ----

  async function clipboardWrite(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  function showToast(msg) {
    const toast = $(".toast");
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2500);
  }

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
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Public API
  return { init, openDetail, closeModal, unrestrictAndCopy, unrestrictAndPlay };
})();

// Boot
document.addEventListener("DOMContentLoaded", App.init);
