import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function runCertbot({
  args = [],
  useWsl = true,
  timeout = 180000,
}) {
  const binary = useWsl ? 'wsl certbot' : 'certbot';
  const fullCommand = `${binary} ${args.join(' ')}`;

  try {
    const { stdout, stderr } = await execAsync(fullCommand, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      success: true,
      command: fullCommand,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    return {
      success: false,
      command: fullCommand,
      exitCode: err.code,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || err.message || '').trim(),
      error: err.message,
    };
  }
}

export async function readCertbotCertificateFiles(domain, { useWsl = true } = {}) {
  const certPath = `/etc/letsencrypt/live/${domain}`;
  const files = ['cert.pem', 'privkey.pem', 'chain.pem', 'fullchain.pem'];
  const result = { domain, files: {} };

  for (const file of files) {
    const cmd = useWsl
      ? `wsl sudo cat "${certPath}/${file}"`
      : `type "${certPath}\\${file}"`;

    try {
      const { stdout } = await execAsync(cmd);
      result.files[file] = stdout.trim();
    } catch (err) {
      result.files[file] = null;
    }
  }

  result.hasCert = Boolean(result.files['cert.pem'] && result.files['privkey.pem']);
  return result;
}
