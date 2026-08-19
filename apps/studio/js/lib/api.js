/**
 * Sunucu API istemcisi.
 *
 * PDF'ler JSON içinde base64 olarak taşınır; ikili veri dönüşümleri burada
 * tek yerde toplanır.
 */

/** ArrayBuffer/Uint8Array → base64 (büyük dosyalarda yığın taşmasını önler). */
export function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
export function fromBase64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('ERR_BAD_RESPONSE', `Sunucu geçersiz yanıt döndürdü (HTTP ${res.status})`, res.status);
  }

  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    throw new ApiError(e.code || 'ERR_UNKNOWN', e.message || `HTTP ${res.status}`, res.status);
  }
  return data;
}

export const api = {
  health:        () => request('/api/health', null, 'GET'),
  render:        (payload) => request('/api/render', payload),
  inspect:       (pdfBytes) => request('/api/inspect', { pdf: toBase64(pdfBytes) }),
  pdfOpen:       (pdfBytes, password) =>
                   request('/api/pdf/open', { pdf: toBase64(pdfBytes), password: password || undefined }),
  pdfEdit:       (payload) => request('/api/pdf/edit', payload),
  stampPreview:  (payload) => request('/api/stamp/preview', payload),
  pfxIdentities: (pfxBytes, password) =>
                   request('/api/pfx/identities', { pfx: toBase64(pfxBytes), password }),
  signPrepare:   (payload) => request('/api/sign/prepare', payload),
  signFinalize:  (payload) => request('/api/sign/finalize', payload),
  signPfx:       (payload) => request('/api/sign/pfx', payload),
  ltvExtend:     (payload) => request('/api/ltv/extend', payload),
  verify:        (payload) => request('/api/verify', payload)
};
