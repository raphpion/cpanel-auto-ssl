# GitHub Copilot Instructions for cPanel Auto SSL

This workspace manages automated SSL/TLS certificates on cPanel servers using Let's Encrypt ACME and cPanel UAPI.

## Key Tasks & Commands
- **Check environment & certificates**: `npm run check-setup`
- **Execute renewal**: `npm run renew`
- **Dry run simulation**: `npm run renew:dry`
- **MCP server**: `npm run mcp` (tools defined in `mcp/index.js`)

## Architectural Standards
- ACME engine: Uses `acme-client` to generate CSRs and request certificates from Let's Encrypt (Production or Staging).
- Challenge types: `http-01` via cPanel Fileman API (`public_html/.well-known/acme-challenge/`), and `dns-01` via cPanel ZoneEdit API (`_acme-challenge.<domain>`).
- Deployment: Uses cPanel UAPI `SSL::install_ssl`.
- Verification: TLS socket handshake on port 443 via `tls.connect`.
- Expiry threshold: Certificates with > 30 days remaining are considered healthy and skipped unless `FORCE_RENEWAL=true`.
