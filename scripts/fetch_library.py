#!/usr/bin/env python3
"""
Fetches torrent library from Real-Debrid, optionally enriches with TMDB metadata,
encrypts everything, and writes to docs/data/library.enc.

This script ONLY fetches the paginated torrent list -- no per-torrent info calls,
no unrestricting. Unrestricting happens on-demand in the browser.

Environment variables:
    RD_API_KEY           - Real-Debrid API token (required)
    ENCRYPTION_PASSWORD  - Password for AES-256-GCM encryption (required)
    TMDB_API_KEY         - TMDB API key for metadata (optional)
"""

import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
RD_API_KEY = os.environ.get("RD_API_KEY", "")
ENCRYPTION_PASSWORD = os.environ.get("ENCRYPTION_PASSWORD", "")
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "")

RD_BASE = "https://api.real-debrid.com/rest/1.0"
TMDB_BASE = "https://api.themoviedb.org/3"

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "docs", "data")  # Inside docs/ so GitHub Pages serves it
CACHE_DIR = os.path.join(ROOT_DIR, "data")  # Cache stays outside docs/ (not served)
LIBRARY_PATH = os.path.join(DATA_DIR, "library.enc")
CACHE_PATH = os.path.join(CACHE_DIR, "cache.enc")

RD_RATE_DELAY = 0.5  # seconds between RD API calls
TMDB_RATE_DELAY = 0.1
MAX_RETRIES = 4

# ---------------------------------------------------------------------------
# Encryption (AES-256-GCM)
# ---------------------------------------------------------------------------
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False
    print("WARNING: 'cryptography' package not found. Install with: pip install cryptography")


def derive_key(password: str, salt: bytes) -> bytes:
    if HAS_CRYPTO:
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=600_000)
        return kdf.derive(password.encode("utf-8"))
    else:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 600_000)


def encrypt_data(plaintext: str, password: str) -> bytes:
    salt = secrets.token_bytes(16)
    key = derive_key(password, salt)
    nonce = secrets.token_bytes(12)
    if HAS_CRYPTO:
        ct = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None)
    else:
        raise RuntimeError("Encryption requires the 'cryptography' package")
    return salt + nonce + ct


def decrypt_data(data: bytes, password: str) -> str:
    salt, nonce, ct = data[:16], data[16:28], data[28:]
    key = derive_key(password, salt)
    if HAS_CRYPTO:
        return AESGCM(key).decrypt(nonce, ct, None).decode("utf-8")
    raise RuntimeError("Decryption requires the 'cryptography' package")


# ---------------------------------------------------------------------------
# Real-Debrid API
# ---------------------------------------------------------------------------
def rd_get(endpoint: str, params: dict | None = None) -> dict | list:
    """Rate-limited GET request to RD API with retries."""
    url = f"{RD_BASE}{endpoint}"
    headers = {"Authorization": f"Bearer {RD_API_KEY}"}

    for attempt in range(MAX_RETRIES):
        time.sleep(RD_RATE_DELAY)
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=30)
            if resp.status_code in (429, 503):
                wait = 2 * (attempt + 1)
                print(f"  {resp.status_code} on {endpoint}, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt < MAX_RETRIES - 1:
                wait = 2 * (attempt + 1)
                print(f"  Error: {e}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise
    return {}


def fetch_all_torrents() -> list[dict]:
    """Fetch full torrent list (paginated)."""
    all_torrents = []
    page = 1
    while True:
        print(f"  Fetching page {page}...")
        batch = rd_get("/torrents", params={"page": page, "limit": 100})
        if not batch:
            break
        all_torrents.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return all_torrents


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

SEASON_EPISODE = re.compile(
    r'[Ss](\d{1,2})[Ee](\d{1,3})'
    r'|(\d{1,2})x(\d{1,3})'
    r'|[Ss](\d{1,2})'
    r'|[Ss]eason[\.\s]?(\d{1,2})'
)

YEAR_PATTERN = re.compile(r'[\.\s\(]*((?:19|20)\d{2})[\.\s\)]*')

VIDEO_EXTENSIONS = {'.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg'}


def parse_torrent_name(name: str) -> dict:
    """Parse a torrent name into structured metadata."""
    result = {"original": name}

    year_match = YEAR_PATTERN.search(name)
    if year_match:
        result["year"] = int(year_match.group(1))

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

    clean = name
    for ext in VIDEO_EXTENSIONS:
        if clean.lower().endswith(ext):
            clean = clean[:len(clean) - len(ext)]
            break

    for pattern in [QUALITY_TAGS, SEASON_EPISODE, YEAR_PATTERN]:
        m = pattern.search(clean)
        if m and m.start() > 0:
            clean = clean[:m.start()]
            break

    clean = re.sub(r'[\.\-_]', ' ', clean).strip()
    clean = re.sub(r'[\s\-]+$', '', clean)
    result["title"] = clean

    return result


# ---------------------------------------------------------------------------
# TMDB metadata (optional)
# ---------------------------------------------------------------------------
def tmdb_search(title: str, media_type: str = "movie", year: int | None = None) -> dict | None:
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
            results = resp.json().get("results", [])
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
    return None


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
    if not os.path.exists(CACHE_PATH):
        return {"tmdb_cache": {}}
    try:
        with open(CACHE_PATH, "rb") as f:
            return json.loads(decrypt_data(f.read(), ENCRYPTION_PASSWORD))
    except Exception as e:
        print(f"  Could not load cache: {e}")
        return {"tmdb_cache": {}}


def save_cache(cache: dict):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(CACHE_PATH, "wb") as f:
        f.write(encrypt_data(json.dumps(cache, separators=(',', ':')), ENCRYPTION_PASSWORD))


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def build_library():
    if not RD_API_KEY:
        print("ERROR: RD_API_KEY environment variable is required")
        sys.exit(1)
    if not ENCRYPTION_PASSWORD:
        print("ERROR: ENCRYPTION_PASSWORD environment variable is required")
        sys.exit(1)

    print("Loading cache...")
    cache = load_cache()
    tmdb_cache = cache.get("tmdb_cache", {})

    print("Fetching torrent list from Real-Debrid...")
    rd_torrents = fetch_all_torrents()
    print(f"  Found {len(rd_torrents)} torrents")

    library = []

    for torrent in rd_torrents:
        if torrent.get("status") != "downloaded":
            continue

        parsed = parse_torrent_name(torrent.get("filename", ""))
        raw_links = torrent.get("links", [])
        is_pack = len(raw_links) > 1

        # TMDB metadata (cached across runs)
        tmdb_key = f"{parsed['title'].lower()}|{parsed.get('year', '')}|{parsed['type']}"
        tmdb_data = tmdb_cache.get(tmdb_key)
        if tmdb_data is None and TMDB_API_KEY:
            print(f"  TMDB lookup: {parsed['title']}...")
            tmdb_data = tmdb_search(parsed["title"], parsed["type"], parsed.get("year"))
            tmdb_cache[tmdb_key] = tmdb_data

        entry = {
            "id": torrent["id"],
            "filename": torrent.get("filename", ""),
            "title": parsed["title"],
            "type": parsed["type"],
            "year": parsed.get("year"),
            "season": parsed.get("season"),
            "episode": parsed.get("episode"),
            "size": torrent.get("bytes", 0),
            "added": torrent.get("added", ""),
            "raw_links": raw_links,
            "is_pack": is_pack,
        }

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

    print(f"\nLibrary built: {len(library)} torrents")

    library.sort(key=lambda x: x.get("added", ""), reverse=True)

    # Save TMDB cache
    cache["tmdb_cache"] = tmdb_cache
    save_cache(cache)
    print("Cache saved")

    # Encrypt and save library
    # RD API key included so browser can unrestrict on-demand
    library_json = json.dumps({
        "version": 4,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rd_key": RD_API_KEY,
        "items": library,
    }, separators=(',', ':'))
    encrypted = encrypt_data(library_json, ENCRYPTION_PASSWORD)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LIBRARY_PATH, "w") as f:
        f.write(base64.b64encode(encrypted).decode("ascii"))

    print(f"Library encrypted and saved to {LIBRARY_PATH}")
    print(f"  Size: {len(encrypted)} bytes encrypted, {len(library_json)} bytes plaintext")


if __name__ == "__main__":
    build_library()
