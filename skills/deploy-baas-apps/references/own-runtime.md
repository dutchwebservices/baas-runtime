# Application-Owned Runtime

Use this flow when the application owns its TypeScript runtime: a Next.js BFF, API service, or full-stack server. BaaS manages the project connection, storage, telemetry, and other enabled resources while the application retains its own request handling.

## Deploy A Local Project

```bash
baas-cli login

baas-cli deploy /absolute/path/to/app \
  --name "POS Menu" \
  --branch main \
  --build-command "bun run build" \
  --run-command "bun run start" \
  --deploy-on-push
```

Choose `bun`, `npm`, `pnpm`, or `yarn` from the repository lockfiles and scripts. Always provide a run command for an application that starts a server.

## Connect The Runtime

Create the project-only connection from the local repository:

```bash
baas-cli runtime connect --project PROJECT_ID
```

This writes server-only configuration locally. Do not copy generated values into browser code, source control, or public deployment configuration. Use the TypeScript package for authenticated BaaS calls and server telemetry:

```ts
import { createBaasClient, createBaasRuntime } from "@dutchwebservices/baas-runtime";

const runtime = createBaasRuntime({ service: "api" });
await runtime.start();

const client = createBaasClient({
  url: process.env.BAAS_APP_URL,
  accessToken: () => currentRequestAccessToken(),
});
```

Forward the actual caller's access token to `createBaasClient`; do not replace it with the telemetry connection credential.

## Required Application Shape

The running service must listen on the supplied port:

```ts
const port = Number(process.env.PORT || 8080);
```

Keep business secrets in `baas-cli secrets set`. Use the generated resource configuration only on the server and preserve project-level isolation when caching, storing objects, or processing jobs.

## Verify

```bash
baas-cli apps get PROJECT_ID
baas-cli frontend get PROJECT_ID
baas-cli logs --app-id PROJECT_ID
```

If a deployment fails, inspect its logs first. Correct the build/run commands or missing application secret, redeploy, and verify the application responds successfully before completing the task.
