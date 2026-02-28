# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | Yes                |
| < 1.0   | No                 |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

If you discover a security vulnerability in WA MCP, please report it responsibly:

1. **Email**: Send details to **security@wamcp.dev**
2. **Subject**: Include "WA MCP Security" in the subject line
3. **Details**: Provide as much information as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Assessment**: Within 7 days, we will assess the severity and confirm the vulnerability
- **Fix**: Critical vulnerabilities will be patched within 14 days; others within 30 days
- **Disclosure**: We will coordinate disclosure timing with you

## Scope

The following are in scope for security reports:

- Authentication bypass (API key validation)
- Remote code execution
- SQL injection (SQLite/Drizzle)
- Path traversal in media handling
- Unauthorized access to WhatsApp instances
- Session hijacking or credential exposure
- Denial of service vulnerabilities

## Best Practices

When deploying WA MCP in production:

- Always set `WA_MCP_API_KEY` to enable authentication
- Use HTTPS (reverse proxy) for the HTTP transport
- Restrict network access to the MCP server
- Keep dependencies up to date
- Monitor logs for suspicious activity

## Recognition

We appreciate security researchers who help keep WA MCP safe. With your permission, we will acknowledge your contribution in our release notes.
