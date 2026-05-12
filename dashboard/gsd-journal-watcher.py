#!/usr/bin/env python3
"""
gsd-journal-watcher.py — tails the GSD journal and publishes events to Redis pubsub.

Usage:
  python3 gsd-journal-watcher.py <gsd_path> <redis_host> <redis_port> <channel>

Runs as a persistent background process. Publishes JSON payloads to the given
Redis channel for every new journal line. Handles log rotation (new daily file).
"""
import sys, os, json, time, glob, socket

def redis_publish(host, port, channel, payload):
    """Minimal Redis PUBLISH using raw socket — no redis-py dependency needed."""
    try:
        s = socket.create_connection((host, int(port)), timeout=3)
        msg = payload.encode('utf-8')
        ch  = channel.encode('utf-8')
        cmd = (
            f'*3\r\n$7\r\nPUBLISH\r\n'
            f'${len(ch)}\r\n{channel}\r\n'
            f'${len(msg)}\r\n'
        ).encode('utf-8') + msg + b'\r\n'
        s.sendall(cmd)
        s.recv(64)  # read the integer reply
        s.close()
        return True
    except Exception as e:
        return False

def tail_journal(gsd_path, redis_host, redis_port, channel):
    print(f'[watcher] gsd={gsd_path} redis={redis_host}:{redis_port} channel={channel}', flush=True)

    current_file = None
    current_pos  = 0

    while True:
        # Find the latest journal file (may rotate daily)
        journals = sorted(glob.glob(os.path.join(gsd_path, 'journal', '*.jsonl')))
        if not journals:
            time.sleep(2)
            continue

        latest = journals[-1]

        # If the file changed (new day), seek to end of new file
        if latest != current_file:
            print(f'[watcher] watching {os.path.basename(latest)}', flush=True)
            current_file = latest
            current_pos  = os.path.getsize(latest)  # start from end, don't replay history

        try:
            with open(current_file, 'r') as f:
                f.seek(current_pos)
                while True:
                    line = f.readline()
                    if not line:
                        # No new data — sleep and check for rotation
                        time.sleep(0.5)
                        # Check if a newer journal file appeared
                        new_journals = sorted(glob.glob(os.path.join(gsd_path, 'journal', '*.jsonl')))
                        if new_journals and new_journals[-1] != current_file:
                            break  # outer loop will pick up new file
                        current_pos = f.tell()
                        continue

                    line = line.strip()
                    if not line:
                        continue

                    current_pos = f.tell()

                    try:
                        event = json.loads(line)
                    except Exception:
                        continue

                    # Only publish meaningful events
                    et = event.get('eventType', '')
                    if et not in ('unit-start', 'unit-end', 'iteration-start',
                                  'dispatch-match', 'auto-exit', 'terminal'):
                        continue

                    payload = json.dumps({
                        'ts':        event.get('ts'),
                        'eventType': et,
                        'unitId':    event.get('data', {}).get('unitId'),
                        'unitType':  event.get('data', {}).get('unitType'),
                        'status':    event.get('data', {}).get('status'),
                        'errorContext': event.get('data', {}).get('errorContext'),
                    })

                    ok = redis_publish(redis_host, redis_port, channel, payload)
                    print(f'[watcher] {et} {event.get("data",{}).get("unitId","")} → redis {"ok" if ok else "FAIL"}', flush=True)

        except (IOError, OSError) as e:
            print(f'[watcher] file error: {e}', flush=True)
            time.sleep(2)

if __name__ == '__main__':
    if len(sys.argv) < 5:
        print('Usage: gsd-journal-watcher.py <gsd_path> <redis_host> <redis_port> <channel>')
        sys.exit(1)
    tail_journal(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
