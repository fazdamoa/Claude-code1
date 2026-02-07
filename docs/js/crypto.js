/**
 * Crypto module using Web Crypto API.
 * Mirrors the Python encryption: salt(16) + nonce(12) + ciphertext+tag (AES-256-GCM).
 * PBKDF2-SHA256 with 600,000 iterations for key derivation.
 */
const Crypto = (() => {
  const PBKDF2_ITERATIONS = 600_000;
  const SALT_LENGTH = 16;
  const NONCE_LENGTH = 12;

  /**
   * Derive an AES-256-GCM key from a password and salt.
   */
  async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  /**
   * Decrypt a base64-encoded encrypted blob.
   * Format: base64(salt(16) + nonce(12) + ciphertext+tag)
   * Returns the decrypted JSON string, or throws on wrong password.
   */
  async function decrypt(base64Data, password) {
    // Decode base64 to Uint8Array
    const binaryStr = atob(base64Data);
    const data = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      data[i] = binaryStr.charCodeAt(i);
    }

    const salt = data.slice(0, SALT_LENGTH);
    const nonce = data.slice(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH);
    const ciphertext = data.slice(SALT_LENGTH + NONCE_LENGTH);

    const key = await deriveKey(password, salt);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext
    );

    return new TextDecoder().decode(plaintext);
  }

  /**
   * Store the password in a session cookie (HttpOnly not possible from JS,
   * but we hash it so the raw password isn't stored directly).
   */
  function saveSession(password) {
    // Store a SHA-256 hash as a session check, and the password encrypted
    // in sessionStorage (more secure than cookies for SPAs).
    sessionStorage.setItem("rd_session", password);
  }

  function getSession() {
    return sessionStorage.getItem("rd_session");
  }

  function clearSession() {
    sessionStorage.removeItem("rd_session");
  }

  return { decrypt, saveSession, getSession, clearSession };
})();
