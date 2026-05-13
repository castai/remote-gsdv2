/**
 * reader.js — pulls live GSD state from a remote pod or local path.
 *
 * Transport:
 *   pod mode  → kubectl exec <pod> -n <namespace> -- python3 -c '<PYTHON_SCRIPT>'
 *   local mode → python3 -c '<PYTHON_SCRIPT>'  (with GSD_PATH env var)
 *
 * In both cases the Python script reads plain files from .gsd/ and emits
 * a single JSON object on stdout. No DB access, no GSD tool calls.
 *
 * Usage (module):
 *   import { readInstance } from './reader.js'
 *   const state = await readInstance({ name, pod, namespace, gsdPath, localPath })
 *
 * Usage (CLI):
 *   node reader.js <instance-name>
 *   node reader.js <instance-name> --pretty
 */

import { execFile } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

// ─── Inline Python script ────────────────────────────────────────────────────
// Backticks inside the script are fine since we use a tagged template.
// Single-quotes inside Python are fine since we pass via argv, not shell.

export const PYTHON_SCRIPT = `
import json, os, sys, glob, re

GSD = os.environ.get('GSD_PATH', '')
if not GSD:
    print(json.dumps({'error': 'GSD_PATH not set'}))
    sys.exit(0)

result = {
    'gsdPath': GSD,
    'exportedAt': None,
    'milestones': [],
    'slices': [],
    'tasks': [],
    'quickTasks': [],
    'pausedSession': None,
    'stuckState': None,
    'unreadNotificationCount': 0,
    'recentNotifications': [],
    'recentJournalEvents': [],
    'errors': []
}

# state-manifest.json
try:
    manifest = json.load(open(GSD + '/state-manifest.json'))
    result['exportedAt'] = manifest.get('exported_at')
    result['milestones'] = manifest.get('milestones', [])
    result['slices']     = manifest.get('slices', [])
    result['tasks']      = manifest.get('tasks', [])
except Exception as e:
    result['errors'].append({'source': 'state-manifest', 'error': str(e)})

# runtime/paused-session.json
# Cross-check against auto.lock: if auto-mode has restarted after the pause,
# the paused-session file is stale and must be ignored.  Without this guard a
# pod restart (or manual /gsd auto) leaves a stale file that permanently shows
# the milestone as Blocked even though execution is running fine.
try:
    ps_path   = GSD + '/runtime/paused-session.json'
    lock_path = GSD + '/auto.lock'
    if os.path.exists(ps_path):
        ps = json.load(open(ps_path))
        # If auto.lock exists and started AFTER the pause, the session is stale.
        stale = False
        if os.path.exists(lock_path):
            try:
                lock = json.load(open(lock_path))
                paused_at  = ps.get('pausedAt', '')
                started_at = lock.get('startedAt', '')
                if started_at and paused_at and started_at > paused_at:
                    stale = True
            except Exception:
                pass  # unreadable lock — don't suppress the paused session
        if not stale:
            result['pausedSession'] = ps
except Exception as e:
    result['errors'].append({'source': 'paused-session', 'error': str(e)})

# runtime/stuck-state.json
try:
    ss_path = GSD + '/runtime/stuck-state.json'
    if os.path.exists(ss_path):
        result['stuckState'] = json.load(open(ss_path))
except Exception as e:
    result['errors'].append({'source': 'stuck-state', 'error': str(e)})

# notifications.jsonl
try:
    notif_path = GSD + '/notifications.jsonl'
    if os.path.exists(notif_path):
        notifs = []
        for l in open(notif_path).readlines():
            l = l.strip()
            if l:
                try: notifs.append(json.loads(l))
                except: pass
        unread = [n for n in notifs if not n.get('read')]
        result['unreadNotificationCount'] = len(unread)
        result['recentNotifications'] = list(reversed(unread[-3:]))
except Exception as e:
    result['errors'].append({'source': 'notifications', 'error': str(e)})

# journal last 10 events
try:
    journals = sorted(glob.glob(GSD + '/journal/*.jsonl'))
    if journals:
        events = []
        for l in reversed(open(journals[-1]).readlines()):
            l = l.strip()
            if not l: continue
            try:
                e = json.loads(l)
                ec = (e.get('data') or {}).get('errorContext') or {}
                events.append({
                    'ts':           e.get('ts'),
                    'eventType':    e.get('eventType'),
                    'unitId':       e.get('data', {}).get('unitId'),
                    'unitType':     e.get('data', {}).get('unitType'),
                    'rule':         e.get('data', {}).get('rule'),
                    'status':       e.get('data', {}).get('status'),
                    'iteration':    e.get('data', {}).get('iteration'),
                    'error':        ec.get('message'),
                    'errorCategory': ec.get('category'),
                    'isTransient':  ec.get('isTransient'),
                })
                if len(events) >= 50: break
            except: pass
        result['recentJournalEvents'] = list(reversed(events))
        # Surface the most recent error event at the top level for easy derive access
        for ev in reversed(events):
            if ev.get('error'):
                result['lastError'] = {
                    'unitId':    ev['unitId'],
                    'ts':        ev['ts'],
                    'message':   ev['error'],
                    'category':  ev.get('errorCategory'),
                    'isTransient': ev.get('isTransient'),
                    'status':    ev.get('status'),
                }
                break
except Exception as e:
    result['errors'].append({'source': 'journal', 'error': str(e)})

# Active session detection — scan ~/.gsd/sessions/<project>/ for recently modified files.
# This detects interactive (non-auto-mode) sessions that don't write to the journal.
try:
    import time as _time
    sessions_base = os.path.expanduser('~/.gsd/sessions/')
    sessions_dir = None
    if os.path.exists(sessions_base):
        # GSD slugifies the base path: /home/gsd/workspace/foo/.gsd → --home-gsd-workspace-foo--
        # Build the expected slug from GSD path (strip /.gsd, replace / with -)
        base_path = GSD.rstrip('/').removesuffix('/.gsd').removesuffix('.gsd')
        expected_slug = base_path.replace('/', '-')  # e.g. -home-gsd-workspace-salesanalyzer-
        for d in os.listdir(sessions_base):
            # Match: strip leading/trailing dashes from both for comparison
            if d.strip('-') == expected_slug.strip('-'):
                sessions_dir = os.path.join(sessions_base, d)
                break
    if sessions_dir and os.path.exists(sessions_dir):
        now = _time.time()
        recent_thresh = 5 * 60  # 5 minutes
        most_recent_mtime = 0
        for f in os.listdir(sessions_dir):
            fp = os.path.join(sessions_dir, f)
            if os.path.isfile(fp):
                mt = os.path.getmtime(fp)
                if mt > most_recent_mtime:
                    most_recent_mtime = mt
        if most_recent_mtime > 0:
            age_seconds = now - most_recent_mtime
            result['activeSessionAgeSecs'] = round(age_seconds)
            result['hasActiveSession'] = age_seconds < recent_thresh
except Exception as e:
    result['errors'].append({'source': 'active-session', 'error': str(e)})

# Auto-mode running detection — last journal unit-start has no subsequent unit-end
# and is recent (within 30 minutes) to avoid stale open units from test events etc.
try:
    result['autoModeRunning'] = False
    result['autoModeUnit'] = None
    journals = sorted(glob.glob(GSD + '/journal/*.jsonl'))
    if journals:
        all_lines = []
        for jf in journals[-2:]:
            all_lines.extend([l.strip() for l in open(jf).readlines() if l.strip()])
        events = []
        for l in all_lines:
            try: events.append(json.loads(l))
            except: pass
        last_start = next((e for e in reversed(events) if e.get('eventType') == 'unit-start'), None)
        last_end   = next((e for e in reversed(events) if e.get('eventType') == 'unit-end'), None)
        if last_start:
            ts_start = last_start.get('ts', '')
            ts_end   = last_end.get('ts', '') if last_end else ''
            # Only count as running if unit-start is newer than unit-end
            # AND the unit-start is within the last 30 minutes (staleness guard)
            if ts_start > ts_end:
                import datetime as _dt
                try:
                    start_dt = _dt.datetime.fromisoformat(ts_start.replace('Z', '+00:00'))
                    now_dt   = _dt.datetime.now(_dt.timezone.utc)
                    age_mins = (now_dt - start_dt).total_seconds() / 60
                    if age_mins <= 30:
                        result['autoModeRunning'] = True
                        result['autoModeUnit'] = last_start.get('data', {}).get('unitId')
                except Exception:
                    pass  # date parse error — don't mark as running
except Exception as e:
    result['errors'].append({'source': 'auto-mode-detect', 'error': str(e)})

# quick/ tasks — parse SUMMARY.md files from each numbered subdir
try:
    quick_dir = GSD + '/quick'
    quick_tasks = []
    if os.path.exists(quick_dir):
        for summary_path in glob.glob(quick_dir + '/*/'):
            subdir = os.path.basename(summary_path.rstrip('/'))
            m = re.match(r'^(\\d+)-(.+)', subdir)
            if not m: continue
            num  = int(m.group(1))
            slug = m.group(2)
            md_path = os.path.join(quick_dir, subdir, str(num) + '-SUMMARY.md')
            # Surface the task as soon as its directory exists, even before the summary is written.
            # Fields are populated from the summary when available; slug-derived title is the fallback.
            title   = slug.replace('-', ' ')
            date    = None
            branch  = None
            summary = ''
            done    = False
            if os.path.exists(md_path):
                try:
                    content = open(md_path).read()
                    title_m  = re.search(r'^#\\s+Quick Task:\\s*(.+)', content, re.MULTILINE)
                    title    = title_m.group(1).strip() if title_m else title
                    date_m   = re.search(r'\\*\\*Date:\\*\\*\\s*(\\S+)', content)
                    date     = date_m.group(1) if date_m else None
                    branch_m = re.search(r'\\*\\*Branch:\\*\\*\\s*(\\S+)', content)
                    branch   = branch_m.group(1) if branch_m else None
                    wc_m     = re.search(r'## What Changed\\s*\\n+(.+?)(?:\\n\\n|\\n##|$)', content, re.DOTALL)
                    summary  = wc_m.group(1).strip()[:200] if wc_m else ''
                    done     = True
                except: pass
            quick_tasks.append({
                'id':      num,
                'title':   title,
                'date':    date,
                'branch':  branch,
                'summary': summary,
                'slug':    slug,
                'done':    done
            })
    quick_tasks.sort(key=lambda t: (t['date'] or ''), reverse=True)
    result['quickTasks'] = quick_tasks
except Exception as e:
    result['errors'].append({'source': 'quick-tasks', 'error': str(e)})

print(json.dumps(result))
`

// ─── Reader ──────────────────────────────────────────────────────────────────

/**
 * Read state from one GSD instance.
 * @param {object} config - { name, pod?, namespace?, gsdPath?, localPath? }
 * @returns {Promise<object>} Normalised state payload, or { error, stale:true }
 */
export async function readInstance(config) {
  const { name, pod, namespace = 'lk-gsd', gsdPath, localPath, container = 'gsd' } = config
  const start = Date.now()

  let cmd, args, env

  if (pod) {
    const resolvedGsdPath = gsdPath || ''
    cmd  = 'kubectl'
    args = [
      'exec', pod, '-n', namespace, '-c', container, '--',
      'env', `GSD_PATH=${resolvedGsdPath}`,
      'python3', '-c', PYTHON_SCRIPT
    ]
    env = process.env
  } else if (localPath) {
    cmd  = 'python3'
    args = ['-c', PYTHON_SCRIPT]
    env  = { ...process.env, GSD_PATH: localPath }
  } else {
    return { name, error: 'config must have pod or localPath', stale: true }
  }

  return new Promise((resolve) => {
    execFile(cmd, args, { env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const elapsed = Date.now() - start
      const bytes   = stdout?.length ?? 0

      if (process.env.DEBUG) {
        process.stderr.write(`[reader] ${name} exit=${err?.code ?? 0} bytes=${bytes} ms=${elapsed}\n`)
        if (stderr?.trim()) process.stderr.write(`[reader] ${name} stderr: ${stderr.trim()}\n`)
      }

      if (err || !stdout?.trim()) {
        resolve({ name, error: err?.message ?? 'empty stdout', stale: true, elapsedMs: elapsed })
        return
      }

      try {
        const data = JSON.parse(stdout)
        resolve({ name, ...data, elapsedMs: elapsed, stale: false })
      } catch (parseErr) {
        resolve({
          name,
          error: `JSON parse failed: ${parseErr.message}`,
          raw: stdout.slice(0, 500),
          stale: true,
          elapsedMs: elapsed
        })
      }
    })
  })
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const instanceName = process.argv[2]
  const pretty       = process.argv.includes('--pretty')

  if (!instanceName) {
    console.error('Usage: node reader.js <instance-name> [--pretty]')
    process.exit(1)
  }

  const instancesPath = resolve(__dir, 'instances.json')
  if (!existsSync(instancesPath)) {
    console.error(`instances.json not found at ${instancesPath}`)
    process.exit(1)
  }

  const instances = JSON.parse(readFileSync(instancesPath, 'utf8'))
  const config    = instances.find(i => i.name === instanceName)

  if (!config) {
    console.error(`Instance "${instanceName}" not found in instances.json`)
    console.error('Available:', instances.map(i => i.name).join(', '))
    process.exit(1)
  }

  process.env.DEBUG = '1'
  readInstance(config).then(state => {
    console.log(pretty ? JSON.stringify(state, null, 2) : JSON.stringify(state))
  })
}
