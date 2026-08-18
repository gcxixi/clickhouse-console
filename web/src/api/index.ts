let csrfToken = '';

export function setCSRFToken(token: string) {
  csrfToken = token;
}

export function getCSRFToken() {
  return csrfToken;
}

const apiRoot = new URL('api/', document.baseURI);

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const opts = { ...options };
  opts.headers = { ...(opts.headers || {}) } as Record<string, string>;

  if (opts.body && typeof opts.body === 'string') {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  if (csrfToken && opts.method && opts.method !== 'GET') {
    (opts.headers as Record<string, string>)['X-CSRF-Token'] = csrfToken;
  }

  const endpoint = new URL(path.replace(/^\/?api\//, ''), apiRoot);
  const response = await fetch(endpoint, opts);

  let data: any = null;
  try {
    data = await response.json();
  } catch {}

  if (response.status === 401 && path !== '/api/login') {
    window.dispatchEvent(new CustomEvent('ch-unauthorized'));
    throw new Error('登录已过期，请重新登录');
  }

  if (!response.ok) {
    const errorMsg = data?.error || `请求失败 (${response.status})`;
    throw new Error(errorMsg);
  }

  return data as T;
}

export async function streamExport(sql: string, format: string, filename: string): Promise<void> {
  const endpoint = new URL('query/stream-export', apiRoot);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
    },
    body: JSON.stringify({ sql, format, filename })
  });

  if (!response.ok) {
    let err = `导出失败 (${response.status})`;
    try {
      const errObj = await response.json();
      err = errObj.error || err;
    } catch {}
    throw new Error(err);
  }

  const blob = await response.blob();
  const objectURL = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const cd = response.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/);
  const actualFilename = match ? match[1] : `${filename}.${format.toLowerCase().includes('json') ? 'json' : 'csv'}`;
  link.href = objectURL;
  link.download = actualFilename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectURL);
}

// Client-side payload encryption with Web Crypto API
export async function encryptPayload(payload: Record<string, any>): Promise<{ key: string; nonce: string; ciphertext: string }> {
  const keyResponse = await api('/api/clusters/transport-key');
  const serverKey = await importServerPublicKey(keyResponse);
  const aesKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertextBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, rawKey, plaintext);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, serverKey, aesKey);

  return {
    key: bytesToBase64(new Uint8Array(wrappedKey)),
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer))
  };
}

async function importServerPublicKey(keyData: any): Promise<CryptoKey> {
  if (keyData && typeof keyData === 'object' && keyData.kty === 'RSA') {
    return crypto.subtle.importKey('jwk', keyData, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  }
  const pem = typeof keyData === 'string' ? keyData : (keyData?.key || '');
  const clean = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\r|\n/g, '');
  const binary = Uint8Array.from(atob(clean), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('spki', binary.buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
