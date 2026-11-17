"""Check tracked files (or source tree before git init) for accidental private data."""
from pathlib import Path
import re
import subprocess

root=Path(__file__).resolve().parents[1]
try:
    files=[root/p for p in subprocess.check_output(['git','ls-files'],cwd=root).decode().splitlines()]
except subprocess.CalledProcessError:
    files=[p for p in root.rglob('*') if p.is_file() and not any(x in p.parts for x in ['.git','.build','__pycache__'])]
patterns=[r'gh[pousr]_[A-Za-z0-9_]{25,}',r'github_pat_[A-Za-z0-9_]{20,}',r'sk-(?:proj-)?[A-Za-z0-9_-]{25,}',
          r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----',r'\b192\.168\.\d+\.\d+\b',r'\b60\.205\.222\.30\b',
          r'/vol2/1000/',r'[CE]:[/\\](?:Users[/\\]goverd|krkr2build|gamehub)']
blocked={'.xp3','.7z','.rar','.sav','.db','.sqlite','.wasm','.dll','.exe','.raw','.log','.mp4','.wmv','.amv'}
errors=[]
for p in files:
    if not p.is_file(): continue
    name=p.relative_to(root).as_posix()
    if p.suffix.lower() in blocked: errors.append(name+': excluded file type')
    if p.stat().st_size>5*1024*1024: errors.append(name+': unexpectedly large file')
    if name=='tools/check_public_source.py': continue
    data=p.read_bytes()
    try: text=data.decode('utf16' if data.startswith(b'\xff\xfe') else 'utf8')
    except UnicodeError: continue
    for pattern in patterns:
        if re.search(pattern,text): errors.append(name+': private-data pattern matched')
if errors: raise SystemExit('\n'.join(errors))
print('PUBLIC_SOURCE_CHECK_PASSED',len(files),'files')
