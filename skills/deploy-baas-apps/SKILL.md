---
name: deploy-baas-apps
description: Create, connect, and deploy applications with BaaS and baas-cli. Use when Codex is asked to create a BaaS project, deploy a local TypeScript application, connect a frontend to generated BaaS capabilities, configure deployment environment variables, or verify a deployment.
---

# Deploy BaaS Apps

Use `baas-cli` as the project control interface. Work in the developer's local repository for integration changes and deployment preparation. Prefer CLI commands and local code edits over dashboard-only actions unless the user explicitly asks for dashboard operation.

## Operating Rules

1. Run `baas-cli --help` and the relevant subcommand help when command shape matters.
2. Run `baas-cli login` when authentication is missing. Login opens the browser; never ask the user to place a password or access token in a command.
3. Inspect the app repository before selecting build or run commands: package manager, framework, `package.json`, lockfiles, and current git status.
4. Keep the developer's existing changes intact and do not rewrite unrelated code.
5. Use `--output json` when a command result must be read by automation. The deployment target is the BaaS project `id`.

Never commit secrets or infrastructure credentials. Keep generated environment files local, pass third-party secrets through `baas-cli secrets set`, and use `.env.example` only for non-sensitive variable names.

## Choose The Right Flow

Choose one flow, then read its reference before changing code:

- **Generated backend only**: A BaaS-managed runtime, data API, auth, storage, events, and functions without a hosted frontend. Read [generated-backend.md](references/generated-backend.md).
- **Existing frontend plus generated backend**: A frontend needs TypeScript client integration with BaaS before it is deployed. Read [frontend-managed-backend.md](references/frontend-managed-backend.md).
- **Application-owned runtime**: A TypeScript server, BFF, or service retains its runtime and connects to BaaS resources and telemetry. Read [own-runtime.md](references/own-runtime.md).

If the user says “deploy this local path” for an application-owned runtime, prefer:

```bash
baas-cli deploy /absolute/path/to/app --name "App Name"
```

If the source already lives in a Git repository, create the BaaS project first and deploy the linked source with `baas-cli frontend deploy`.

## Local Integration Standard

When a project needs code integration:

1. Add or update the application's BaaS client, authentication boundary, storage adapter, and event handling in the local repository.
2. Keep public runtime URLs in the framework's public environment convention; keep all secrets server-only.
3. Make service applications listen on `process.env.PORT || 8080`.
4. Run the real local test, type-check, and build commands before deployment.
5. Verify the deployed app through the CLI and its live URL, then report the resulting project ID, URL, and deployment state.

## Completion Standard

Do not claim that deployment or integration is complete until the final deployment status is successful and the relevant runtime path has been tested. Report exact commands, the deployed URL, and any unresolved dependency or configuration requirement.
