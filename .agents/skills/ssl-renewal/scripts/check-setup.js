import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  let loadedCount = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      if (!process.env[key] || process.env[key] === '') {
        process.env[key] = val;
        loadedCount++;
      }
    }
  }
  return true;
}

// Search all candidate locations for .env
const candidatePaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'mcp/.env'),
  path.resolve(__dirname, '../../../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../../../mcp/.env'),
  path.join(os.homedir(), '.config/cpanel-ssl/.env'),
  path.join(os.homedir(), '.gemini/mcp-servers/cpanel-ssl-mcp/.env')
];

let envLoadedFrom = null;
for (const p of candidatePaths) {
  if (loadEnvFile(p)) {
    envLoadedFrom = p;
    break;
  }
}

console.log('=== Checking SSL Renewal Environment Setup ===\n');

// 1. Node Environment
console.log('1. Node Environment:');
console.log(`   - Node version: ${process.version}`);
console.log(`   - Platform: ${process.platform}`);
console.log(`   - .env Loaded From: ${envLoadedFrom ? envLoadedFrom : 'None found'}`);

// 2. WSL & Certbot
console.log('\n2. Certbot & WSL Availability:');
try {
  const { stdout } = await execAsync('wsl certbot --version');
  console.log(`   - WSL Certbot: DETECTED (${stdout.trim()})`);
} catch (err) {
  console.log(`   - WSL Certbot: NOT DETECTED (${err.message})`);
}

// 3. Credentials Check
console.log('\n3. cPanel & ACME Credentials:');
const host = process.env.CPANEL_HOST;
const user = process.env.CPANEL_USERNAME;
const token = process.env.CPANEL_API_TOKEN;
const email = process.env.ACME_EMAIL;
const staging = process.env.ACME_STAGING;
const verifySsl = process.env.CPANEL_VERIFY_SSL;
const webroot = process.env.CPANEL_WEBROOT || 'public_html';

console.log(`   - CPANEL_HOST: ${host ? host : 'MISSING (set in .env)'}`);
console.log(`   - CPANEL_USERNAME: ${user ? user : 'MISSING (set in .env)'}`);
console.log(`   - CPANEL_API_TOKEN: ${token ? 'CONFIGURED (' + token.slice(0, 4) + '...' + token.slice(-4) + ')' : 'MISSING (set in .env)'}`);
console.log(`   - CPANEL_VERIFY_SSL: ${verifySsl ? verifySsl : 'false'}`);
console.log(`   - CPANEL_WEBROOT: ${webroot}`);
console.log(`   - ACME_EMAIL: ${email ? email : 'MISSING (set in .env)'}`);
console.log(`   - ACME_STAGING: ${staging === 'true' ? 'true (testing mode)' : 'false (production mode)'}`);
console.log(`   - DOMAINS: ${process.env.DOMAINS ? process.env.DOMAINS : '(not specified; will auto-detect from cPanel hosts)'}`);

if (!host || !user || !token || !email) {
  console.log('\n[!] Missing required environment variables. Please check your .env file.');
  process.exit(0);
}

// 4. Live cPanel Connectivity Test
console.log('\n4. Live cPanel Connection Test:');
try {
  const candidateCpanelPaths = [
    path.resolve(process.cwd(), 'mcp/src/cpanel.js'),
    path.resolve(__dirname, '../../../../mcp/src/cpanel.js'),
    path.resolve(__dirname, '../../../mcp/src/cpanel.js'),
  ];
  const mcpCpanelPath = candidateCpanelPaths.find(p => fs.existsSync(p));
  if (!mcpCpanelPath) {
    throw new Error('Could not locate mcp/src/cpanel.js module');
  }
  const { testCpanelConnection, listInstalledHosts } = await import(`file://${mcpCpanelPath.replace(/\\/g, '/')}`);

  const res = await testCpanelConnection({
    host,
    username: user,
    token,
    rejectUnauthorized: verifySsl === 'true'
  });

  if (res.success) {
    console.log(`   - Connection: [✓] SUCCESS (Authenticated as ${user})`);
    const hosts = await listInstalledHosts({
      host,
      username: user,
      token,
      rejectUnauthorized: verifySsl === 'true'
    });

    console.log(`   - Installed SSL Hosts (${hosts.length}):`);
    for (const h of hosts) {
      const expiry = h.certificate?.not_after ? new Date(h.certificate.not_after * 1000).toISOString() : 'N/A';
      console.log(`     * ${h.servername || h.domain} (Expires: ${expiry})`);
    }
  } else {
    console.log(`   - Connection: [X] FAILED (${res.error})`);
  }
} catch (err) {
  console.log(`   - Connection test error: ${err.message}`);
}
