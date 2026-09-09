#!/usr/bin/env fish
set -l project_dir (path resolve (status dirname)/..)
cd "$project_dir"
mkdir -p .secrets
chmod 700 .secrets
if not test -f .secrets/local-cert.pem
    openssl req -x509 -newkey rsa:2048 -nodes -keyout .secrets/local-key.pem -out .secrets/local-cert.pem -days 30 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1
    or exit 1
end
chmod 600 .secrets/local-key.pem
nub run build
or exit 1
nubx wrangler dev --local --port 8787 --compatibility-date 2026-09-07 --local-protocol https --https-key-path .secrets/local-key.pem --https-cert-path .secrets/local-cert.pem --var PUBLIC_ORIGIN:https://localhost:8787
