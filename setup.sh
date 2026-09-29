#!/usr/bin/env bash
# Usage:  bash setup.sh            (auto-detects the VM's LAN IP)
#         bash setup.sh 192.168.1.150
set -euo pipefail
cd "$(dirname "$0")"

IP="${1:-}"
if [ -z "$IP" ]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
fi
if [ -z "$IP" ]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [ -z "$IP" ]; then
  echo "Could not detect the VM IP. Run: bash setup.sh <VM_LAN_IP>"; exit 1
fi
echo "==> Using VM IP: $IP"

# ---- Docker checks ----
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. On Ubuntu:"
  echo "  sudo apt update && sudo apt install -y docker.io docker-compose-v2"
  exit 1
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi
if ! $DOCKER compose version >/dev/null 2>&1; then
  echo "The 'docker compose' plugin is missing:  sudo apt install -y docker-compose-v2"; exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "Install openssl: sudo apt install -y openssl"; exit 1; }

# ---- MediaMTX config (advertise the VM's LAN IP to WebRTC clients) ----
cat > mediamtx.yml <<YML
logLevel: info

rtsp: yes
rtmp: no
srt: no
hls: yes
hlsAddress: :8888

webrtc: yes
webrtcAddress: :8889
webrtcEncryption: no          # HTTPS is handled by nginx
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcIPsFromInterfaces: no   # don't advertise Docker-internal 172.x addresses
webrtcAdditionalHosts: [$IP]

paths:
  all_others:                 # TEST ONLY: anyone can publish/read any path
YML

# ---- Self-signed HTTPS certificate for that IP ----
mkdir -p certs
if [ ! -f certs/server.crt ] || [ "$(cat certs/.ip 2>/dev/null || true)" != "$IP" ]; then
  echo "==> Generating self-signed certificate for $IP"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout certs/server.key -out certs/server.crt \
    -subj "/CN=$IP" \
    -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
  chmod 644 certs/server.key
  echo "$IP" > certs/.ip
fi

# ---- Optional settings for the avatar (.env is read by docker compose) ----
if [ ! -f .env ]; then
  cat > .env <<'ENV'
# Replies work with ZERO configuration below: your own keys (if set) are tried first, then three free
# keyless LLM gateways (no signup), then built-in rules - see chat/llm.js. Uncomment to use your own:
# OPENAI_BASE_URL=...        # any OpenAI-compatible endpoint, tried first if both this and the key are set
# OPENAI_API_KEY=...
# OPENAI_MODEL=...
# GROQ_API_KEY=gsk_...
# GROQ_MODEL=openai/gpt-oss-20b     # current fast Groq production model - check console.groq.com/docs/models
#                                   # before changing this: Groq retires model IDs over time (e.g. llama-3.1-8b-instant
#                                   # and llama-3.3-70b-versatile were both retired on 2026-08-16).
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-haiku-4-5-20251001
# FREE_LLM=on                # "off" disables the free keyless gateways (your keys, or rules, only)
# FREE_LLM_ORDER=llm7,ovh,kilo
# REPLY_CACHE_MS=45000       # identical/near-identical comments within this window reuse the last reply
# AVATAR_PERSONA=a friendly, witty cartoon co-host

# The baseline "reference script" the avatar recites on loop until a comment interrupts it.
# JSON array of strings; leave unset for the built-in sample pitch. Editable live from the publisher's
# "Reference script" panel too (no restart needed).
# AVATAR_SCRIPT=["Welcome to the stream!","Ask me anything about today's product."]
# AVATAR_LOOP=on             # "off" disables the idle loop entirely (avatar stays silent between comments)
# AVATAR_IDLE_MS=1100        # pause, in ms, before the loop resumes after a reply finishes
# AVATAR_AR_DIALECT=egy      # or "msa" - which Arabic pronunciation table the lip-sync uses

# Voice: free Edge neural TTS by default (real Arabic voices, no key) - also choosable live from the
# publisher's "Voice" panel. Falls back to the offline espeak-ng voice automatically if Edge fails.
# TTS_ENGINE=edge            # "espeak" to force the old offline-only voice
# TTS_VOICE_EN_EDGE=en-US-AriaNeural      # en-US-GuyNeural, en-GB-SoniaNeural, ...
# TTS_VOICE_AR_EDGE=ar-EG-SalmaNeural     # ar-EG-ShakirNeural, ar-SA-ZariyahNeural, ar-SA-HamedNeural, ...
# TTS_EDGE_RATE=0            # percent, -50..+50
# TTS_EDGE_PITCH=0           # Hz, -50..+50

# espeak-ng fallback voice. Higher pitch and a slightly slower speed sound friendlier;
# the amplitude and the word gap make the reply easier to hear over the microphone.
# TTS_VOICE_EN=en-us+f3      # try +f2 / +f4 / +m3 for other characters
# TTS_VOICE_AR=ar+f3
# TTS_SPEED=138              # words per minute
# TTS_PITCH=72               # 0-99
# TTS_AMP=190                # 0-200
# TTS_GAP=4                  # pause between words, in 10 ms units
ENV
fi

# ---- Start ----
echo "==> Building and starting containers (first build downloads a few hundred MB)"
$DOCKER compose up -d --build

cat <<MSG

======================================================================
  Server is up.

  On your PHONE (same Wi-Fi):   https://$IP:8443/publish.html
  On the VM or any PC:          https://$IP:8443/view.html
  Type a comment on either page: the avatar answers out loud and instantly stops whatever it was
  saying (it recites a reference script on loop while idle - edit it live from the publisher page).
  (Fast AI replies: put GROQ_API_KEY=... in .env, then: $DOCKER compose up -d)

  The browser will warn about the certificate (it is self-signed).
  Choose "Advanced" -> "Proceed" (iOS: "Show Details" -> "visit this website").
  Do this on BOTH pages, once each.

  Logs:   $DOCKER compose logs -f
  Stop:   $DOCKER compose down

  If nothing connects and ufw is enabled on the VM:
    sudo ufw allow 8443/tcp && sudo ufw allow 8189/udp && sudo ufw allow 8189/tcp
======================================================================
MSG
