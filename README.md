# HomPub site

Static site for HomPub (independent Android/iOS app studio) — app
showcase + privacy policy, meant for free hosting on GitHub Pages.

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

## Custom domain (optional)

Buy a domain (e.g. from Namecheap, Google Domains successor, Cloudflare
Registrar), add a `CNAME` file here containing just the domain name,
and point its DNS at GitHub Pages per
https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site
