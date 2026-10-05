#!/usr/bin/env python3
"""Keeps Glett's own data files fresh: rebuilds each data set when it is due, checks the result, commits, pushes and
deploys. Runs daily from cron on the developer machine; most days nothing is due and it does nothing.

  data set       builder                   due
  data/rest      tools/rest/build.py       every 30 days (NVDB rest areas)
  data/poi       tools/poi/build.mjs       every 30 days (sights, tourist routes, protected areas)
  data/tur       tools/tur/build.mjs       every 90 days (marked trails; a long build)
  data/traffic   tools/traffic/counts.py   when a new complete year is in Trafikkdata (from 15 January)

Safety:
  - only on a clean working tree on main (uncommitted work is never deployed); otherwise it waits for the next day
  - a build that fails, or whose output shrinks below 80 % of the committed size, is thrown away (the old files stay)
    and a notice goes to the portal dashboard (Temporary files), removed again by the next good run
  - deployed with tools/deploy.sh, so the order of the upload is the usual one

  tools/refresh.py            what is due
  tools/refresh.py --force rest,poi   those now
  tools/refresh.py --dry      say what is due, do nothing
"""
import datetime, json, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(os.environ.get('GLETT_TRAFFIC_DIR', '/opt/code/glett-traffic'), 'refresh-state.json')
ALERT = '/opt/code/portal/data/files/ALERT-glett-refresh.txt'
ENV = dict(os.environ, PATH=os.path.expanduser('~/.local/bin') + ':/usr/local/bin:/usr/bin:/bin')
SETS = {
    'rest': {'dir': 'data/rest', 'cmd': ['python3', 'tools/rest/build.py'], 'days': 30, 'timeout': 600},
    'poi': {'dir': 'data/poi', 'cmd': ['node', 'tools/poi/build.mjs'], 'days': 30, 'timeout': 3600},
    'tur': {'dir': 'data/tur', 'cmd': ['node', 'tools/tur/build.mjs'], 'days': 90, 'timeout': 4 * 3600},
    'traffic': {'dir': 'data/traffic', 'cmd': ['python3', 'tools/traffic/counts.py'], 'days': None, 'timeout': 3 * 3600},
}


def sh(*a, **k): return subprocess.run(a, cwd=ROOT, env=ENV, capture_output=True, text=True, **k)
def log(*a): print(datetime.datetime.now().isoformat(timespec='seconds'), *a, flush=True)


def due(name, st):
    if name == 'traffic':   # counts.py takes the last complete year; a new one from mid-January
        try: have = json.load(open(os.path.join(ROOT, 'data/traffic/counts.json')))['year']
        except Exception: return True
        return have < (datetime.date.today() - datetime.timedelta(days=15)).year - 1
    return time.time() - st.get(name, 0) > SETS[name]['days'] * 86400


def size_at_head(d):
    out = sh('git', 'ls-tree', '-r', '-l', 'HEAD', d).stdout.split('\n')
    return sum(int(l.split()[3]) for l in out if l.strip() and l.split()[3].isdigit())


def size_now(d):
    return sum(os.path.getsize(os.path.join(a, f)) for a, _, fs in os.walk(os.path.join(ROOT, d)) for f in fs)


def discard(d):
    sh('git', 'checkout', '--', d); sh('git', 'clean', '-fdq', '--', d)


def main():
    st = json.load(open(STATE)) if os.path.exists(STATE) else {}
    force = sys.argv[sys.argv.index('--force') + 1].split(',') if '--force' in sys.argv else []
    todo = [n for n in SETS if n in force or (not force and due(n, st))]
    if '--dry' in sys.argv or not todo: log('due:', todo or 'nothing'); return
    if sh('git', 'rev-parse', '--abbrev-ref', 'HEAD').stdout.strip() != 'main' or sh('git', 'status', '--porcelain').stdout.strip():
        log('waiting: the working tree is not a clean main;', todo, 'stay due'); return
    done, bad = [], []
    for n in todo:
        s = SETS[n]; log('build', n)
        try: r = sh(*s['cmd'], timeout=s['timeout']); ok, why = r.returncode == 0, (r.stderr or r.stdout)[-600:]
        except subprocess.TimeoutExpired: ok, why = False, 'timed out'
        old, new = size_at_head(s['dir']), size_now(s['dir'])
        if ok and old and new < 0.8 * old: ok, why = False, f'output shrank from {old} to {new} bytes'
        if not ok: discard(s['dir']); bad.append(f'{n}: {why.strip()}'); log('FAILED', n, why.strip()); continue
        st[n] = time.time(); log('ok', n, f'{old} -> {new} bytes')
        if sh('git', 'status', '--porcelain', '--', s['dir']).stdout.strip(): done.append(n)
    json.dump(st, open(STATE, 'w'))
    if done:
        sh('git', 'add', '--', *[SETS[n]['dir'] for n in done])
        sh('git', 'commit', '-qm', f"Data refresh: {', '.join(done)}\n\nBuilt by tools/refresh.py.")
        r = sh('sh', 'tools/deploy.sh'); log('deploy', r.returncode, r.stdout.strip()[-200:])
        if r.returncode: bad.append('deploy: ' + (r.stderr or r.stdout)[-400:])
        p = sh('git', 'push', '-q', 'fork', 'main'); log('push', p.returncode)
    else: log('no changes')
    try:
        if bad: open(ALERT, 'w').write('Glett data refresh: ' + '\n'.join(bad) + f'\nLog: {os.path.dirname(STATE)}/refresh.log\n')
        elif os.path.exists(ALERT): os.remove(ALERT)
    except OSError: pass


if __name__ == '__main__':
    main()
