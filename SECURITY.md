# Security Guidelines

This document outlines security best practices for this repository to protect sensitive information from accidental exposure.

## ⚠️ Never Commit These

### Credentials & Secrets
- Bearer tokens, OAuth tokens, or session cookies
- Client secrets, API keys, or personal access tokens
- Passwords or connection strings
- Private tenant IDs (Entra, Azure subscriptions)
- Application IDs from your organization's tenants

### Test Artifacts
- **HTTP Archive (HAR) files** (`.har`) — These contain:
  - Full HTTP request/response bodies
  - Bearer tokens and OAuth callback URLs
  - Session cookies and authentication headers
  - Query parameters with sensitive values
  - Redirect URLs revealing internal infrastructure
- Screenshots or logs from testing sessions with sensitive data
- Recorded authentication flows or OAuth callbacks

### Internal/Proprietary Documentation
- Internal deployment runbooks (how your organization deploys)
- Implementation review notes revealing architecture decisions
- Validation reports with configuration details
- Internal checklists or operational procedures
- Email addresses or team information
- HAR files from browser sessions (contain full request/response with tokens)

## ✅ Safe to Commit

### Public Documentation
- Setup guides and tutorials (no credentials/endpoints)
- Architecture diagrams and workflow documentation
- API contract documentation
- User-facing troubleshooting guides
- Best practices and patterns

### Templates & Samples
- Configuration file templates (`*_sample.json`, `*_example.*`)
- Environment variable examples (with placeholder values)
- Test data and test scenarios (no real credentials)
- Code snippets and usage examples

### Code & Infrastructure
- Application source code (properly reviewed for secrets)
- Infrastructure-as-code (Bicep, Terraform) templates
- GitHub Actions workflows (secrets stored as repo secrets, not hardcoded)
- Unit tests and integration tests
- Documentation in code (comments, docstrings)

## Local Files (Protected by .gitignore)

These files are configured to never be committed:

| Path | Purpose | Why Protected |
|------|---------|---------------|
| `local.settings.json` | Local development config | Contains `SERVICENOW_CLIENT_SECRET` |
| `logs/` | Test logs and HAR archives | May contain tokens and sensitive data |
| `.env`, `.env.*` | Environment variables | May contain credentials |
| `dist/`, `node_modules/` | Build artifacts | Not needed in version control |
| `.azure/` | Azure Developer CLI state | Contains subscription IDs and live config |

## Private Documentation Storage

For internal-only documents that reveal deployment procedures, architectural decisions, or contain configuration details, keep them in a private location (local only or private wiki):

- First-time deployment runbooks
- Entra app validation reports
- Implementation review notes
- Enterprise deployment checklists
- Tenant-specific configuration docs

Use placeholder values (e.g., `<your-tenant-id>`) in any documentation committed to this repo.

To organize them:
```powershell
# Move sensitive docs from repo root to .private-docs (local only, not committed)
mkdir .private-docs
move AGENT_FIRST_TIME_DEPLOYMENT_RUNBOOK.md .private-docs/
move ENTRA_APP_VALIDATION_REPORT.md .private-docs/
move IMPLEMENTATION_SUMMARY.md .private-docs/
move ENTERPRISE_DEPLOYMENT_CHECKLIST.md .private-docs/
move MULTI_TENANT_IMPLEMENTATION.md .private-docs/
move REPOSITORY_REVIEW.md .private-docs/
```

## Security Checklist for Commits

Before committing, verify:

- [ ] No client secrets, API keys, or tokens in code or files
- [ ] No `.har` files or HTTP archive files
- [ ] No real Azure subscription IDs or Entra tenant IDs
- [ ] No real ServiceNow instance URLs with environment details
- [ ] No real email addresses or usernames
- [ ] No internal documentation with deployment procedures
- [ ] No credentials in comments or commit messages
- [ ] `local.settings.json` is not staged (should be in `.gitignore`)

Use `git diff --staged` or `git show --check` to review changes before committing.

## Secrets Detection

If you accidentally commit sensitive data:

1. **Do not rely on deletion alone** — secrets are in git history
2. **Immediately rotate** all exposed credentials, tokens, and secrets
3. **Use git history tools** to remove from all commits:
   ```powershell
   # Example: Remove logs/ directory from entire history
   git log --follow --pretty=format:"%H" -- logs/ | xargs -L1 git rm -r --cached --ignore-unmatch logs/
   git commit -m "security: Remove logs from history"
   git push --force-with-lease
   ```
4. **Notify the security team** (if applicable)

## Entra App Registration Security

For Entra ID configurations:

- **Never commit `ENTRA_CLIENT_SECRET`** — stored in `.env` and Azure Key Vault only
- **App registration IDs are semi-public** — they're discoverable via OIDC discovery endpoints
- **Tenant IDs are semi-public** — but avoid putting them in public docs with context
- **Redirect URIs can be semi-public** — they're part of OAuth flow, but don't hardcode them in code

Store Entra secrets in:
- Azure Key Vault (production)
- `.env` file (local development, never committed)

## ServiceNow Credentials Security

ServiceNow credentials must never appear in code:

- **OAuth client secret** (`SERVICENOW_CLIENT_SECRET`) → Azure Key Vault + `.env` file
- **Integration user password** (`SERVICENOW_PASSWORD`) → Azure Key Vault + `.env` file
- **Instance URL** (`SERVICENOW_INSTANCE_URL`) → Can be in code/docs (semi-public)
- **OAuth client ID** (`SERVICENOW_CLIENT_ID`) → Can be in code/docs (semi-public)

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not open a public GitHub issue**
2. **Do not discuss in pull requests or comments**
3. **Contact the maintainers privately** (see SECURITY policy in repository)
4. **Allow time for remediation** before public disclosure

## References

- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [GitHub: Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [git-secrets: Prevent committing secrets](https://github.com/awslabs/git-secrets)
- [detect-secrets: Automated secret detection](https://github.com/Yelp/detect-secrets)
