#!/usr/bin/env bash
# Cosmossian 24/7 YouTube loops: one-time setup on a fresh Ubuntu 24.04 server. Run as root:  bash setup.sh
set -euo pipefail

apt-get update -q
apt-get install -y -q ffmpeg

id cosmo >/dev/null 2>&1 || useradd --system --home-dir /srv/cosmossian --create-home --shell /usr/sbin/nologin cosmo
install -d -o cosmo -g cosmo /srv/cosmossian/videos

# stream keys: kept in a file only root and the stream service can read
if [ ! -f /etc/cosmossian-stream.env ]; then
  cat > /etc/cosmossian-stream.env <<'KEYS'
# Paste your two YouTube stream keys after the = signs (YouTube Studio > Go live > Stream > Stream key).
KEY_TV=
KEY_COCKPIT=
KEYS
fi
chown root:cosmo /etc/cosmossian-stream.env
chmod 640 /etc/cosmossian-stream.env

# prepare a recording once: YouTube-friendly H.264 with a keyframe every 2 s and an audio track, so it can be looped without re-encoding
cat > /usr/local/bin/cosmossian-prepare <<'PREP'
#!/usr/bin/env bash
# usage: cosmossian-prepare <recording> <tv|cockpit>
set -euo pipefail
in="$1"; name="$2"; out="/srv/cosmossian/videos/$name.mp4"; tmp="$out.part.mp4"
has_audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$in" | head -n1)
if [ -n "$has_audio" ]; then audio=(-map 0:v:0 -map 0:a:0); else audio=(-f lavfi -i anullsrc=r=48000:cl=stereo -map 0:v:0 -map 1:a:0 -shortest); fi
ffmpeg -hide_banner -y -i "$in" "${audio[@]}" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
  -c:v libx264 -preset veryfast -profile:v high -b:v 8M -maxrate 8M -bufsize 16M -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -movflags +faststart "$tmp"
mv "$tmp" "$out"; chown cosmo:cosmo "$out"
echo "Ready: $out  ->  now run: systemctl restart cosmossian@$name"
PREP
chmod 755 /usr/local/bin/cosmossian-prepare

# the loop itself: plays the prepared file forever, without re-encoding (almost no CPU)
cat > /usr/local/bin/cosmossian-loop <<'LOOP'
#!/usr/bin/env bash
set -euo pipefail
name="$1"; file="/srv/cosmossian/videos/$name.mp4"
case "$name" in tv) key="${KEY_TV:-}";; cockpit) key="${KEY_COCKPIT:-}";; *) echo "unknown stream $name"; exit 2;; esac
[ -n "$key" ] || { echo "No stream key for $name in /etc/cosmossian-stream.env"; sleep 60; exit 1; }
[ -f "$file" ] || { echo "Waiting for $file"; sleep 60; exit 1; }
exec ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -fflags +genpts -i "$file" \
  -map 0:v:0 -map 0:a:0 -c copy -f flv -flvflags no_duration_filesize "rtmps://a.rtmps.youtube.com:443/live2/$key"
LOOP
chmod 755 /usr/local/bin/cosmossian-loop

# one service per stream; systemd restarts it if anything drops, and starts it again after a reboot
cat > /etc/systemd/system/cosmossian@.service <<'UNIT'
[Unit]
Description=Cosmossian 24/7 YouTube loop (%i)
Wants=network-online.target
After=network-online.target

[Service]
User=cosmo
EnvironmentFile=/etc/cosmossian-stream.env
ExecStart=/usr/local/bin/cosmossian-loop %i
Restart=always
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cosmossian@tv cosmossian@cockpit

echo
echo "Done. Next:"
echo " 1. nano /etc/cosmossian-stream.env    (paste both stream keys)"
echo " 2. upload your recordings, then: cosmossian-prepare tv-recording.mkv tv   and   cosmossian-prepare cockpit-recording.mkv cockpit"
echo " 3. systemctl restart cosmossian@tv cosmossian@cockpit"
echo " Check: systemctl status cosmossian@tv    Logs: journalctl -u cosmossian@tv -f"
