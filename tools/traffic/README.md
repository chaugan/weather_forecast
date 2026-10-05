# Traffic: rush hours from Statens vegvesen (NLOD)

Two open sources, both from Statens vegvesen:

1. **Travel times (DATEX `GetTravelTimeData`)**: minutes of delay per stretch, 202 stretches around Oslo, Bergen,
   Trondheim, Stavanger, Kristiansand and the E18/E6 corridors, every 5 minutes. Live only, so `record.py` stores
   every period. Runs from cron on the dev server; data in `/opt/code/glett-traffic/traffic.db` (outside the repo).
   Credentials: `~/.config/glett/datex.json` (the site's DATEX account, mode 600, never in the repo).
   `backup.py` copies the database nightly to the web host (`~/glett-traffic-backup/`, outside the web root).
   If no new period arrives for 30 minutes, `ALERT-glett-traffic.txt` appears under the portal's Temporary files.
2. **Traffic counts (Trafikkdata API)**: years of hourly vehicle counts per counting point and direction, no login.
   `counts.py` builds the typical weekday hour profile per point and direction into `data/traffic/counts.json`.
   Counts show when a road is in demand; they are not speeds (in a queue the count falls), so they mark rush hours,
   while the recorded travel times give minutes.

Cron (user `chrzz`):

    */5 * * * * /usr/bin/python3 /opt/code/glett/tools/traffic/record.py >> /opt/code/glett-traffic/record.log 2>&1
    17 3 * * *  /usr/bin/python3 /opt/code/glett/tools/traffic/backup.py >> /opt/code/glett-traffic/backup.log 2>&1

Health: `python3 tools/traffic/record.py --status`.
