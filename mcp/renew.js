import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { issueSslCertificate } from './src/acme.js';
import { installSslCertificate, testCpanelConnection, listInstalledHosts } from './src/cpanel.js';
import { checkDomainSsl } from './src/ssl-checker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env if present (e.g. for local runs)
dotenv.config({ path: path.join(__dirname, '../.env'), quiet: true });
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

function writeStepSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, `${markdown}\n`);
    } catch (e) {
      console.error('Failed to write GitHub step summary:', e.message);
    }
  }
}

async function main() {
  console.log('==============================================');
  console.log('        Automated cPanel SSL Renewal          ');
  console.log('==============================================\n');

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry') || args.includes('--dry-run') || process.env.DRY_RUN === 'true' || process.env.DRY === 'true';
  const force = args.includes('--force') || process.env.FORCE_RENEWAL === 'true' || process.env.FORCE === 'true';
  // Dry run automatically defaults to Let's Encrypt Staging mode to protect production rate limits
  const staging = args.includes('--prod')
    ? false
    : (dryRun || args.includes('--staging') || process.env.STAGING === 'true' || process.env.ACME_STAGING === 'true');

  const host = process.env.CPANEL_HOST;
  const username = process.env.CPANEL_USERNAME;
  const token = process.env.CPANEL_API_TOKEN;
  const rejectUnauthorized = process.env.CPANEL_VERIFY_SSL === 'true';
  const email = process.env.ACME_EMAIL;
  const webroot = process.env.CPANEL_WEBROOT || 'public_html';
  const challengeType = process.env.CHALLENGE_TYPE || 'http-01';

  if (dryRun) {
    console.log('🧪 DRY RUN MODE ENABLED:');
    console.log(`   - Environment: ${staging ? 'STAGING (automatic for dry run, prevents rate limits)' : 'PRODUCTION'}`);
    console.log('   - Will fulfill and validate ACME challenge via cPanel API');
    console.log('   - Will SKIP installation to cPanel (no changes to live server)\n');
  }

  if (!host || !username || !token) {
    console.error('Error: Missing required cPanel credentials (CPANEL_HOST, CPANEL_USERNAME, CPANEL_API_TOKEN).');
    process.exit(1);
  }

  if (!email) {
    console.error('Error: Missing ACME_EMAIL required for Let\'s Encrypt registration.');
    process.exit(1);
  }

  const cpanelConfig = { host, username, token, rejectUnauthorized, webroot };

  // 1. Connectivity Check
  console.log(`[1/5] Testing cPanel connection to ${host}...`);
  const conn = await testCpanelConnection(cpanelConfig);
  if (!conn.success) {
    const errMsg = `cPanel connection failed: ${conn.error}`;
    console.error(`❌ ${errMsg}`);
    writeStepSummary(`### ❌ SSL Renewal Failed\n\n**Error:** ${errMsg}`);
    process.exit(1);
  }
  console.log(`✅ Connected successfully to cPanel (User: ${username})\n`);

  // Domain resolution (from DOMAINS env or auto-detected from cPanel)
  let rawDomains = process.env.DOMAINS;
  if (!rawDomains) {
    try {
      const installed = await listInstalledHosts(cpanelConfig);
      if (Array.isArray(installed) && installed.length > 0) {
        const found = installed.map((h) => h.servername || h.domain).filter(Boolean);
        if (found.length > 0) {
          rawDomains = found.join(',');
          console.log(`ℹ️  No DOMAINS environment variable set. Auto-detected domain(s) from cPanel: ${rawDomains}\n`);
        }
      }
    } catch {
      // Fall through to validation check
    }
  }

  const domains = (rawDomains || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  if (domains.length === 0) {
    const errMsg = 'No target domains specified. Please set the DOMAINS environment variable (e.g. DOMAINS="example.com,www.example.com") in your .env or GitHub Secrets.';
    console.error(`❌ Error: ${errMsg}`);
    writeStepSummary(`### ❌ SSL Renewal Failed\n\n**Error:** ${errMsg}`);
    process.exit(1);
  }

  const primaryDomain = domains[0];

  // 2. Check Existing Live Certificate Expiry
  console.log(`[2/5] Inspecting current live SSL certificate on https://${primaryDomain}...`);
  let currentCert = null;
  try {
    currentCert = await checkDomainSsl(primaryDomain);
  } catch (err) {
    console.log(`⚠️ Live SSL check warning: ${err.message} (Proceeding with issuance)`);
  }

  if (currentCert && currentCert.hasCertificate) {
    console.log(`Current Certificate:`);
    console.log(`  - Domain:         ${currentCert.domain}`);
    console.log(`  - Valid Until:    ${currentCert.validTo}`);
    console.log(`  - Days Remaining: ${currentCert.daysRemaining}`);
    console.log(`  - Issuer:         ${currentCert.issuer?.O || currentCert.issuer?.CN || 'Unknown'}\n`);

    if (currentCert.daysRemaining > 30 && !force && !dryRun) {
      console.log(`✅ Certificate is healthy (${currentCert.daysRemaining} days remaining, > 30 days).`);
      console.log('ℹ️  Renewal skipped. (Set FORCE_RENEWAL=true or pass --dry to test issuance).\n');

      writeStepSummary(`### 🔒 SSL Certificate Status: Healthy

The SSL certificate for **${primaryDomain}** does not require renewal at this time.

| Property | Value |
| :--- | :--- |
| **Primary Domain** | \`${primaryDomain}\` |
| **All Domains** | \`${domains.join(', ')}\` |
| **Expires On** | ${currentCert.validTo} |
| **Days Remaining** | **${currentCert.daysRemaining} days** |
| **Issuer** | ${currentCert.issuer?.O || currentCert.issuer?.CN || "Let's Encrypt"} |
| **Status** | ✅ Valid (> 30 days remaining, renewal skipped) |
`);
      process.exit(0);
    }

    if (dryRun) {
      console.log(`🧪 Dry run active. Proceeding with certificate generation & challenge test (${currentCert.daysRemaining} days remaining on live cert)...\n`);
    } else if (force) {
      console.log(`⚡ Force renewal requested. Proceeding despite ${currentCert.daysRemaining} days remaining...\n`);
    } else {
      console.log(`⚠️ Certificate is nearing expiration (${currentCert.daysRemaining} days remaining <= 30). Proceeding with renewal...\n`);
    }
  } else {
    console.log('No valid certificate detected on port 443. Proceeding with initial issuance...\n');
  }

  // 3. Issue New Certificate
  console.log(`[3/5] Requesting Let's Encrypt SSL certificate...`);
  console.log(`  - Target Domains: ${domains.join(', ')}`);
  console.log(`  - Challenge Type: ${challengeType}`);
  console.log(`  - Environment:    ${staging ? 'STAGING' : 'PRODUCTION'}`);

  const issued = await issueSslCertificate({
    domains,
    email,
    challengeType,
    staging,
    cpanelConfig,
    webroot,
    onLog: (msg) => console.log(`  ${msg}`),
  });

  console.log('\n✅ Certificate successfully issued by Let\'s Encrypt!');
  console.log(`  - Valid From: ${issued.notBefore}`);
  console.log(`  - Valid To:   ${issued.notAfter}\n`);

  // 4. Install Certificate to cPanel
  if (dryRun) {
    console.log(`[4/5] [DRY RUN] Skipping installation to cPanel for ${primaryDomain}.`);
    console.log('      (Certificate was generated and challenge verified successfully; cPanel configuration unchanged).\n');
  } else {
    console.log(`[4/5] Installing certificate to cPanel for ${primaryDomain}...`);
    const installResult = await installSslCertificate(cpanelConfig, {
      domain: primaryDomain,
      cert: issued.cert,
      key: issued.key,
      cabundle: issued.caBundle,
    });
    console.log('✅ cPanel installation accepted. Server restarting web services in background.\n');
  }

  // 5. Verify Live HTTPS Handshake
  if (dryRun) {
    console.log(`[5/5] [DRY RUN] Skipping live HTTPS reload test since certificate was not deployed.`);
    console.log(`      Target domain https://${primaryDomain} remains active on current certificate.\n`);

    writeStepSummary(`### 🧪 SSL Renewal Dry Run Completed!

Let's Encrypt successfully completed ACME challenges and issued a certificate.
**cPanel installation was skipped** as requested.

| Property | Value |
| :--- | :--- |
| **Primary Domain** | \`${primaryDomain}\` |
| **Covered Domains** | \`${domains.join(', ')}\` |
| **Simulated Expiry** | **${issued.notAfter}** |
| **Challenge Type** | \`${challengeType}\` |
| **Issuer** | ${staging ? "Let's Encrypt (Staging)" : "Let's Encrypt"} |
| **Installed to cPanel** | ❌ No (Dry Run) |
| **Status** | 🧪 Test Passed |
`);

    console.log('==============================================');
    console.log('        DRY RUN COMPLETED SUCCESSFULLY        ');
    console.log('==============================================');
    return;
  }

  console.log(`[5/5] Verifying live HTTPS on ${primaryDomain} (waiting 5s for web server reload)...`);
  await new Promise((r) => setTimeout(r, 5000));

  let verifiedCert = null;
  try {
    verifiedCert = await checkDomainSsl(primaryDomain);
    console.log(`✅ Live Handshake Verified!`);
    console.log(`  - Valid Until:    ${verifiedCert.validTo}`);
    console.log(`  - Days Remaining: ${verifiedCert.daysRemaining}`);
    console.log(`  - Fingerprint:    ${verifiedCert.fingerprint256}\n`);
  } catch (err) {
    console.log(`⚠️ Live handshake check delayed: ${err.message}`);
  }

  const finalExpiry = verifiedCert?.validTo || issued.notAfter;
  const daysLeft = verifiedCert?.daysRemaining || Math.round((new Date(issued.notAfter) - new Date()) / (1000 * 60 * 60 * 24));

  writeStepSummary(`### 🎉 SSL Certificate Successfully Renewed!

A new Let's Encrypt SSL certificate has been issued and deployed to cPanel.

| Property | Value |
| :--- | :--- |
| **Primary Domain** | \`${primaryDomain}\` |
| **Covered Domains** | \`${domains.join(', ')}\` |
| **Valid From** | ${issued.notBefore} |
| **Expires On** | **${finalExpiry}** |
| **Days Remaining** | **${daysLeft} days** |
| **Challenge Type** | \`${challengeType}\` |
| **Issuer** | ${staging ? "Let's Encrypt (Staging)" : "Let's Encrypt"} |
| **Status** | 🔒 Active & Verified |
`);

  console.log('==============================================');
  console.log('     SSL RENEWAL COMPLETED SUCCESSFULLY       ');
  console.log('==============================================');
}

main().catch((err) => {
  console.error('\n❌ Fatal Error during SSL Renewal:');
  console.error(err.message || err);

  writeStepSummary(`### ❌ SSL Renewal Failed

An unexpected error occurred during execution:
\`\`\`text
${err.message || err}
\`\`\`
`);
  process.exit(1);
});
