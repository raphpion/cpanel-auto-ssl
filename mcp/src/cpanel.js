import axios from 'axios';
import https from 'https';

export function normalizeHost(rawHost) {
  let host = (rawHost || '').trim();
  if (!host) {
    throw new Error('cPanel host is required');
  }
  if (!host.startsWith('http://') && !host.startsWith('https://')) {
    host = `https://${host}`;
  }
  const url = new URL(host);
  if (!url.port) {
    url.port = '2083';
  }
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

export async function uapi(config, moduleName, functionName, params = {}) {
  const host = normalizeHost(config.host);
  const username = (config.username || '').trim();
  const token = (config.token || '').trim();

  if (!username || !token) {
    throw new Error('cPanel username and API token are required');
  }

  const endpoint = `${host}/execute/${encodeURIComponent(moduleName)}/${encodeURIComponent(functionName)}`;
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  }

  const agent = new https.Agent({
    rejectUnauthorized: config.rejectUnauthorized ?? false,
  });

  try {
    const response = await axios.post(endpoint, searchParams.toString(), {
      headers: {
        Authorization: `cpanel ${username}:${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      httpsAgent: agent,
      timeout: 30000,
    });

    const resData = response.data;
    if (resData.status === 0) {
      const errMsg = Array.isArray(resData.errors) && resData.errors.length > 0
        ? resData.errors.join('; ')
        : `cPanel API call ${moduleName}::${functionName} failed`;
      throw new Error(errMsg);
    }

    return resData.data;
  } catch (err) {
    if (err.response && err.response.data && err.response.data.errors) {
      throw new Error(`cPanel Error (${moduleName}::${functionName}): ${err.response.data.errors.join('; ')}`);
    }
    throw new Error(`cPanel Request Failed (${moduleName}::${functionName}): ${err.message}`);
  }
}

export async function testCpanelConnection(config) {
  try {
    const data = await uapi(config, 'SSL', 'installed_hosts');
    return {
      success: true,
      message: 'Successfully connected to cPanel UAPI',
      installedHostsCount: Array.isArray(data) ? data.length : 0,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

export async function listInstalledHosts(config) {
  return await uapi(config, 'SSL', 'installed_hosts');
}

export async function installSslCertificate(config, { domain, cert, key, cabundle }) {
  if (!domain || !cert || !key) {
    throw new Error('domain, cert, and key are required to install SSL');
  }

  const params = {
    domain,
    cert,
    key,
  };
  if (cabundle) {
    params.cabundle = cabundle;
  }

  const result = await uapi(config, 'SSL', 'install_ssl', params);
  return result;
}

export async function api2(config, moduleName, functionName, params = {}) {
  const host = normalizeHost(config.host);
  const username = (config.username || '').trim();
  const token = (config.token || '').trim();

  if (!username || !token) {
    throw new Error('cPanel username and API token are required');
  }

  const endpoint = `${host}/json-api/cpanel`;
  const allParams = {
    cpanel_jsonapi_user: username,
    cpanel_jsonapi_apiversion: '2',
    cpanel_jsonapi_module: moduleName,
    cpanel_jsonapi_func: functionName,
    ...params,
  };

  const agent = new https.Agent({
    rejectUnauthorized: config.rejectUnauthorized ?? false,
  });

  try {
    const response = await axios.get(endpoint, {
      params: allParams,
      headers: {
        Authorization: `cpanel ${username}:${token}`,
      },
      httpsAgent: agent,
      timeout: 30000,
    });

    const resData = response.data;
    if (resData?.cpanelresult?.error) {
      throw new Error(resData.cpanelresult.error);
    }
    return resData?.cpanelresult?.data;
  } catch (err) {
    throw new Error(`cPanel API2 Error (${moduleName}::${functionName}): ${err.message}`);
  }
}

export function sanitizeWebroot(rawWebroot) {
  let clean = (rawWebroot || 'public_html').trim().replace(/\\/g, '/');
  // Strip leading slashes
  clean = clean.replace(/^\/+/, '');
  // Strip /home/<user>/ if the user entered full absolute Linux path
  clean = clean.replace(/^home\/[^/]+\//, '');
  // Strip trailing slashes
  clean = clean.replace(/\/+$/, '');
  return clean || 'public_html';
}

export async function saveHttpChallengeFile(config, { token, keyAuthorization, webroot = 'public_html' }) {
  const cleanToken = (token || '').trim();
  // Safety guard: ACME tokens are strictly alphanumeric with hyphens/underscores
  if (!cleanToken || !/^[A-Za-z0-9_-]+$/.test(cleanToken)) {
    throw new Error(`Safety violation: Refusing to create file with invalid token name: "${token}"`);
  }

  const root = sanitizeWebroot(webroot);
  if (root.includes('..') || root.startsWith('/')) {
    throw new Error(`Safety violation: Path traversal detected in webroot: "${webroot}"`);
  }

  // Ensure directory exists or create it using API2 mkdir
  try {
    await api2(config, 'Fileman', 'mkdir', { path: root, name: '.well-known' }).catch(() => {});
    await api2(config, 'Fileman', 'mkdir', { path: `${root}/.well-known`, name: 'acme-challenge' }).catch(() => {});
  } catch {
    // Ignore if directory already exists
  }

  const dir = `${root}/.well-known/acme-challenge`;
  return await uapi(config, 'Fileman', 'save_file_content', {
    dir,
    file: cleanToken,
    content: keyAuthorization,
  });
}

export async function removeHttpChallengeFile(config, { token, webroot = 'public_html' }) {
  const cleanToken = (token || '').trim();
  // Safety guard: prevent empty string, wildcard, or traversal that could delete anything else
  if (!cleanToken || !/^[A-Za-z0-9_-]+$/.test(cleanToken)) {
    console.error(`[Safety] Refusing to remove challenge file: token "${token}" is invalid or empty.`);
    return null;
  }

  const root = sanitizeWebroot(webroot);
  if (root.includes('..') || root.startsWith('/')) {
    console.error(`[Safety] Refusing to remove challenge file: webroot "${webroot}" is invalid.`);
    return null;
  }

  // Target path must strictly be within .well-known/acme-challenge
  const filePath = `${root}/.well-known/acme-challenge/${cleanToken}`;
  if (!filePath.includes('/.well-known/acme-challenge/')) {
    console.error(`[Safety] Refusing to unlink: target path "${filePath}" is not inside .well-known/acme-challenge`);
    return null;
  }

  try {
    return await api2(config, 'Fileman', 'fileop', {
      op: 'unlink',
      sourcefiles: filePath,
    });
  } catch {
    return null;
  }
}

export async function addDnsTxtRecord(config, { domain, name, txtdata, ttl = 300 }) {
  const recordName = name.endsWith('.') ? name : `${name}.`;
  return await uapi(config, 'ZoneEdit', 'add_zone_record', {
    domain,
    name: recordName,
    type: 'TXT',
    txtdata,
    ttl: String(ttl),
  });
}

export async function removeDnsRecord(config, { domain, line }) {
  if (!line && line !== 0) return null;
  try {
    return await uapi(config, 'ZoneEdit', 'remove_zone_record', {
      domain,
      line: String(line),
    });
  } catch (err) {
    return null;
  }
}
