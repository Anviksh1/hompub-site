# HomPub site

Static site for HomPub (independent Android/iOS app studio) — app
showcase + privacy policy. Plain landing page, no dashboard, no
backend: just HTML/CSS, free to host forever.

## Deploy (one-time)

1. Create a new **public** repo on GitHub, e.g. `hompub-site`
   (github.com/new). Don't initialize it with a README.
2. From this folder:
   ```
   git remote add origin https://github.com/<your-username>/hompub-site.git
   git branch -M main
   git push -u origin main
   ```
3. On GitHub: repo → Settings → Pages → Source: "Deploy from a branch"
   → Branch: `main` / `(root)` → Save.
4. GitHub gives you a URL like
   `https://<your-username>.github.io/hompub-site/` within a minute or two.

## Later updates

Edit the HTML/CSS here, then:
```
git add -A && git commit -m "update site"
git push
```
GitHub Pages redeploys automatically within a minute.

## Custom domain (hompub.com or similar) — ~$10–11/year, the only cost

1. **Buy the domain.** Porkbun (~$10.99/yr, no renewal markup games) or
   Cloudflare Registrar (~$10.44/yr, sold at their literal cost) are
   the cheapest honest options. Avoid registrars with a cheap first
   year that jumps on renewal.
2. **Add a `CNAME` file** to this repo containing just the domain
   name (e.g. `hompub.com`), commit, and push.
3. **At the registrar's DNS settings**, add:
   - Four `A` records for the apex (`@`) pointing to:
     `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
   - One `CNAME` record for `www` pointing to
     `<your-username>.github.io`
4. **In GitHub → Settings → Pages**, enter the domain under "Custom
   domain" and save. GitHub auto-provisions a free TLS certificate
   once DNS resolves (minutes to a few hours) — then tick
   "Enforce HTTPS".

Total ongoing cost: the domain only (~$10-11/yr). Hosting stays free.

## HomPub Quiz (pilot)

The one part of this repo that is not a static page. `quiz/` holds
the referee for HomPub Quiz — a live classroom quiz, one teacher on
the projector and a room full of phones — as a Cloudflare Worker with
Durable Objects, plus its host and player pages. GitHub Pages cannot
run it (a live game needs a server holding open connections), so it
deploys to a free Cloudflare account instead: from a laptop with
`npx wrangler deploy`, or automatically from this repo through
`.github/workflows/deploy-quiz.yml` on every push to `main` that
touches `quiz/`.

Everything — running it locally, creating the Cloudflare account,
deploying through GitHub, what the free plan allows, privacy, notes
for teachers — is in [quiz/README.md](quiz/README.md). The contract
the pieces are built against is [quiz/PROTOCOL.md](quiz/PROTOCOL.md).

Cost: hosting stays $0. A subdomain for the referee (e.g.
`quiz.hompub.com`) rides on the same domain as above. Note that
GitHub Pages also serves the raw files under `quiz/public/`; there is
no API behind them there, so the live app is always the Cloudflare URL.
