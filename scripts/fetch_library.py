#!/usr/bin/env python3
"""
Fetches torrent library from Real-Debrid, optionally enriches with TMDB metadata,
encrypts everything, and writes to data/library.enc.

Supports incremental updates via an encrypted cache file.

Environment variables:
    RD_API_KEY           - Real-Debrid API token (required)
    ENCRYPTION_PASSWORD  - Password for AES-256-GCM encryption (required)
    TMDB_API_KEY         - TMDB API key for metadata (optional)
"""

import hashlib
import json
import os
import re
import secrets
import sys
import time
from urllib.parse import quote

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
RD_API_KEY = os.environ.get("RD_API_KEY", "")
ENCRYPTION_PASSWORD = os.environ.get("ENCRYPTION_PASSWORD", "")
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "")

RD_BASE = "https://api.real-debrid.com/rest/1.0"
TMDB_BASE = "https://api.themoviedb.org/3"

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
LIBRARY_PATH = os.path.join(DATA_DIR, "library.enc")
CACHE_PATH = os.path.join(DATA_DIR, "cache.enc")

RD_RATE_DELAY = 0.3  # seconds between RD API calls
TMDB_RATE_DELAY = 0.1  # seconds between TMDB API calls
MAX_RETRIES = 4

# ---------------------------------------------------------------------------
# Encryption helpers (AES-256-GCM via PyCryptodome-compatible pure approach)
# We use hashlib + os.urandom and the cryptography library for AES-GCM.
# Falls back to a simpler approach if cryptography isn't available.
# ---------------------------------------------------------------------------
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

# Fallback: use AES-GCM via the built-in hashlib + a pure-python or
# subprocess approach. But for GitHub Actions, we'll install cryptography.
if not HAS_CRYPTO:
    print("WARNING: 'cryptography' package not found. Install with: pip install cryptography")
    print("Attempting fallback...")


def derive_key(password: str, salt: bytes) -> bytes:
    """Derive a 256-bit key from password using PBKDF2-SHA256."""
    if HAS_CRYPTO:
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=600_000,
        )
        return kdf.derive(password.encode("utf-8"))
    else:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 600_000)


def encrypt_data(plaintext: str, password: str) -> bytes:
    """Encrypt plaintext with AES-256-GCM. Returns: salt(16) + nonce(12) + ciphertext+tag."""
    salt = secrets.token_bytes(16)
    key = derive_key(password, salt)
    nonce = secrets.token_bytes(12)

    if HAS_CRYPTO:
        aesgcm = AESGCM(key)
        ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    else:
        # Fallback using openssl subprocess
        import subprocess
        import tempfile
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(plaintext.encode("utf-8"))
            tmp = f.name
        try:
            result = subprocess.run(
                ["openssl", "enc", "-aes-256-gcm", "-nosalt",
                 "-K", key.hex(), "-iv", nonce.hex()],
                input=plaintext.encode("utf-8"),
                capture_output=True
            )
            ct = result.stdout
        finally:
            os.unlink(tmp)

    return salt + nonce + ct


def decrypt_data(data: bytes, password: str) -> str:
    """Decrypt AES-256-GCM encrypted data."""
    salt = data[:16]
    nonce = data[16:28]
    ct = data[28:]
    key = derive_key(password, salt)

    if HAS_CRYPTO:
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(nonce, ct, None)
        return plaintext.decode("utf-8")
    else:
        raise RuntimeError("Decryption requires the 'cryptography' package")


# ---------------------------------------------------------------------------
# Real-Debrid API
# ---------------------------------------------------------------------------
def rd_request(endpoint: str, params: dict | None = None, retries: int = MAX_RETRIES) -> dict | list:
    """Make a rate-limited, retry-aware request to the RD API."""
    url = f"{RD_BASE}{endpoint}"
    headers = {"Authorization": f"Bearer {RD_API_KEY}"}

    for attempt in range(retries):
        try:
            time.sleep(RD_RATE_DELAY)
            resp = requests.get(url, headers=headers, params=params, timeout=30)

            if resp.status_code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue

            resp.raise_for_status()
            return resp.json()

        except requests.RequestException as e:
            if attempt < retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"  Request error: {e}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  Failed after {retries} attempts: {e}")
                raise

    return {}


def fetch_all_torrents() -> list[dict]:
    """Fetch the full list of torrents (paginated)."""
    all_torrents = []
    page = 1
    while True:
        print(f"  Fetching torrents page {page}...")
        batch = rd_request("/torrents", params={"page": page, "limit": 100})
        if not batch:
            break
        all_torrents.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return all_torrents


def fetch_torrent_info(torrent_id: str) -> dict:
    """Fetch detailed info for a single torrent including file list."""
    return rd_request(f"/torrents/info/{torrent_id}")


def fetch_streaming_links(link: str) -> dict | None:
    """Unrestrict a link to get a streaming URL."""
    url = f"{RD_BASE}/unrestrict/link"
    headers = {"Authorization": f"Bearer {RD_API_KEY}"}

    for attempt in range(MAX_RETRIES):
        try:
            time.sleep(RD_RATE_DELAY)
            resp = requests.post(url, headers=headers, data={"link": link}, timeout=30)

            if resp.status_code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited on unrestrict, waiting {wait}s...")
                time.sleep(wait)
                continue

            resp.raise_for_status()
            return resp.json()

        except requests.RequestException as e:
            if attempt < MAX_RETRIES - 1:
                wait = 2 ** (attempt + 1)
                print(f"  Unrestrict error: {e}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  Unrestrict failed: {e}")
                return None

    return None


# ---------------------------------------------------------------------------
# Torrent name parsing
# ---------------------------------------------------------------------------
QUALITY_TAGS = re.compile(
    r'[\.\s\-\[]*(720p|1080p|2160p|4[Kk]|HDRip|BRRip|BluRay|BDRip|WEB-?DL|'
    r'WEB-?Rip|HDTV|DVDRip|DVDScr|CAM|TS|REMUX|x264|x265|h\.?264|h\.?265|'
    r'HEVC|AAC|AC3|DTS|FLAC|ATMOS|10bit|HDR|DV|Dual[\.\s]?Audio|Multi|'
    r'REPACK|PROPER|EXTENDED|UNRATED|Directors[\.\s]?Cut)[\.\s\-\]]*',
    re.IGNORECASE
)

RELEASE_GROUP = re.compile(r'[\-\s]*[\[\(]?[A-Za-z0-9]+[\]\)]?$')

SEASON_EPISODE = re.compile(
    r'[Ss](\d{1,2})[Ee](\d{1,3})'  # S01E01
    r'|(\d{1,2})x(\d{1,3})'  # 1x01
    r'|[Ss](\d{1,2})'  # S01 (full season)
    r'|[Ss]eason[\.\s]?(\d{1,2})'  # Season 1
)

EPISODE_PATTERN = re.compile(
    r'[Ss](\d{1,2})[Ee](\d{1,3})'
    r'|(\d{1,2})x(\d{1,3})'
    r'|[Ee](?:pisode)?[\.\s]?(\d{1,3})'
)

YEAR_PATTERN = re.compile(r'[\.\s\(]*((?:19|20)\d{2})[\.\s\)]*')

VIDEO_EXTENSIONS = {'.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg'}


def parse_torrent_name(name: str) -> dict:
    """Parse a torrent name into structured metadata."""
    result = {"original": name}

    # Extract year
    year_match = YEAR_PATTERN.search(name)
    if year_match:
        result["year"] = int(year_match.group(1))

    # Detect season/episode info
    se_match = SEASON_EPISODE.search(name)
    if se_match:
        result["type"] = "tv"
        if se_match.group(1) and se_match.group(2):
            result["season"] = int(se_match.group(1))
            result["episode"] = int(se_match.group(2))
        elif se_match.group(3) and se_match.group(4):
            result["season"] = int(se_match.group(3))
            result["episode"] = int(se_match.group(4))
        elif se_match.group(5):
            result["season"] = int(se_match.group(5))
        elif se_match.group(6):
            result["season"] = int(se_match.group(6))
    else:
        result["type"] = "movie"

    # Clean name: everything before the quality tags / year / season info
    clean = name
    # Remove file extension if present
    for ext in VIDEO_EXTENSIONS:
        if clean.lower().endswith(ext):
            clean = clean[:len(clean) - len(ext)]
            break

    # Cut at first quality tag, year, or season marker
    for pattern in [QUALITY_TAGS, SEASON_EPISODE, YEAR_PATTERN]:
        m = pattern.search(clean)
        if m and m.start() > 0:
            clean = clean[:m.start()]
            break

    # Replace dots and underscores with spaces, strip
    clean = re.sub(r'[\.\-_]', ' ', clean).strip()
    # Remove trailing dash/spaces
    clean = re.sub(r'[\s\-]+$', '', clean)
    result["title"] = clean

    return result


def parse_file_episodes(files: list[dict]) -> list[dict]:
    """Parse episode info from individual files in a torrent."""
    episodes = []
    for f in files:
        path = f.get("path", "")
        name = os.path.basename(path)
        ext = os.path.splitext(name)[1].lower()

        if ext not in VIDEO_EXTENSIONS:
            continue

        ep_info = {"filename": name, "path": path, "size": f.get("bytes", 0)}

        ep_match = EPISODE_PATTERN.search(name)
        if ep_match:
            if ep_match.group(1) and ep_match.group(2):
                ep_info["season"] = int(ep_match.group(1))
                ep_info["episode"] = int(ep_match.group(2))
            elif ep_match.group(3) and ep_match.group(4):
                ep_info["season"] = int(ep_match.group(3))
                ep_info["episode"] = int(ep_match.group(4))
            elif ep_match.group(5):
                ep_info["episode"] = int(ep_match.group(5))

        # Generate friendly episode name
        parsed = parse_torrent_name(name)
        ep_info["friendly_name"] = parsed["title"]

        episodes.append(ep_info)

    # Sort by season then episode
    episodes.sort(key=lambda e: (e.get("season", 0), e.get("episode", 0)))
    return episodes


# ---------------------------------------------------------------------------
# TMDB metadata (optional)
# ---------------------------------------------------------------------------
def tmdb_search(title: str, media_type: str = "movie", year: int | None = None) -> dict | None:
    """Search TMDB for a title and return metadata."""
    if not TMDB_API_KEY:
        return None

    endpoint = f"{TMDB_BASE}/search/{'tv' if media_type == 'tv' else 'movie'}"
    params = {"api_key": TMDB_API_KEY, "query": title, "include_adult": "false"}
    if year and media_type == "movie":
        params["year"] = year
    elif year and media_type == "tv":
        params["first_air_date_year"] = year

    for attempt in range(3):
        try:
            time.sleep(TMDB_RATE_DELAY)
            resp = requests.get(endpoint, params=params, timeout=15)

            if resp.status_code == 429:
                time.sleep(2 ** (attempt + 1))
                continue

            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])
            if not results:
                return None

            item = results[0]
            return {
                "tmdb_id": item.get("id"),
                "title": item.get("title") or item.get("name"),
                "overview": item.get("overview", ""),
                "poster": f"https://image.tmdb.org/t/p/w300{item['poster_path']}" if item.get("poster_path") else None,
                "backdrop": f"https://image.tmdb.org/t/p/w780{item['backdrop_path']}" if item.get("backdrop_path") else None,
                "rating": item.get("vote_average"),
                "year": (item.get("release_date") or item.get("first_air_date") or "")[:4],
                "genre_ids": item.get("genre_ids", []),
            }

        except requests.RequestException:
            if attempt < 2:
                time.sleep(2)
            continue

    return None


# TMDB genre ID mapping
TMDB_GENRES = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
    99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
    27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
    878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
    10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality",
    10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
}


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------
def load_cache() -> dict:
    """Load existing cache from encrypted file."""
    if not os.path.exists(CACHE_PATH):
        return {"torrents": {}, "tmdb_cache": {}}

    try:
        import base64
        with open(CACHE_PATH, "rb") as f:
            encrypted = f.read()
        plaintext = decrypt_data(encrypted, ENCRYPTION_PASSWORD)
        return json.loads(plaintext)
    except Exception as e:
        print(f"  Could not load cache: {e}")
        return {"torrents": {}, "tmdb_cache": {}}


def save_cache(cache: dict):
    """Save cache to encrypted file."""
    plaintext = json.dumps(cache, separators=(',', ':'))
    encrypted = encrypt_data(plaintext, ENCRYPTION_PASSWORD)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CACHE_PATH, "wb") as f:
        f.write(encrypted)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def build_library():
    """Main function: fetch, enrich, encrypt, save."""
    if not RD_API_KEY:
        print("ERROR: RD_API_KEY environment variable is required")
        sys.exit(1)
    if not ENCRYPTION_PASSWORD:
        print("ERROR: ENCRYPTION_PASSWORD environment variable is required")
        sys.exit(1)

    print("Loading cache...")
    cache = load_cache()
    cached_torrents = cache.get("torrents", {})
    tmdb_cache = cache.get("tmdb_cache", {})

    print("Fetching torrent list from Real-Debrid...")
    rd_torrents = fetch_all_torrents()
    print(f"  Found {len(rd_torrents)} torrents")

    # Build set of current torrent IDs
    current_ids = {t["id"] for t in rd_torrents}

    # Remove torrents that no longer exist in RD
    removed = set(cached_torrents.keys()) - current_ids
    for rid in removed:
        del cached_torrents[rid]
    if removed:
        print(f"  Removed {len(removed)} deleted torrents from cache")

    library = []
    new_count = 0
    refresh_count = 0

    for i, torrent in enumerate(rd_torrents):
        tid = torrent["id"]
        status = torrent.get("status", "")

        # Only process downloaded torrents
        if status != "downloaded":
            continue

        # Check if we need to fetch detailed info
        cached = cached_torrents.get(tid)
        needs_refresh = (
            cached is None
            or cached.get("_fetched_at", 0) < time.time() - 82800  # 23 hours
        )

        if needs_refresh:
            if cached is None:
                new_count += 1
            else:
                refresh_count += 1

            print(f"  [{i+1}/{len(rd_torrents)}] Fetching info for: {torrent.get('filename', tid)[:60]}...")

            try:
                info = fetch_torrent_info(tid)
            except Exception as e:
                print(f"    Error fetching info: {e}")
                if cached:
                    # Use stale cache
                    library.append(cached.get("_library_entry", {}))
                continue

            # Parse name
            parsed = parse_torrent_name(torrent.get("filename", ""))

            # Get files and episodes
            files = info.get("files", [])
            # Filter to selected files only
            selected_files = [f for f in files if f.get("selected") == 1]
            episodes = parse_file_episodes(selected_files)

            # Determine if multi-episode
            is_pack = len(episodes) > 1

            # Get streaming links
            links_list = info.get("links", [])
            streaming_links = []
            for link in links_list:
                print(f"    Unrestricting link...")
                result = fetch_streaming_links(link)
                if result and result.get("download"):
                    streaming_links.append({
                        "filename": result.get("filename", ""),
                        "filesize": result.get("filesize", 0),
                        "download": result["download"],
                        "mimetype": result.get("mimeType", ""),
                    })

            # Match streaming links to episodes where possible
            if is_pack and streaming_links:
                for ep in episodes:
                    ep_name = ep.get("filename", "").lower()
                    for sl in streaming_links:
                        if sl["filename"].lower() in ep_name or ep_name in sl["filename"].lower():
                            ep["stream_url"] = sl["download"]
                            break

            # TMDB metadata
            tmdb_key = f"{parsed['title'].lower()}|{parsed.get('year', '')}|{parsed['type']}"
            tmdb_data = tmdb_cache.get(tmdb_key)
            if tmdb_data is None and TMDB_API_KEY:
                print(f"    Searching TMDB for: {parsed['title']}...")
                tmdb_data = tmdb_search(parsed["title"], parsed["type"], parsed.get("year"))
                tmdb_cache[tmdb_key] = tmdb_data  # Cache even None results

            # Build library entry
            entry = {
                "id": tid,
                "filename": torrent.get("filename", ""),
                "title": parsed["title"],
                "type": parsed["type"],
                "year": parsed.get("year"),
                "season": parsed.get("season"),
                "episode": parsed.get("episode"),
                "size": torrent.get("bytes", 0),
                "added": torrent.get("added", ""),
                "links": streaming_links,
                "is_pack": is_pack,
                "episodes": episodes if is_pack else [],
            }

            # Add TMDB data if available
            if tmdb_data:
                entry["tmdb"] = {
                    "title": tmdb_data.get("title"),
                    "overview": tmdb_data.get("overview"),
                    "poster": tmdb_data.get("poster"),
                    "backdrop": tmdb_data.get("backdrop"),
                    "rating": tmdb_data.get("rating"),
                    "year": tmdb_data.get("year"),
                    "genres": [TMDB_GENRES.get(gid, "") for gid in tmdb_data.get("genre_ids", []) if gid in TMDB_GENRES],
                }

            library.append(entry)

            # Update cache
            cached_torrents[tid] = {
                "_fetched_at": time.time(),
                "_library_entry": entry,
            }
        else:
            # Use cached entry
            library.append(cached["_library_entry"])

    print(f"\nLibrary built: {len(library)} torrents ({new_count} new, {refresh_count} refreshed)")

    # Sort: most recently added first
    library.sort(key=lambda x: x.get("added", ""), reverse=True)

    # Save cache
    cache["torrents"] = cached_torrents
    cache["tmdb_cache"] = tmdb_cache
    save_cache(cache)
    print("Cache saved")

    # Encrypt and save library
    library_json = json.dumps({"version": 1, "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "items": library}, separators=(',', ':'))
    encrypted = encrypt_data(library_json, ENCRYPTION_PASSWORD)

    os.makedirs(DATA_DIR, exist_ok=True)
    import base64
    with open(LIBRARY_PATH, "w") as f:
        f.write(base64.b64encode(encrypted).decode("ascii"))

    print(f"Library encrypted and saved to {LIBRARY_PATH}")
    print(f"  Size: {len(encrypted)} bytes encrypted, {len(library_json)} bytes plaintext")


if __name__ == "__main__":
    build_library()
