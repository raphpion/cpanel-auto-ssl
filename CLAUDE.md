# cPanel Auto SSL - Claude Assistant & Agent Guide

This repository provides an automated, generic SSL/TLS certificate management and renewal system for domains hosted on cPanel. It integrates Let's Encrypt ACME (HTTP-01 and DNS-01 challenges), cPanel UAPI installation, and live TLS verification.

## Core Commands

- **Check Setup & Status**:
  ```bash
  npm run check-setup
  ```
  Inspects environment credentials, tests live cPanel UAPI connectivity, and displays all installed certificates with expiration dates.

- **Execute Renewal Pipeline**:
  ```bash
  npm run renew
  ```
  Smart automated renewal. Inspects certificate expiry:
  - Skips renewal if > 30 days remaining (safe, $0 cost).
  - Automatically requests, installs, and verifies a new Let's Encrypt certificate if <= 30 days remaining.
  - Supports force renewal: `npm run renew -- --force` (or `FORCE_RENEWAL=true npm run renew`)
  - Supports staging mode: `npm run renew -- --staging` (or `STAGING=true npm run renew`)

- **Dry Run Simulation**:
  ```bash
  npm run renew:dry
  # or with staging:
  npm run renew:dry:staging
  ```
  Completes ACME challenge verification and issues a test certificate, but **skips cPanel installation** and keeps existing live certificates untouched.

- **Launch MCP Server**:
  ```bash
  npm run mcp
  ```
  Runs the stdio Model Context Protocol (MCP) server `cpanel-ssl`.

## Available MCP Tools

When connected via MCP (`.mcp.json` or `claude_desktop_config.json`):

1. `check_ssl_certificate`: Inspects expiration, validity, SANs, and days remaining for any domain.
2. `renew_domain_ssl`: Runs the full automated pipeline (inspect -> issue ACME cert -> install to cPanel -> verify HTTPS handshake). Supports `dry_run: true` to test challenge and issuance without installing to cPanel.
3. `cpanel_test_connection`: Validates cPanel credentials and connectivity.
4. `cpanel_list_ssl`: Lists all virtual hosts and installed certificates on the cPanel account.
5. `issue_ssl_certificate`: Requests Let's Encrypt certificate via `http-01` (webroot file) or `dns-01` (ZoneEdit TXT record).
6. `cpanel_install_ssl`: Installs PEM certificate, private key, and optional CA bundle to cPanel.
7. `cpanel_manage_dns_txt`: Adds or removes DNS TXT records in cPanel Zone Editor.
8. `run_certbot_cli`: Runs Certbot CLI via WSL for fallback diagnostics or manual certificate handling.

## Configuration (.env)

Ensure `.env` in the project root has:
- `CPANEL_HOST`: cPanel URL (e.g. `https://cpanel.yourdomain.com:2083`)
- `CPANEL_USERNAME`: cPanel account username
- `CPANEL_API_TOKEN`: API token with permissions for SSL, File Storage, and Zone Editor
- `CPANEL_VERIFY_SSL`: `false` if cPanel uses self-signed host cert
- `ACME_EMAIL`: Let's Encrypt contact email
- `ACME_STAGING`: `false` for live certificates, `true` for testing
- `DOMAINS`: Comma-separated domains (e.g. `example.com,www.example.com`). If omitted, auto-detects from cPanel installed hosts.

## Best Practices for Claude

1. **Check First**: Always check certificate expiration before renewing (`check_ssl_certificate` or `npm run check-setup`). If > 30 days remain, do not renew unless the user explicitly asks to force renewal.
2. **Challenge Selection**:
   - Use `http-01` for standard domains and subdomains (uploads token to `public_html/.well-known/acme-challenge/`).
   - Use `dns-01` for wildcard certificates (`*.example.com`) or when port 80 is blocked.
3. **Verify Deployment**: Always confirm that the live web server is serving the new certificate on port 443 after installation.
