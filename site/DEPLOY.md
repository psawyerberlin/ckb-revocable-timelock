# Deploying crt.chainsolution.net

`site/` is the deploy root: plain static files, no build step, no external resources. Copy the directory to the
web root of `crt.chainsolution.net` (rsync, SFTP, or a static host). `site/app/` is replaced by the build of
`web/` (`npm run build` there copies into it) once spec 04 is done.

nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name crt.chainsolution.net;
    root /var/www/crt.chainsolution.net;   # = site/
    index index.html;
    error_page 404 /404.html;
    location / { try_files $uri $uri/ =404; }
    location /app/ { try_files $uri $uri/ /app/index.html; }   # the app is a single-page app
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer;
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self' https://testnet.ckb.dev https://mainnet.ckb.dev https://csr-monitor.chainsolution.net https://*.joy.id https://cota.nervina.dev wss://testnet.ckb.dev wss://mainnet.ckb.dev; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'";
}
```

Adjust `connect-src` to the RPC and monitor URLs in `deployments/<network>.json` when they change.
Check after deploying: `curl -sI https://crt.chainsolution.net/ | head -1` → `HTTP/2 200`, and open the page with
the network tab: no request may leave the origin except those in `connect-src`.
