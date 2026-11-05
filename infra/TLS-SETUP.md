# Foresight — LiveKit over TLS (wss://)

Replace `example.com` with your own domain here, in `infra/nginx-livekit.conf`
and in `infra/Caddyfile`. `192.168.1.20` stands for your LiveKit host's address.

A browser on an HTTPS page refuses to open a `ws://` socket (mixed content), so
the LiveKit signaling WebSocket must be served over `wss://`.

If the LiveKit host isn't reachable from the internet, the simplest path is to
terminate TLS on an **existing nginx reverse proxy** — the public front door for
`foresight.example.com` — and have it reverse-proxy `livekit.example.com` to
LiveKit across your private network. If the proxy already reaches the backend on
:3199 and already has a working cert mechanism, there's **no new cert flow** to
figure out.

Only **signaling** rides the proxy. WebRTC **media** stays direct: browser ⇄
LiveKit host over UDP 50000–50100 / TCP 7881 (already DTLS-encrypted), so the
viewer must be able to reach those ports directly.

> **Before exposing anything:** make sure the LiveKit API key/secret in
> `infra/livekit.yaml` (and both `.env` files) were generated with
> `openssl rand -hex 32` — never the template or `devkey`/`secret`. The shipped
> proxy configs forward only the signaling socket (`/rtc…`) and the health check;
> LiveKit's server API (`/twirp/…`) stays private. If an older key ever faced
> the internet, rotate it.

## On the proxy host

```bash
# 1. DNS: make livekit.example.com resolve to the proxy, the same way
#    foresight.example.com does (public or split-horizon DNS).

# 2. Get the cert FIRST (before installing the :443 block, which references it).
#    Use the SAME method you used for foresight.example.com. If that was certbot's
#    nginx plugin:
sudo certbot certonly --nginx -d livekit.example.com
#    (If you cert via DNS-01 because the proxy isn't public, use that here instead.)

# 3. Install the proxy site (config ships in this repo):
sudo cp infra/nginx-livekit.conf /etc/nginx/sites-available/livekit.example.com
sudo ln -s /etc/nginx/sites-available/livekit.example.com /etc/nginx/sites-enabled/

# 4. Test and reload:
sudo nginx -t && sudo systemctl reload nginx
```

`infra/nginx-livekit.conf` proxies `livekit.example.com` → `192.168.1.20:7880`
with the WebSocket upgrade headers and long timeouts, and coexists with your
`foresight.example.com` site (nginx routes by `server_name`, so both live on
:443).

## On the LiveKit host — point the backend at the secure URL

In `foresight-server/.env`:
```
LIVEKIT_PUBLIC_URL=wss://livekit.example.com      # was ws://192.168.1.20:7880
```
Restart the backend. No code change — the server already prefers
`LIVEKIT_PUBLIC_URL` (confirmed in the compiled `dist/config.js`).

For full TLS including iPhone pairing tickets, sign in as the server admin and
set Settings → General → *Pairing server URL* to `https://foresight.example.com`
(or set `PUBLIC_SERVER_URL` as the last-resort fallback). With the backend
behind a reverse proxy, also set `TRUST_PROXY=true` in `foresight-server/.env`
so rate limits see real client addresses.

## Verify
```
curl -i https://livekit.example.com/        # expect valid TLS + LiveKit "OK"
```
Reload the camera page; DevTools → Network → WS should show
`wss://livekit.example.com/rtc...` staying open, and video should appear.

If signaling connects but video never starts, LiveKit isn't advertising an ICE
candidate the viewer can reach — set its node IP to an address the viewer can
reach (`rtc.node_ip` in `infra/livekit.yaml`) and restart LiveKit.

## Alternative — proxy on the LiveKit box itself (Caddy)
If you'd rather terminate TLS on the LiveKit host, run `infra/Caddyfile` there.
If that box has no inbound ports, it needs a DNS-01 cert (see the commented block
in the Caddyfile).
