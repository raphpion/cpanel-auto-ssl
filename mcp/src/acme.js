import acme from 'acme-client';
import dns from 'dns/promises';
import {
  saveHttpChallengeFile,
  removeHttpChallengeFile,
  addDnsTxtRecord,
  removeDnsRecord,
} from './cpanel.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseDomain(domain) {
  const parts = domain.split('.').filter(Boolean);
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join('.');
}

export async function issueSslCertificate({
  domains,
  email,
  challengeType = 'http-01',
  staging = false,
  cpanelConfig = null,
  dnsPropagationWaitSeconds = 20,
  webroot = 'public_html',
  onLog = console.error,
}) {
  const domainList = (Array.isArray(domains) ? domains : [domains])
    .map(d => d.trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0])
    .filter(Boolean);

  if (domainList.length === 0) {
    throw new Error('At least one domain must be specified');
  }

  const primaryDomain = domainList[0];
  const contactEmail = (email || '').trim();
  if (!contactEmail) {
    throw new Error('An email address is required for ACME account registration');
  }

  onLog(`[ACME] Initializing ACME client (Staging: ${staging ? 'YES' : 'NO'}, Challenge: ${challengeType})`);

  const directoryUrl = staging
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  const accountKey = await acme.crypto.createPrivateKey();
  const client = new acme.Client({
    directoryUrl,
    accountKey,
  });

  onLog(`[ACME] Generating private key and CSR for ${domainList.join(', ')}`);
  const [certKey, csr] = await acme.crypto.createCsr({
    commonName: primaryDomain,
    altNames: domainList,
  });

  const createdDnsRecords = [];

  const certificatePem = await client.auto({
    csr,
    email: contactEmail,
    termsOfServiceAgreed: true,
    challengePriority: [challengeType],
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      const d = authz.identifier.value;
      onLog(`[ACME Challenge] Handling ${challenge.type} for ${d}`);

      if (challenge.type === 'http-01') {
        if (!cpanelConfig) {
          throw new Error(
            `Automated HTTP-01 challenge requires cPanel credentials to upload ${challenge.token}`
          );
        }
        onLog(`[ACME Challenge] Uploading token file to cPanel ${webroot}/.well-known/acme-challenge/${challenge.token}`);
        await saveHttpChallengeFile(cpanelConfig, {
          token: challenge.token,
          keyAuthorization,
          webroot,
        });
        // Small delay to ensure web server flush
        await sleep(2000);
      } else if (challenge.type === 'dns-01') {
        if (!cpanelConfig) {
          throw new Error(
            `Automated DNS-01 challenge requires cPanel credentials to create TXT record`
          );
        }
        const baseDomain = cpanelConfig.baseDomain || getBaseDomain(d);
        const recordName = `_acme-challenge.${d}`;
        onLog(`[ACME Challenge] Creating DNS TXT record ${recordName} = ${keyAuthorization} on zone ${baseDomain}`);

        const result = await addDnsTxtRecord(cpanelConfig, {
          domain: baseDomain,
          name: recordName,
          txtdata: keyAuthorization,
          ttl: 300,
        });

        const line = result?.item?.[0]?.line || result?.line;
        createdDnsRecords.push({ domain: baseDomain, line, recordName });

        onLog(`[ACME Challenge] Waiting ${dnsPropagationWaitSeconds}s for DNS propagation...`);
        await sleep(dnsPropagationWaitSeconds * 1000);

        // Verify TXT record via local resolver
        try {
          const records = await dns.resolveTxt(recordName);
          const flat = records.flat();
          if (flat.includes(keyAuthorization)) {
            onLog(`[ACME Challenge] Verified TXT record locally propagated: ${recordName}`);
          }
        } catch {
          onLog(`[ACME Challenge] Local resolver check skipped/pending, proceeding to ACME verification`);
        }
      } else {
        throw new Error(`Unsupported challenge type: ${challenge.type}`);
      }
    },
    challengeRemoveFn: async (authz, challenge) => {
      const d = authz.identifier.value;
      try {
        if (challenge.type === 'http-01' && cpanelConfig) {
          onLog(`[ACME Cleanup] Removing challenge file ${challenge.token} from cPanel`);
          await removeHttpChallengeFile(cpanelConfig, {
            token: challenge.token,
            webroot,
          });
        } else if (challenge.type === 'dns-01' && cpanelConfig) {
          const matched = createdDnsRecords.find(r => r.recordName === `_acme-challenge.${d}`);
          if (matched && matched.line) {
            onLog(`[ACME Cleanup] Removing DNS TXT record line ${matched.line} on zone ${matched.domain}`);
            await removeDnsRecord(cpanelConfig, {
              domain: matched.domain,
              line: matched.line,
            });
          }
        }
      } catch (err) {
        onLog(`[ACME Cleanup Warning] Failed to clean up challenge for ${d}: ${err.message}`);
      }
    },
  });

  onLog(`[ACME] Certificate successfully issued by Let's Encrypt!`);

  const chain = acme.crypto.splitPemChain(certificatePem);
  const cert = chain[0];
  const caBundle = chain.slice(1).join('\n').trim();
  const certInfo = acme.crypto.readCertificateInfo(cert);

  return {
    success: true,
    domains: domainList,
    cert: cert.trim(),
    key: certKey.toString().trim(),
    caBundle,
    fullchain: certificatePem.toString().trim(),
    notBefore: certInfo.notBefore,
    notAfter: certInfo.notAfter,
    issuer: certInfo.issuer,
  };
}
