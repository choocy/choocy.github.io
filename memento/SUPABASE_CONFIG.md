# Memento Supabase Config

Memento is deployed as static files on GitHub Pages, so browser code cannot read private server environment variables directly.

Use `memento/config.js` as the static deployment equivalent of:

- `MEMENTO_SUPABASE_URL`
- `MEMENTO_SUPABASE_ANON_KEY`

## Environments

- Local, dev, and staging use the `development` entry and must point to `memento-dev`.
- `choocy.app` and `www.choocy.app` use the `production` entry and must point to `memento-prd`.
- During dev testing on the public host, append `?env=dev` to the invite URL to explicitly use `memento-dev`.
- Production intentionally fails closed if `memento/config.js` is not configured for `project: "memento-prd"`, if production placeholders are still present, or if production points to the dev Supabase URL.
- A small `DEV` badge appears only outside the production hosts when the Web UI is using the `memento-dev` config.

## Setup

Edit `memento/config.js`:

```js
development: {
  project: 'memento-dev',
  supabaseUrl: 'https://YOUR-MEMENTO-DEV.supabase.co',
  supabaseAnonKey: 'YOUR_MEMENTO_DEV_ANON_KEY',
  originalsBucket: 'memento-originals',
},
production: {
  project: 'memento-prd',
  supabaseUrl: 'https://YOUR-MEMENTO-PRD.supabase.co',
  supabaseAnonKey: 'YOUR_MEMENTO_PRD_ANON_OR_PUBLISHABLE_KEY',
  originalsBucket: 'memento-originals',
},
```

The Supabase anon key is safe to publish in a static app only when Row Level Security and Storage policies are correct. Never put a service-role key here.

Production values are stored in `memento/config.js` under the `production` entry:

- the `memento-prd` Supabase project URL
- the `memento-prd` anon or publishable key

Do not point production traffic to the dev project. If `memento-prd` is missing schema or policies, the Web UI should show its normal unavailable state instead of silently falling back to dev.

## Deployment Check

Before pushing to `main`, confirm:

- `memento/config.js` production points to `memento-prd`.
- `memento/config.js` production URL is different from the dev Supabase URL.
- `memento/app.js` contains no hardcoded Supabase URL or anon key.
- `memento/config.js` is the only public Supabase environment config file.
- Gallery tiles use `thumbnail_path`.
- Full viewer and video playback use `original_path`.
