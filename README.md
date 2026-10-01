# Automated cPanel SSL Renewal & Certificate Management

A generic, automated SSL/TLS certificate management solution for websites hosted on **cPanel**. It supports automated Let's Encrypt ACME challenges (HTTP-01 and DNS-01), cPanel UAPI certificate installation, live TLS verification, and background renewal via GitHub Actions.

This project is built to work seamlessly with **any domain**, **any cPanel hosting account**, and across all major **AI coding assistants and providers** (Google Antigravity, Anthropic Claude, OpenAI ChatGPT, Cursor, Windsurf, GitHub Copilot).

---

## Architecture

```
[ AI Assistant / CLI / GitHub Action ]
                    │
                    ▼ (MCP Protocol or CLI Runner)
         [ cpanel-ssl Engine ]
   ├── ACME Client (Let's Encrypt)
   │     ├── HTTP-01 Challenge (via cPanel Fileman API)
   │     └── DNS-01 Challenge  (via cPanel ZoneEdit API)
   ├── TLS Live Certificate Inspector (port 443 handshake)
   ├── cPanel UAPI Deployer    (SSL::install_ssl)
   └── WSL Certbot Runner      (optional fallback)
```

---

## Quick Start

### 1. Configure Credentials

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your cPanel server details:

```env
# cPanel Server Connection
CPANEL_HOST=https://cpanel.yourdomain.com:2083
CPANEL_USERNAME=your_cpanel_username
CPANEL_API_TOKEN=your_cpanel_api_token_here
CPANEL_VERIFY_SSL=false

# Let's Encrypt / ACME Settings
ACME_EMAIL=admin@yourdomain.com
ACME_STAGING=false
CPANEL_WEBROOT=public_html

# Target Domains (comma-separated)
# Optional: if left blank, automated scripts will auto-detect hosted domains from your cPanel account
DOMAINS=example.com,www.example.com
```

> [!NOTE]
> To generate an API Token in cPanel, go to: **cPanel -> Security -> Manage API Tokens -> Create API Token**.  
> Ensure the token includes permissions for **SSL**, **File Storage / Fileman** (for HTTP-01 challenge), and **Zone Editor** (for DNS-01 challenge).

### 2. Verify Your Setup

Run the setup verification script:

```bash
npm run check-setup
```

This verifies:
- Node.js runtime and environment configuration
- Availability of WSL / Certbot (if installed)
- Live authentication and connection to your cPanel server
- Status and expiration dates of all installed SSL certificates on your account

### 3. Run Automated SSL Renewal

```bash
# Standard smart auto-renewal (skips if > 30 days remaining)
npm run renew

# Dry Run: tests challenges & generates certificate, but SKIPS cPanel installation
npm run renew:dry

# Dry Run with Let's Encrypt Staging (safest test mode without rate limits)
npm run renew:dry:staging

# Force immediate live renewal (even if healthy)
npm run renew -- --force
```

- **Smart check**: If your certificate has **> 30 days remaining**, it skips renewal to prevent rate limits and save resources.
- **Dry run (`npm run renew:dry` or `--dry`)**: Completes the ACME challenge and generates the certificate to verify your cPanel webroot/DNS configuration, but **skips installation to cPanel**.
- **Auto-renew**: If expiration is **$\le$ 30 days** (or already expired), it issues a new Let's Encrypt certificate, deploys it to cPanel, and verifies the live HTTPS handshake.
- **Force renewal**: `npm run renew -- --force` (or `FORCE_RENEWAL=true npm run renew`)
- **Staging mode**: `npm run renew -- --staging` (or `STAGING=true npm run renew`)

---

## Multi-AI Provider Support

The skill and MCP server are configured for all major AI assistants:

| Provider / Tool | Integration Files | How to Use |
| :--- | :--- | :--- |
| **Google Antigravity** | [`.agents/skills/ssl-renewal/SKILL.md`](file:///.agents/skills/ssl-renewal/SKILL.md) | Natively loaded as the `ssl-renewal` skill with `cpanel-ssl` MCP server. |
| **Anthropic Claude Code** | [`CLAUDE.md`](file:///CLAUDE.md), [`.claude/skills/ssl-renewal/SKILL.md`](file:///.claude/skills/ssl-renewal/SKILL.md), [`.mcp.json`](file:///.mcp.json) | Claude Code automatically picks up `CLAUDE.md` and `.mcp.json`. Run commands like `/skill ssl-renewal` or ask directly. |
| **Anthropic Claude Desktop** | [`mcp/claude_desktop_config.example.json`](file:///mcp/claude_desktop_config.example.json) | Add the snippet to your `claude_desktop_config.json` to enable `cpanel-ssl` tools in Claude Desktop. |
| **OpenAI ChatGPT / Custom GPTs** | [`AGENTS.md`](file:///AGENTS.md), [`instructions/chatgpt-instructions.md`](file:///instructions/chatgpt-instructions.md) | Copy instructions into a Custom GPT or ChatGPT Project to manage SSL renewals via chat. |
| **Cursor IDE** | [`.cursorrules`](file:///.cursorrules), [`.cursor/rules/ssl-renewal.mdc`](file:///.cursor/rules/ssl-renewal.mdc), [`.mcp.json`](file:///.mcp.json) | Cursor automatically applies the rules and connects to the MCP server. |
| **Windsurf (Codeium)** | [`.windsurfrules`](file:///.windsurfrules), [`.mcp.json`](file:///.mcp.json) | Windsurf Cascade reads the rules file and loads tools from `.mcp.json`. |
| **GitHub Copilot** | [`.github/copilot-instructions.md`](file:///.github/copilot-instructions.md) | Copilot Chat uses workspace context for SSL management commands. |

### Example Prompts for Any AI Assistant:
- *"Check the SSL certificate status for example.com"*
- *"Renew the SSL certificate for example.com using HTTP-01 challenge"*
- *"Issue a wildcard SSL certificate for *.example.com using DNS-01 challenge"*
- *"Verify cPanel connection and list all installed certificates"*
- *"Force renewal of our SSL certificate and install it on cPanel"*

---

## Automated Background Renewal (GitHub Actions)

A scheduled GitHub Actions workflow is provided in [`.github/workflows/ssl-renew.yml`](file:///.github/workflows/ssl-renew.yml).

### How It Works:
* **Schedule**: Automatically runs twice a month (1st & 15th at 03:00 UTC).
* **Smart Expiry Check**: If the certificate has **> 30 days remaining**, it skips renewal in ~2 seconds (costing $0 / 0 runner quota).
* **Auto-Renewal**: Once expiration is **$\le$ 30 days**, it automatically issues a new Let's Encrypt certificate, installs it to cPanel, and verifies live HTTPS.
* **Manual Trigger**: You can run it on demand anytime via GitHub web UI (**Actions $\rightarrow$ Automated SSL Renewal $\rightarrow$ Run workflow**).

### Required GitHub Secrets:
Add the following in your GitHub repository (**Settings $\rightarrow$ Secrets and variables $\rightarrow$ Actions**):

| Secret Name | Value Example | Description |
| :--- | :--- | :--- |
| `CPANEL_HOST` | `https://cpanel.yourdomain.com:2083` | cPanel Server URL |
| `CPANEL_USERNAME` | `your_cpanel_username` | cPanel Username |
| `CPANEL_API_TOKEN` | *(Your cPanel API Token)* | API Token with SSL, Fileman, and ZoneEdit access |
| `ACME_EMAIL` | `admin@yourdomain.com` | Let's Encrypt notification email |
| `DOMAINS` | `example.com,www.example.com` | Comma-separated domain list to manage |
| `CPANEL_VERIFY_SSL` *(Optional)* | `false` | Set to `true` if cPanel host cert is trusted |

---

## MCP Server Tools Reference

When running the MCP server (`npm run mcp`), the following tools are available to AI agents:

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `check_ssl_certificate` | `domain`, `port` | Checks live certificate validity, expiration date, SANs, and days remaining via TLS handshake. |
| `renew_domain_ssl` | `domain`, `alt_names`, `challenge_type`, `force`, `staging`, `webroot` | Complete end-to-end pipeline: check expiry $\rightarrow$ issue ACME cert $\rightarrow$ install to cPanel $\rightarrow$ verify live HTTPS. |
| `issue_ssl_certificate` | `domains`, `email`, `challenge_type`, `staging`, `webroot`, `base_domain` | Generates private key/CSR and issues signed certificate from Let's Encrypt via HTTP-01 or DNS-01. |
| `cpanel_install_ssl` | `domain`, `cert`, `key`, `cabundle` | Installs and activates SSL certificate on cPanel virtual host via UAPI `SSL::install_ssl`. |
| `cpanel_test_connection` | `host`, `username`, `token` | Validates cPanel UAPI authentication and returns installed host count. |
| `cpanel_list_ssl` | `host`, `username`, `token` | Lists all installed SSL certificates and virtual hosts on the cPanel account. |
| `cpanel_manage_dns_txt` | `action`, `domain`, `name`, `txtdata`, `line` | Adds or removes DNS TXT records in cPanel Zone Editor. |
| `run_certbot_cli` | `args`, `use_wsl` | Runs Certbot CLI via WSL as an alternative engine or diagnostic tool. |
