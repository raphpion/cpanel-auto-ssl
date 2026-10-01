# AGENTS.md - Multi-Agent Operating Guide for cPanel Auto SSL

This document provides system instructions, available tools, and workflow procedures for autonomous AI agents (OpenAI, ChatGPT, Claude, Cursor, Windsurf, Copilot, etc.) interacting with this repository.

## Repository Overview

`cpanel-auto-ssl` is a generic, automated SSL/TLS certificate management solution for websites hosted on cPanel. It handles:
1. Live TLS certificate inspection on port 443.
2. Automated ACME certificate issuance from Let's Encrypt using:
   - **HTTP-01 challenge**: Uploads token file to `.well-known/acme-challenge/` in cPanel webroot (`public_html`) via cPanel Fileman API.
   - **DNS-01 challenge**: Creates `_acme-challenge` TXT record in cPanel DNS via ZoneEdit API.
3. Automated deployment and binding in cPanel via `SSL::install_ssl`.
4. Verification of the live HTTPS handshake on the target domain.
5. GitHub Actions scheduled background renewal (runs 1st & 15th of each month, smart-skips if > 30 days remain).

## Agent Execution & CLI Commands

| Command | Action | Description |
| :--- | :--- | :--- |
| `npm run check-setup` | Validate Setup | Tests cPanel credentials, WSL certbot, and lists installed certificates |
| `npm run renew` | Smart Auto-Renewal | Renews certificates expiring in $\le 30$ days; skips healthy certificates |
| `npm run renew:dry` | Dry Run Simulation | Completes challenge & issues test cert; skips installation to cPanel |
| `npm run mcp` | Launch MCP Server | Starts the Model Context Protocol stdio server `cpanel-ssl` |

### Environment Variables

Environment variables are loaded from `.env` in the repository root:
- `CPANEL_HOST`: cPanel URL (e.g. `https://cpanel.yourdomain.com:2083`).
- `CPANEL_USERNAME`: cPanel account username.
- `CPANEL_API_TOKEN`: cPanel API token (requires SSL, Fileman, and ZoneEdit permissions).
- `CPANEL_VERIFY_SSL`: `false` if cPanel hostname certificate is self-signed.
- `ACME_EMAIL`: Contact email for Let's Encrypt registration and expiry alerts.
- `ACME_STAGING`: `true` for testing without rate limits; `false` for production certificates.
- `DOMAINS`: Comma-separated domains to manage (e.g. `example.com,www.example.com`). If not set, scripts attempt auto-detection from cPanel installed virtual hosts.
- `CPANEL_WEBROOT`: Document root relative to cPanel user (default: `public_html`).

## MCP Tools Reference

When connected via MCP:
- `check_ssl_certificate(domain, port=443)`: Returns `{ hasCertificate, daysRemaining, needsRenewal, validTo, issuer, sans }`.
- `renew_domain_ssl(domain, alt_names, challenge_type, force, dry_run, staging)`: Complete end-to-end renewal pipeline (supports `dry_run: true` to skip deployment).
- `issue_ssl_certificate(domains, email, challenge_type, staging, webroot)`: Issues certificate via Let's Encrypt.
- `cpanel_install_ssl(domain, cert, key, cabundle)`: Installs certificate on cPanel.
- `cpanel_test_connection()`: Validates cPanel credentials and connectivity.
- `cpanel_list_ssl()`: Lists all installed hosts and SSL certificates on the cPanel account.
- `cpanel_manage_dns_txt(action, domain, name, txtdata, line)`: Manages DNS TXT records.
- `run_certbot_cli(args, use_wsl)`: Executes Certbot CLI via WSL as an alternative engine.

## Agent Decision Logic

When the user asks you to inspect or renew SSL:
1. **Always Inspect First**: Check the current certificate status (`npm run check-setup` or `check_ssl_certificate`).
2. **Respect Expiration Windows**:
   - If `daysRemaining > 30` and the user did not say "force", report the remaining days and advise that renewal is not yet required.
   - If `daysRemaining <= 30` or `force` is requested, proceed with renewal.
3. **Select Challenge**:
   - Use `http-01` for standard domains and subdomains.
   - Use `dns-01` for wildcards (`*.example.com`) or when HTTP access is blocked.
4. **Confirm HTTPS Handshake**: Always verify that the live web server is serving the new certificate after deployment.
