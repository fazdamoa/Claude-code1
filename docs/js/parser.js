/**
 * Client-side torrent name parser and search utilities.
 * Used for additional client-side parsing and search index building.
 */
const Parser = (() => {
  /**
   * Format bytes into a human-readable string.
   */
  function formatSize(bytes) {
    if (!bytes) return "Unknown";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
  }

  /**
   * Format an ISO date string to a friendly format.
   */
  function formatDate(isoDate) {
    if (!isoDate) return "";
    try {
      const d = new Date(isoDate);
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return isoDate;
    }
  }

  /**
   * Build a display title from a library item.
   */
  function displayTitle(item) {
    // Prefer TMDB title if available
    const title = item.tmdb?.title || item.title || item.filename;
    const parts = [title];

    if (item.year || item.tmdb?.year) {
      parts.push(`(${item.tmdb?.year || item.year})`);
    }

    if (item.type === "tv" && item.season !== undefined) {
      if (item.episode !== undefined) {
        parts.push(`S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`);
      } else {
        parts.push(`Season ${item.season}`);
      }
    }

    return parts.join(" ");
  }

  /**
   * Build a searchable string from an item (lowercased).
   */
  function searchText(item) {
    const parts = [
      item.title,
      item.filename,
      item.tmdb?.title,
      item.tmdb?.overview,
      item.tmdb?.genres?.join(" "),
      item.year,
      item.tmdb?.year,
    ];

    // Include episode filenames for packs
    if (item.episodes) {
      for (const ep of item.episodes) {
        parts.push(ep.filename);
        parts.push(ep.friendly_name);
      }
    }

    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  /**
   * Format episode label.
   */
  function episodeLabel(ep) {
    const parts = [];
    if (ep.season !== undefined && ep.episode !== undefined) {
      parts.push(`S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`);
    } else if (ep.episode !== undefined) {
      parts.push(`Episode ${ep.episode}`);
    }
    if (ep.friendly_name) {
      parts.push(ep.friendly_name);
    } else {
      parts.push(ep.filename);
    }
    return parts.join(" - ");
  }

  /**
   * Generate a VLC protocol URL.
   */
  function vlcUrl(streamUrl) {
    return `vlc://${streamUrl}`;
  }

  return { formatSize, formatDate, displayTitle, searchText, episodeLabel, vlcUrl };
})();
