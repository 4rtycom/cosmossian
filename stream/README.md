# Cosmossian 24/7 YouTube streams

Two endless live streams, each one a long recording played on a loop by a small server:

- **TV**: `https://cosmossian.com/?stream=tv`
- **Cockpit**: `https://cosmossian.com/?stream=cockpit`

## 1. Record the two loops (on your own computer, once)

1. Install OBS Studio (free, obsproject.com).
2. **Settings → Video**: Base and Output resolution 1920×1080, 30 FPS.
3. **Settings → Output → Recording**: format MKV (switch to MP4 afterwards with *File → Remux Recordings*, or upload the MKV as it is), quality *High*.
4. Scene "TV": add a **Browser** source with URL `https://cosmossian.com/?stream=tv`, width 1920, height 1080. Turn on *Control audio via OBS* if you want the site's sound.
5. Open the link once in a normal browser on the same computer first, so the "are you human" check is passed.
6. Press **Start Recording** and let it run 1–2 hours. Stop.
7. Do the same with a scene "Cockpit" and `?stream=cockpit`.

Tip: start the recording a minute after the page has loaded, so the loop does not begin on the loading screen.

## 2. Rent a small server

Any provider works. Example: Hetzner Cloud, the smallest shared-CPU plan with **Ubuntu 24.04**.
Two 1080p streams send about 4–6 TB per month: pick a plan whose included traffic covers that.

## 3. Set it up (about 5 minutes)

From your computer:

```bash
scp setup.sh root@YOUR_SERVER_IP:
ssh root@YOUR_SERVER_IP 'bash setup.sh'
```

## 4. YouTube

In YouTube Studio → **Go live → Stream**, for each stream:

- **Stream key**: create a new, reusable key (one for TV, one for Cockpit).
- Turn **Auto-start ON** and **Auto-stop OFF**, so the broadcast keeps going.
- Set title, description (link to cosmossian.com), thumbnail and category *Science & Technology*.

Put the keys on the server (never share them):

```bash
ssh root@YOUR_SERVER_IP
nano /etc/cosmossian-stream.env      # KEY_TV=...  KEY_COCKPIT=...
```

## 5. Upload and start

```bash
scp tv-recording.mkv cockpit-recording.mkv root@YOUR_SERVER_IP:/srv/cosmossian/
ssh root@YOUR_SERVER_IP
cosmossian-prepare /srv/cosmossian/tv-recording.mkv tv
cosmossian-prepare /srv/cosmossian/cockpit-recording.mkv cockpit
systemctl restart cosmossian@tv cosmossian@cockpit
```

`cosmossian-prepare` converts each recording once (this can take an hour on a small server). After that the loop plays without
re-encoding, so the server is nearly idle.

## Day to day

- Status: `systemctl status cosmossian@tv` (or `@cockpit`)
- Live log: `journalctl -u cosmossian@tv -f`
- New recording: upload it, run `cosmossian-prepare`, then `systemctl restart cosmossian@tv`.
- If anything drops, the service restarts itself after 5 seconds, and both streams start again after a server reboot.

## 4K (ultra HD)

- Record in OBS at 3840×2160, 30 fps, with the 4K links: `?stream=ambient&at=saturn&loop=10` (4K by default) or `?stream=tv&uhd=1` / `?stream=cockpit&uhd=1`.
- Prepare with `4k` at the end: `cosmossian-prepare /srv/cosmossian/tv-recording.mkv tv 4k` (20 Mbit/s).
- In YouTube Studio the stream key must allow 2160p: create the key with resolution "Variable" or 2160p.
- Traffic: one 4K stream at 20 Mbit/s sends about 6.5 TB per month; two send about 13 TB. Pick a server plan that includes that.
- Converting a 4K recording on a small server is slow (several hours per hour of video); it only has to be done once.
