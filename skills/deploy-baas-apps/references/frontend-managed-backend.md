# Existing Frontend With Generated Backend

Use this flow when an existing TypeScript frontend needs a generated BaaS backend. Make the integration in the local repository rather than relying on an opaque dashboard action.

## Create And Inspect The Backend

```bash
baas-cli login

baas-cli apps create \
  --name "Store Backend" \
  --slug store-backend \
  --entities entities.json \
  --access-mode jwt

baas-cli apps get PROJECT_ID
baas-cli schema get PROJECT_ID
```

## Integrate In The Local Repository

Read the framework, package manager, and existing auth state first:

```bash
git status --short
ls
cat package.json
```

Install the public TypeScript client and use the generated runtime URL through the framework's public environment convention:

```bash
npm install github:dutchwebservices/baas-runtime#v0.3.0
```

Example client module:

```ts
import { createBaasClient } from "@dutchwebservices/baas-runtime";

export const baas = createBaasClient({
  url: import.meta.env.VITE_BAAS_URL,
  persistSession: true,
});
```

Use `NEXT_PUBLIC_BAAS_URL` for Next.js browser code or `VITE_BAAS_URL` for Vite. Keep tokens and service credentials out of browser environment variables.

Define entity types from the generated OpenAPI schema and centralize data access in the application's existing service layer.

## Deploy And Verify

Choose commands from the actual repository, then deploy:

```bash
baas-cli frontend deploy PROJECT_ID \
  --repo owner/frontend-repo \
  --branch main \
  --kind static \
  --build-command "npm run build" \
  --output-dir dist \
  --source-dir / \
  --deploy-on-push

baas-cli frontend get PROJECT_ID
baas-cli apps get PROJECT_ID
```

Run the application's test suite, type check, and production build before deploying. Confirm the deployed UI performs the integrated sign-in and data flow.
