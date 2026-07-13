# Generated Backend

Use this flow when the project needs BaaS-managed data, authentication, storage, events, and functions without a separately hosted frontend.

## Create The Project

```bash
baas-cli login

baas-cli apps create \
  --name "Store Backend" \
  --slug store-backend \
  --entities entities.json \
  --access-mode jwt
```

If the entity model is not ready, start with an empty `entities.json` file:

```json
[]
```

## Configure And Verify

```bash
baas-cli apps list
baas-cli schema get PROJECT_ID
baas-cli apps get PROJECT_ID
baas-cli apps monitoring PROJECT_ID --window-minutes 60
```

Add functions, scheduled work, storage, webhooks, and events inside the created project. Do not deploy a frontend unless the user asks for one.
