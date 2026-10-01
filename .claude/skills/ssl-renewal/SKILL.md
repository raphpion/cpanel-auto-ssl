---
name: ssl-renewal
description: Renew, generate, and install secure SSL/TLS certificates on a cPanel server using Let's Encrypt ACME (HTTP-01 or DNS-01 challenges) or Certbot via WSL.
---

# SSL Renewal & Certificate Management Skill for cPanel

This skill guides the agent through inspecting, requesting, renewing, and deploying SSL/TLS certificates for websites hosted on cPanel. It leverages the `cpanel-ssl` MCP server which automates Let's Encrypt ACME challenges (HTTP-01 and DNS-01) and cPanel UAPI certificate installation, with optional Certbot CLI execution via WSL.

---

## When to Use This Skill

Activate this skill when:
- The user asks to renew or check an SSL certificate for a domain on cPanel.
- An SSL certificate is nearing expiration (<= 30 days remaining) or has already expired.
- The user wants to issue a new secure Let's Encrypt certificate using either **HTTP-01** (webroot) or **DNS-01** (DNS TXT) challenge.
- The user needs to verify whether live HTTPS traffic is serving the expected certificate.

---

## Prerequisites & Environment Configuration

The MCP server connects to cPanel using UAPI and coordinates with Let's Encrypt ACME directories. Verify that credentials are configured either in `.env` (in the project or MCP directory) or in your MCP client config:

```env
CPANEL_HOST=https://cpanel.yourdomain.com:2083
CPANEL_USERNAME=your_cpanel_username
CPANEL_API_TOKEN=your_cpanel_api_token
CPANEL_VERIFY_SSL=false
ACME_EMAIL=admin@yourdomain.com
ACME_STAGING=false
DOMAINS=example.com,www.example.com
```

> [!TIP]
> If testing for the first time, set `ACME_STAGING=true` or pass `staging: true` in tool calls to avoid hitting Let's Encrypt production rate limits (5 failures per hour or 5 duplicate certs per week).

---

## Step-by-Step Procedure

### Step 1: Inspect Current SSL Status

Before issuing a new certificate, determine the existing certificate expiration and SAN coverage:

1. Call `check_ssl_certificate`:
   ```json
   {
     "domain": "example.com"
   }
   ```
2. Check the response fields:
   - `hasCertificate`: Whether a valid cert is currently bound to port 443.
   - `daysRemaining`: Days until expiration.
   - `needsRenewal`: True if <= 30 days remaining.
   - `issuer` & `validTo`: Details of the current certificate.
3. If `daysRemaining > 30` and the user did not explicitly request a forced renewal, report the expiration date to the user and ask if they wish to force renewal.

### Step 2: Choose Challenge Method

Select the appropriate ACME challenge based on domain type and hosting configuration:

| Challenge Type | When to Choose | How It Works |
| :--- | :--- | :--- |
| **`http-01`** (Default) | Standard single domains & subdomains (`example.com`, `www.example.com`) | Automatically uploads `.well-known/acme-challenge/<token>` to cPanel `public_html` via UAPI `Fileman`, verifies with Let's Encrypt, and cleans up the file. |
| **`dns-01`** | Wildcard domains (`*.example.com`) or when HTTP port 80 is blocked/proxied | Automatically creates `_acme-challenge.<domain>` TXT record in cPanel Zone Editor via UAPI `ZoneEdit`, waits for propagation, validates, and cleans up the record. |

### Step 3: Automated Renewal Pipeline (Recommended)

To run the complete check -> request -> install -> verify pipeline in a single step, call `renew_domain_ssl`:

```json
{
  "domain": "example.com",
  "alt_names": ["www.example.com"],
  "challenge_type": "http-01",
  "force": false,
  "dry_run": false,
  "staging": false
}
```

> [!TIP]
> Set `"dry_run": true` if you want to test whether the ACME challenge and certificate issuance succeed without modifying or reinstalling anything in cPanel.

The tool will:
1. Validate whether renewal is required (or forced/dry run).
2. Generate private key & CSR.
3. Fulfill the challenge via cPanel API.
4. Download the signed certificate & intermediate CA bundle from Let's Encrypt.
5. Deploy and bind the certificate in cPanel via `SSL::install_ssl`.
6. Test live TLS handshake on the live domain.

### Step 4: Step-by-Step Alternative (Granular Control)

If you need granular inspection or custom certificate handling:

1. **Test cPanel connectivity**:
   Call `cpanel_test_connection` to ensure API credentials are valid.
2. **Issue Certificate**:
   Call `issue_ssl_certificate`:
   ```json
   {
     "domains": ["example.com", "www.example.com"],
     "challenge_type": "http-01",
     "webroot": "public_html"
   }
   ```
   Save the returned `cert`, `key`, and `caBundle`.
3. **Deploy to cPanel**:
   Call `cpanel_install_ssl`:
   ```json
   {
     "domain": "example.com",
     "cert": "<cert-pem>",
     "key": "<key-pem>",
     "cabundle": "<ca-bundle-pem>"
   }
   ```

### Step 5: WSL / Certbot CLI Fallback (Optional)

If the user prefers running Certbot directly via WSL Ubuntu:

1. Call `run_certbot_cli` to inspect existing certbot certificates:
   ```json
   {
     "args": ["certificates"],
     "use_wsl": true
   }
   ```
2. Run manual certbot issuance if requested:
   ```json
   {
     "args": [
       "certonly",
       "--manual",
       "--preferred-challenges", "dns",
       "-d", "example.com",
       "-d", "*.example.com",
       "--agree-tos",
       "-m", "admin@example.com",
       "--no-eff-email"
     ],
     "use_wsl": true
   }
   ```
3. After certbot finishes, deploy the resulting certificate files into cPanel using `cpanel_install_ssl`.

---

## Troubleshooting & Verification

- **HTTP Challenge 404 / 403**: Check if the site has `.htaccess` redirect rules (such as forcing HTTPS) that block access to `/.well-known/acme-challenge/`. If so, use `dns-01` challenge instead.
- **DNS-01 Propagation Delay**: DNS TXT records can take 15-60 seconds to propagate depending on authoritative nameservers. The tool automatically waits for propagation before signaling Let's Encrypt.
- **cPanel API Authentication Error**: Verify the API token has the necessary permissions in cPanel: `SSL`, `File Storage / Fileman`, and `Zone Editor`.
