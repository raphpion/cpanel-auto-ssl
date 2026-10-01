import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  testCpanelConnection,
  listInstalledHosts,
  installSslCertificate,
  addDnsTxtRecord,
  removeDnsRecord,
} from './src/cpanel.js';
import { checkDomainSsl } from './src/ssl-checker.js';
import { issueSslCertificate } from './src/acme.js';
import { runCertbot, readCertbotCertificateFiles } from './src/certbot.js';

// Load .env from workspace root, MCP directory, and CWD
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env'), quiet: true });
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });
dotenv.config({ quiet: true });

function getCpanelConfig(overrides = {}) {
  const host = overrides.host || process.env.CPANEL_HOST;
  const username = overrides.username || process.env.CPANEL_USERNAME;
  const token = overrides.token || process.env.CPANEL_API_TOKEN;
  const rejectUnauthorized = overrides.reject_unauthorized ?? (process.env.CPANEL_VERIFY_SSL === 'true');

  if (!host || !username || !token) {
    return null;
  }

  return {
    host,
    username,
    token,
    rejectUnauthorized,
  };
}

function textResponse(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text }],
  };
}

const server = new McpServer({
  name: 'cpanel-ssl',
  version: '1.0.0',
});

// 1. Tool: check_ssl_certificate
server.tool(
  'check_ssl_certificate',
  'Inspect the live SSL certificate on a domain via HTTPS (checks expiration date, validity, SANs, days remaining, and whether renewal is needed).',
  {
    domain: z.string().describe('Domain name to check (e.g. example.com)'),
    port: z.number().optional().default(443).describe('Port to connect to (default: 443)'),
  },
  async ({ domain, port }) => {
    try {
      const result = await checkDomainSsl(domain, port);
      return textResponse(result);
    } catch (err) {
      return textResponse({ success: false, error: err.message });
    }
  }
);

// 2. Tool: cpanel_test_connection
server.tool(
  'cpanel_test_connection',
  'Test connectivity and authentication to the cPanel UAPI server.',
  {
    host: z.string().optional().describe('cPanel host URL (e.g. https://cpanel.domain.com:2083)'),
    username: z.string().optional().describe('cPanel account username'),
    token: z.string().optional().describe('cPanel API token'),
  },
  async (args) => {
    const config = getCpanelConfig(args);
    if (!config) {
      return textResponse({
        success: false,
        error: 'Missing cPanel credentials. Provide host, username, and token or set CPANEL_HOST, CPANEL_USERNAME, and CPANEL_API_TOKEN.',
      });
    }
    const result = await testCpanelConnection(config);
    return textResponse(result);
  }
);

// 3. Tool: cpanel_list_ssl
server.tool(
  'cpanel_list_ssl',
  'List all SSL certificates and virtual hosts currently installed on the cPanel account.',
  {
    host: z.string().optional().describe('cPanel host URL'),
    username: z.string().optional().describe('cPanel username'),
    token: z.string().optional().describe('cPanel API token'),
  },
  async (args) => {
    const config = getCpanelConfig(args);
    if (!config) {
      return textResponse({
        success: false,
        error: 'Missing cPanel credentials.',
      });
    }
    try {
      const hosts = await listInstalledHosts(config);
      return textResponse({ success: true, count: hosts.length, hosts });
    } catch (err) {
      return textResponse({ success: false, error: err.message });
    }
  }
);

// 4. Tool: issue_ssl_certificate
server.tool(
  'issue_ssl_certificate',
  'Generate a valid SSL certificate from Let\'s Encrypt using ACME. Supports automatic HTTP-01 challenge (saving token in cPanel webroot) or DNS-01 challenge (creating _acme-challenge TXT record in cPanel DNS). Returns cert, key, and CA bundle.',
  {
    domains: z.array(z.string()).describe("List of domains for the certificate, e.g. ['domain.com', 'www.domain.com']"),
    email: z.string().optional().describe("Contact email for Let's Encrypt notifications (defaults to ACME_EMAIL env)"),
    challenge_type: z.enum(['http-01', 'dns-01']).default('http-01').describe("ACME challenge type: 'http-01' (webroot file) or 'dns-01' (DNS TXT record)"),
    staging: z.boolean().optional().default(false).describe("Use Let's Encrypt Staging environment for testing"),
    webroot: z.string().optional().default('public_html').describe('cPanel webroot path for HTTP-01 challenge'),
    base_domain: z.string().optional().describe('DNS Zone name for DNS-01 challenge (defaults to root domain)'),
    host: z.string().optional().describe('cPanel host URL override'),
    username: z.string().optional().describe('cPanel username override'),
    token: z.string().optional().describe('cPanel API token override'),
  },
  async (args) => {
    const config = getCpanelConfig(args);
    const email = args.email || process.env.ACME_EMAIL;
    const isStaging = args.staging ?? (process.env.ACME_STAGING === 'true');

    if (!email) {
      return textResponse({
        success: false,
        error: 'Email address is required for ACME registration. Provide email param or set ACME_EMAIL.',
      });
    }

    try {
      const result = await issueSslCertificate({
        domains: args.domains,
        email,
        challengeType: args.challenge_type,
        staging: isStaging,
        cpanelConfig: config ? { ...config, webroot: args.webroot, baseDomain: args.base_domain } : null,
        webroot: args.webroot,
        onLog: (msg) => console.error(msg),
      });

      return textResponse({
        success: true,
        domains: result.domains,
        notBefore: result.notBefore,
        notAfter: result.notAfter,
        issuer: result.issuer,
        cert: result.cert,
        key: result.key,
        caBundle: result.caBundle,
        summary: `Successfully issued SSL certificate for ${result.domains.join(', ')} via Let's Encrypt (${args.challenge_type})`,
      });
    } catch (err) {
      return textResponse({ success: false, error: err.message });
    }
  }
);

// 5. Tool: cpanel_install_ssl
server.tool(
  'cpanel_install_ssl',
  'Deploy and install an SSL certificate, private key, and optional CA bundle to a domain on the cPanel server.',
  {
    domain: z.string().describe('Target domain name'),
    cert: z.string().describe('PEM-encoded certificate'),
    key: z.string().describe('PEM-encoded private key'),
    cabundle: z.string().optional().describe('PEM-encoded CA bundle (intermediate certificates)'),
    host: z.string().optional().describe('cPanel host URL override'),
    username: z.string().optional().describe('cPanel username override'),
    token: z.string().optional().describe('cPanel API token override'),
  },
  async (args) => {
    const config = getCpanelConfig(args);
    if (!config) {
      return textResponse({ success: false, error: 'Missing cPanel credentials.' });
    }
    try {
      const result = await installSslCertificate(config, {
        domain: args.domain,
        cert: args.cert,
        key: args.key,
        cabundle: args.cabundle,
      });
      return textResponse({
        success: true,
        domain: args.domain,
        message: `Successfully installed SSL certificate for ${args.domain} on cPanel!`,
        result,
      });
    } catch (err) {
      return textResponse({ success: false, error: err.message });
    }
  }
);

// 6. Tool: renew_domain_ssl
server.tool(
  'renew_domain_ssl',
  'Automated end-to-end SSL renewal pipeline: checks current certificate expiry -> if expiring, force=true, or dry_run=true, issues a new certificate from Let\'s Encrypt via cPanel HTTP-01 or DNS-01 challenge -> installs it to cPanel (unless dry_run=true) -> verifies live HTTPS.',
  {
    domain: z.string().describe('Primary domain name (e.g. example.com)'),
    alt_names: z.array(z.string()).optional().describe('Additional domain names / SANs (e.g. [\'www.example.com\'])'),
    email: z.string().optional().describe('Contact email for Let\'s Encrypt'),
    challenge_type: z.enum(['http-01', 'dns-01']).default('http-01').describe('Challenge type to use'),
    force: z.boolean().optional().default(false).describe('Force renewal even if certificate is not yet near expiry'),
    dry_run: z.boolean().optional().default(false).describe('Simulate renewal: completes ACME challenge and generates certificate, but skips cPanel installation and server reload'),
    staging: z.boolean().optional().default(false).describe('Test using Let\'s Encrypt Staging'),
    webroot: z.string().optional().default('public_html').describe('cPanel webroot for HTTP-01'),
    host: z.string().optional().describe('cPanel host URL override'),
    username: z.string().optional().describe('cPanel username override'),
    token: z.string().optional().describe('cPanel API token override'),
  },
  async (args) => {
    const config = getCpanelConfig(args);
    if (!config) {
      return textResponse({ success: false, error: 'cPanel credentials required for automated renewal.' });
    }

    const email = args.email || process.env.ACME_EMAIL;
    if (!email) {
      return textResponse({ success: false, error: 'Email address required for ACME registration.' });
    }

    const domainList = [args.domain, ...(args.alt_names || [])].filter((v, i, a) => a.indexOf(v) === i);

    // Step 1: Check existing certificate
    console.error(`[Renew] Checking existing SSL status for ${args.domain}`);
    let currentCert = null;
    try {
      currentCert = await checkDomainSsl(args.domain);
    } catch (err) {
      console.error(`[Renew] Could not check live SSL (site might not have HTTPS yet): ${err.message}`);
    }

    if (currentCert && currentCert.hasCertificate && !currentCert.needsRenewal && !args.force && !args.dry_run) {
      return textResponse({
        success: true,
        renewed: false,
        domain: args.domain,
        daysRemaining: currentCert.daysRemaining,
        validTo: currentCert.validTo,
        message: `Certificate for ${args.domain} is still valid for ${currentCert.daysRemaining} days (expires ${currentCert.validTo}). Renewal skipped (set force: true or dry_run: true to test issuance).`,
      });
    }

    // Dry run automatically defaults to staging mode to protect production rate limits
    const isStaging = args.dry_run ? (args.staging ?? true) : (args.staging ?? (process.env.ACME_STAGING === 'true'));

    // Step 2: Issue Certificate
    console.error(`[Renew] Issuing certificate for ${domainList.join(', ')} via ${args.challenge_type} (staging: ${isStaging}, dry_run: ${args.dry_run})`);
    const issued = await issueSslCertificate({
      domains: domainList,
      email,
      challengeType: args.challenge_type,
      staging: isStaging,
      cpanelConfig: { ...config, webroot: args.webroot },
      webroot: args.webroot,
      onLog: (msg) => console.error(msg),
    });

    if (args.dry_run) {
      console.error(`[Renew] [DRY RUN] Skipping installation to cPanel for ${args.domain}`);
      return textResponse({
        success: true,
        dryRun: true,
        renewed: false,
        installed: false,
        domain: args.domain,
        domains: domainList,
        validFrom: issued.notBefore,
        validTo: issued.notAfter,
        challengeType: args.challenge_type,
        staging: args.staging,
        issuer: issued.issuer,
        message: `[DRY RUN] Successfully completed ACME challenges and generated Let's Encrypt certificate for ${domainList.join(', ')}! Installation to cPanel was skipped.`,
      });
    }

    // Step 3: Install to cPanel
    console.error(`[Renew] Installing certificate to cPanel for ${args.domain}`);
    const installResult = await installSslCertificate(config, {
      domain: args.domain,
      cert: issued.cert,
      key: issued.key,
      cabundle: issued.caBundle,
    });

    // Step 4: Verify Live HTTPS
    console.error(`[Renew] Verifying live HTTPS for ${args.domain}`);
    let verify = null;
    try {
      verify = await checkDomainSsl(args.domain);
    } catch {
      // Propagation delay might occur
    }

    return textResponse({
      success: true,
      renewed: true,
      domain: args.domain,
      domains: domainList,
      validFrom: issued.notBefore,
      validTo: issued.notAfter,
      challengeType: args.challenge_type,
      staging: args.staging,
      installResult,
      liveVerification: verify,
      message: `Successfully renewed and installed SSL certificate for ${domainList.join(', ')}! Expiration: ${issued.notAfter}`,
    });
  }
);

// 7. Tool: run_certbot_cli
server.tool(
  'run_certbot_cli',
  'Run Certbot directly via WSL (or native binary) with specified arguments, e.g. for manual commands or diagnostics.',
  {
    args: z.array(z.string()).describe("Array of arguments to pass to certbot, e.g. ['certificates'] or ['--help']"),
    use_wsl: z.boolean().optional().default(true).describe('Run through WSL Ubuntu (default: true)'),
  },
  async ({ args, use_wsl }) => {
    const result = await runCertbot({ args, useWsl: use_wsl });
    return textResponse(result);
  }
);

// 8. Tool: cpanel_manage_dns_txt
server.tool(
  'cpanel_manage_dns_txt',
  'Add or remove a DNS TXT record in cPanel Zone Editor (useful for manual or custom DNS-01 challenges).',
  {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    domain: z.string().describe('DNS Zone domain name (e.g. example.com)'),
    name: z.string().optional().describe('Record name (e.g. _acme-challenge.example.com)'),
    txtdata: z.string().optional().describe('TXT content / challenge token'),
    line: z.number().optional().describe('Record line number (required for remove)'),
    ttl: z.number().optional().default(300).describe('Time to live (seconds)'),
    host: z.string().optional().describe('cPanel host URL override'),
    username: z.string().optional().describe('cPanel username override'),
    token: z.string().optional().describe('cPanel API token override'),
  },
  async (args) => {
    const config = getCpanelConfig(args);
    if (!config) {
      return textResponse({ success: false, error: 'Missing cPanel credentials.' });
    }
    try {
      if (args.action === 'add') {
        if (!args.name || !args.txtdata) {
          return textResponse({ success: false, error: 'name and txtdata are required to add a TXT record' });
        }
        const result = await addDnsTxtRecord(config, {
          domain: args.domain,
          name: args.name,
          txtdata: args.txtdata,
          ttl: args.ttl,
        });
        return textResponse({ success: true, result });
      } else {
        if (args.line === undefined) {
          return textResponse({ success: false, error: 'line number is required to remove a record' });
        }
        const result = await removeDnsRecord(config, {
          domain: args.domain,
          line: args.line,
        });
        return textResponse({ success: true, result });
      }
    } catch (err) {
      return textResponse({ success: false, error: err.message });
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cpanel-ssl-mcp] Server running on stdio');
}

main().catch((err) => {
  console.error('[cpanel-ssl-mcp] Fatal error:', err);
  process.exit(1);
});
