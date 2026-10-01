import tls from 'tls';

export function checkDomainSsl(domain, port = 443, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const cleanDomain = domain.trim().replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];

    const socket = tls.connect(
      {
        host: cleanDomain,
        port,
        servername: cleanDomain,
        rejectUnauthorized: false,
        timeout,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          socket.end();

          if (!cert || Object.keys(cert).length === 0) {
            resolve({
              domain: cleanDomain,
              hasCertificate: false,
              error: 'No SSL certificate returned by host',
            });
            return;
          }

          const validFrom = new Date(cert.valid_from);
          const validTo = new Date(cert.valid_to);
          const now = new Date();
          const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

          const sans = cert.subjectaltname
            ? cert.subjectaltname.split(', ').map(s => s.replace(/^DNS:/, ''))
            : [];

          resolve({
            domain: cleanDomain,
            hasCertificate: true,
            isValid: now >= validFrom && now <= validTo,
            daysRemaining,
            needsRenewal: daysRemaining <= 30,
            validFrom: validFrom.toISOString(),
            validTo: validTo.toISOString(),
            subject: cert.subject,
            issuer: cert.issuer,
            sans,
            serialNumber: cert.serialNumber,
            fingerprint256: cert.fingerprint256,
          });
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      }
    );

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Connection to ${cleanDomain}:${port} timed out after ${timeout}ms`));
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(new Error(`Failed to check SSL on ${cleanDomain}:${port}: ${err.message}`));
    });
  });
}
