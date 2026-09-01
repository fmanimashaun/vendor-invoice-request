// Thin fetch wrapper. Cookies carry the vendor session; Cloudflare Access
// adds its own header for client SSO, so both paths just need credentials.

class ApiError extends Error {
  constructor(body, status) {
    super(body?.message || 'Request failed');
    this.code = body?.error || 'unknown';
    this.status = status;
    this.body = body || {};
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data, res.status);
  return data;
}

export { ApiError };

export const api = {
  authMethods: ()               => call('/auth/methods'),
  bootstrap:   ()               => call('/bootstrap'),
  me:          ()               => call('/me'),
  login:       (email, password) => call('/auth/login', { method: 'POST', body: { email, password } }),
  logout:      ()               => call('/auth/logout', { method: 'POST' }),
  switchContext: (role)         => call('/auth/context', { method: 'POST', body: { role } }),

  requests:    (status)         => call(`/requests${status ? `?status=${status}` : ''}`),
  createRequest: (payload)      => call('/requests', { method: 'POST', body: payload }),
  withdraw:    (id)             => call(`/requests/${id}/withdraw`, { method: 'POST' }),
  approve:     (id)             => call(`/requests/${id}/approve`, { method: 'POST' }),
  reject:      (id, reason)     => call(`/requests/${id}/reject`, { method: 'POST', body: { reason } }),

  invoices:    ()               => call('/invoices'),
  saveConfig:  (cfg)            => call('/config', { method: 'PUT', body: cfg }),
  reference:   ()               => call('/reference'),
  fonts:       ()               => call('/fonts'),
  ssoConfig:   ()               => call('/sso-config'),
  saveSsoConfig: (c)            => call('/sso-config', { method: 'PUT', body: c }),
  deleteFont:  (key)            => call(`/fonts/${key}`, { method: 'DELETE' }),
  vendorTemplate: (id)          => call(`/vendors/${id}/template`),
  saveVendorTemplate: (id, t)   => call(`/vendors/${id}/template`, { method: 'PUT', body: { template: t } }),
  uploadFont:  (form)           => fetch('/api/fonts', { method: 'POST', credentials: 'same-origin', body: form })
                                     .then(async (r) => {
                                       const d = await r.json().catch(() => null);
                                       if (!r.ok) throw new ApiError(d, r.status);
                                       return d;
                                     }),
  createSite:  (s)              => call('/sites', { method: 'POST', body: s }),
  updateSite:  (code, s)        => call(`/sites/${code}`, { method: 'PUT', body: s }),
  createBu:    (b)              => call('/business-units', { method: 'POST', body: b }),
  updateBu:    (code, b)        => call(`/business-units/${code}`, { method: 'PUT', body: b }),
  linkBuSite:  (bu, site, on)   => call('/bu-sites', { method: 'POST', body: { bu_code: bu, site_code: site, attached: on } }),
  savePlatformConfig: (c)       => call('/platform-config', { method: 'PUT', body: c }),

  vendors:     ()               => call('/vendors'),
  createVendor: (v)             => call('/vendors', { method: 'POST', body: v }),
  setVendorStatus: (id, status) => call(`/vendors/${id}/status`, { method: 'POST', body: { status } }),

  users:       (vendorId)       => call(`/users${vendorId ? `?vendor_id=${vendorId}` : ''}`),
  clientUsers: ()               => call('/users?org=client'),
  createUser:  (u)              => call('/users', { method: 'POST', body: u }),
  setUserStatus: (id, status)   => call(`/users/${id}/status`, { method: 'POST', body: { status } }),

  pdfUrl:      (invoiceNo)      => `/api/invoices/${encodeURIComponent(invoiceNo)}/pdf`,
};
