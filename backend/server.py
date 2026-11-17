#!/usr/bin/env python3
"""NAS library administration. Stdlib only; private SQLite state lives outside web root."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import hmac
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import threading
import time
from urllib.parse import parse_qs, quote, unquote, urlsplit
import zipfile

from engines import ADAPTERS
from media import prepare as prepare_media


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(4))
    try:
        with temporary.open('w', encoding='utf8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class App:
    def __init__(self, site, state, config):
        self.site, self.state, self.config = Path(site).resolve(), Path(state).resolve(), config
        self.roots = [Path(p).resolve() for p in config['roots']]
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.sessions, self.attempts, self.probes = {}, {}, {}
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.database = self.state / 'library.sqlite3'
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
            for row in db.execute('SELECT id, body FROM imports').fetchall():
                job = json.loads(row[1])
                if job['status'] == 'probing':
                    job.update(status='ready', message='服务重启中断了浏览器检查，请重新试运行')
                    self.save(job, db)
                elif job['status'] in ('queued', 'scanning'):
                    job.update(status='interrupted', message='服务重启中断了任务，请重新扫描或重新试运行')
                    self.save(job, db)
        auth = self.state / 'auth.json'
        if not auth.exists():
            password = secrets.token_urlsafe(18)
            self.set_password(password)
            password_file = self.state / 'admin-password.txt'
            password_file.write_text(password + '\n', encoding='utf8')
            os.chmod(password_file, 0o600)
        self.auth = json.loads(auth.read_text())

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.database, timeout=15)
        db.execute('PRAGMA journal_mode=WAL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def set_password(self, password):
        if not isinstance(password, str) or not 12 <= len(password) <= 200:
            raise Problem('管理员密码需为 12–200 个字符')
        salt = secrets.token_hex(16)
        self.auth = {'salt': salt, 'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 240000).hex()}
        atomic_json(self.state / 'auth.json', self.auth)
        os.chmod(self.state / 'auth.json', 0o600)
        self.sessions.clear()

    def save(self, job, db=None):
        job['updatedAt'] = time.time()
        if db is None:
            with self.db() as connection:
                self.save(job, connection)
        else:
            db.execute('INSERT OR REPLACE INTO imports VALUES (?, ?)', (job['id'], json.dumps(job, ensure_ascii=False)))

    def get(self, identifier):
        with self.db() as db:
            row = db.execute('SELECT body FROM imports WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise Problem('没有找到这个导入任务', 404)
        return json.loads(row[0])

    def jobs(self):
        with self.db() as db:
            return sorted((json.loads(row[0]) for row in db.execute('SELECT body FROM imports')), key=lambda j: j['createdAt'], reverse=True)[:200]

    def source(self, value):
        if not isinstance(value, str) or not value.startswith('/') or '\x00' in value:
            raise Problem('请选择 NAS 上的绝对路径')
        path = Path(value).resolve()
        if not any(path == root or root in path.parents for root in self.roots):
            raise Problem('只能访问管理员配置的游戏目录', 403)
        if not path.exists():
            raise Problem('路径不存在，请确认 NAS 已挂载且路径正确', 404)
        return path

    def browse(self, value):
        if not value:
            return {'path': '', 'parent': None, 'entries': [dict(name=p.name, path=str(p), type='directory') for p in self.roots]}
        path = self.source(value)
        if not path.is_dir():
            raise Problem('请选择文件夹')
        entries = []
        for item in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if item.name.startswith('.') or item.is_symlink():
                continue
            if item.is_dir() or item.suffix.lower() in ('.7z', '.zip'):
                entries.append(dict(name=item.name, path=str(item), type='directory' if item.is_dir() else 'archive'))
        return dict(path=str(path), parent=str(path.parent) if path not in self.roots else '', entries=entries[:500])

    def create(self, body):
        engine = body.get('engine')
        if engine not in ADAPTERS:
            raise Problem('该引擎尚未接入，目前仅支持 Krkr')
        path = self.source(body.get('path'))
        if not path.is_dir() and path.suffix.lower() not in ('.zip', '.7z'):
            raise Problem('请选择游戏文件夹或 ZIP / 7z 压缩包')
        with self.lock:
            existing = self.jobs()
            current_stats = [path.stat().st_size, path.stat().st_mtime_ns] if path.is_file() else None
            for previous in existing:
                if previous['source'] == str(path) and previous['status'] == 'published' and previous.get('sourceStats') == current_stats:
                    try:
                        self.unchanged(previous)
                        return previous
                    except Problem:
                        break
            if sum(j['status'] in ('queued', 'scanning') for j in existing) >= 3:
                raise Problem('已有 3 个扫描任务，请等待完成', 409)
            job = dict(id=secrets.token_hex(12), status='queued', message='等待扫描', engine=engine,
                       source=str(path), sourceStats=current_stats, requestedName=str(body.get('name') or '')[:160].strip(), createdAt=time.time())
            self.save(job)
            self.pool.submit(self.scan, job['id'])
        return job

    def unpack(self, path, job, progress):
        destination = self.state / 'imports' / job['id'] / 'source'
        destination.mkdir(parents=True)
        progress('正在检查压缩包路径和解压容量…')
        if path.suffix.lower() == '.zip':
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                listing = [(i.filename, i.file_size, stat.S_ISLNK(i.external_attr >> 16)) for i in members]
        else:
            result = subprocess.run(['7z', 'l', '-slt', '-ba', '-p', str(path)], capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise Problem('压缩包无法读取或需要密码；请在 NAS 上先解压')
            listing = []
            for block in result.stdout.split('\n\n'):
                fields = dict(line.split(' = ', 1) for line in block.splitlines() if ' = ' in line)
                if 'Path' in fields:
                    if fields.get('Encrypted') == '+':
                        raise Problem('压缩包已加密，请先在 NAS 上解压')
                    listing.append((fields['Path'], int(fields.get('Size', '0')), 'Symbolic Link' in fields or 'Hard Link' in fields or 'l' in fields.get('Attributes', '').lower()))
        total = 0
        for name, size, link in listing:
            parts = PurePosixPath(name.replace('\\', '/'))
            if link or parts.is_absolute() or '..' in parts.parts or ':' in name or '\x00' in name:
                raise Problem('压缩包含危险路径或链接，已拒绝解压')
            total += size
        if not listing or len(listing) > 30000 or total > 32 * 1024**3:
            raise Problem('压缩包超过当前限制：3 万文件 / 32 GB')
        if shutil.disk_usage(self.state).free < total + 1024**3:
            raise Problem('NAS 空间不足，需保留至少 1 GB 余量')
        progress('正在解压到独立导入目录，原压缩包保持不变…')
        if path.suffix.lower() == '.zip':
            with zipfile.ZipFile(path) as archive:
                archive.extractall(destination)
        else:
            result = subprocess.run(['7z', 'x', '-y', '-p', '-o' + str(destination), str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=1800)
            if result.returncode:
                raise Problem('压缩包解压失败，请在 NAS 上检查文件完整性')
        if any(p.is_symlink() for p in destination.rglob('*')):
            raise Problem('解压结果含链接，已拒绝导入')
        return destination

    def retry(self, identifier):
        with self.lock:
            job = self.get(identifier)
            if job['status'] not in ('blocked', 'interrupted', 'probe-failed', 'ready', 'checked'):
                raise Problem('当前任务不能重新扫描', 409)
            if sum(j['status'] in ('queued', 'scanning') for j in self.jobs()) >= 3:
                raise Problem('已有 3 个扫描任务，请等待完成', 409)
            job.update(status='queued', message='等待重新扫描')
            job.pop('check', None)
            self.probes.pop(identifier, None)
            self.save(job)
            self.pool.submit(self.scan, identifier)
            return job

    def scan(self, identifier):
        job = self.get(identifier)
        def progress(message):
            job.update(status='scanning', message=message)
            self.save(job)
        try:
            path = self.source(job['source'])
            if path.is_dir():
                root = path
            else:
                current_stats = [path.stat().st_size, path.stat().st_mtime_ns]
                cached = self.state / 'imports' / identifier / 'source'
                if job.get('extractedComplete') and current_stats == job.get('sourceStats') and cached.is_dir():
                    root = cached
                    progress('复用已完整解压的副本，重新校验内容…')
                else:
                    if cached.exists():
                        assert cached.resolve().parent == (self.state / 'imports' / identifier).resolve()
                        shutil.rmtree(cached)
                    root = self.unpack(path, job, progress)
                    job.update(extractedComplete=True, sourceStats=current_stats)
                    self.save(job)
            progress('识别游戏本体与引擎…')
            result = ADAPTERS[job['engine']].scan(root, self.config, progress)
            sources = result.pop('mediaSources', [])
            if sources:
                converted, converted_files = prepare_media(sources, self.state / 'imports' / identifier / 'derived', identifier, progress)
                result['media'].update(converted)
                result['files'].update(converted_files)
            required_urls = [result['runtime'], *result['compatibility'].values(), *(v['url'] for v in result['media'].values())]
            for url in required_urls:
                if url.startswith('/game-files/' + identifier + '/'):
                    continue
                asset = (self.site / url.lstrip('/')).resolve()
                if self.site not in asset.parents or not asset.is_file() or asset.stat().st_size == 0:
                    raise Problem('引擎或适配资源缺失：' + url)
            # Validate all exported paths again, including nested directory links.
            approved = root.resolve()
            derived = (self.state / 'imports' / identifier / 'derived').resolve()
            for value in result['files'].values():
                resolved = Path(value).resolve()
                if approved not in resolved.parents and derived not in resolved.parents:
                    raise Problem('游戏资源超出了选择目录')
            job.update(result=result, name=job['requestedName'] or result['name'], status='ready', message='扫描完成，等待浏览器启动检查')
            job['fileStats'] = {key: [Path(value).stat().st_size, Path(value).stat().st_mtime_ns] for key, value in result['files'].items()}
            self.write_profile(job, probe=True)
            self.save(job)
        except Exception as error:
            job.update(status='blocked', message=str(error)[:1500])
            self.save(job)

    def unchanged(self, job):
        for key, value in job['result']['files'].items():
            p = Path(value)
            if not p.is_file() or [p.stat().st_size, p.stat().st_mtime_ns] != job['fileStats'][key]:
                raise Problem('扫描后游戏资源发生变化，请重新扫描：' + key, 409)

    def write_profile(self, job, probe=False, save_id=None):
        identifier = ('probe-' if probe else 'nas-') + job['id']
        result = job['result']
        profile = dict(files={key: '/game-files/' + job['id'] + '/' + quote(key.lstrip('/')) for key in result['files']},
                       compatibility=result['compatibility'], media=result['media'],
                       saveId=save_id or identifier, migrateLegacySaves=False)
        atomic_json(self.site / 'data' / 'web-games' / (identifier + '.json'), profile)
        return identifier

    def probe_start(self, identifier):
        with self.lock:
            job = self.get(identifier)
            if job['status'] not in ('ready', 'probe-failed', 'checked', 'probing', 'published'):
                raise Problem('请先完成扫描', 409)
            self.unchanged(job)
            token = secrets.token_urlsafe(24)
            self.probes[identifier] = (token, time.monotonic())
            if job['status'] != 'published':
                job.update(status='probing', message='浏览器正在检查启动与画面')
                self.save(job)
            return dict(token=token, url='/api/imports/' + identifier + '/preview?game=probe-' + identifier)

    def probe_result(self, identifier, body):
        with self.lock:
            job = self.get(identifier)
            token, started = self.probes.get(identifier, ('', 0))
            if not token or not hmac.compare_digest(str(body.get('token', '')), token):
                raise Problem('试运行已过期，请重新开始', 409)
            errors = body.get('errors', [])
            if not isinstance(errors, list):
                raise Problem('检查结果无效')
            if not errors and (time.monotonic() - started < 18 or body.get('ready') is not True or body.get('visualReady') is not True):
                raise Problem('启动与画面检查尚未完成，黑屏不能判定为可玩', 409)
            if errors:
                self.probes.pop(identifier)
            job['check'] = dict(at=time.time(), passed=not errors, visualReady=not errors and body.get('visualReady') is True, errors=[str(e)[:500] for e in errors[:10]], scope='startup-visual')
            if job['status'] != 'published':
                job.update(status='probe-failed' if errors else 'checked', message='启动失败，请查看诊断' if errors else '已检测到画面，仍需确认标题、正文、操作和声音正常')
            self.save(job)
            return job

    def publish(self, identifier, body):
        with self.lock:
            job = self.get(identifier)
            if job['status'] == 'published':
                return job
            if job['status'] != 'checked' or not job.get('check', {}).get('passed') or job['check'].get('visualReady') is not True:
                raise Problem('必须先通过浏览器启动与画面检查', 409)
            if body.get('confirmed') is not True:
                raise Problem('需先确认游戏标题、正文、声音和操作正常', 409)
            self.unchanged(job)
            library_path = self.site / 'data/games.json'
            library = json.loads(library_path.read_text(encoding='utf8'))
            result = job['result']
            # Known profiles declare a stable game ID; reimport updates it without duplicate cards/saves.
            preset = next((p for p in self.config['profiles'] if p['id'] == result['adapter']), {})
            game_id = preset.get('gameId') or 'gal-' + result['fingerprint'][:16]
            previous = next((g for g in library['games'] if g['id'] == game_id), None)
            profile_id = self.write_profile(job, save_id=game_id)
            entry = dict(previous or {})
            entry.update(id=game_id, name=job['name'], engine=job['engine'],
                         webRuntime=dict(entry=result['runtime'], profile=profile_id),
                         managedImport=identifier, addedAt=entry.get('addedAt', time.time()))
            entry.setdefault('cover', preset.get('cover', ''))
            entry.setdefault('meta', preset.get('meta', {'tags': ['Krkr'], 'summary': '从 NAS 本地游戏库添加。'}))
            library['games'] = [entry if g['id'] == game_id else g for g in library['games']]
            if not previous:
                library['games'].append(entry)
            library['updated'] = time.strftime('%Y-%m-%d')
            backup = self.state / 'backups' / (str(time.time_ns()) + '-games.json')
            backup.parent.mkdir(exist_ok=True)
            shutil.copy2(library_path, backup)
            # Export the catalog last; the runtime manifest is already present.
            job.update(status='published', message='已加入游戏库' if not previous else '已更新已有游戏，保留原存档空间', gameId=game_id)
            job['check']['scope'] = 'startup-visual-manual'
            self.save(job)
            try:
                atomic_json(library_path, library)
            except Exception:
                job.update(status='checked', message='游戏库写入失败，可重试发布')
                self.save(job)
                raise
            self.probes.pop(identifier, None)
            return job


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'Gamehub'

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        # Never log passwords, session cookies, or full request bodies.
        print(time.strftime('%Y-%m-%d %H:%M:%S'), self.command, self.path.split('?')[0], flush=True)

    def reply(self, value, status=200, headers=None, kind='application/json; charset=utf-8'):
        data = json.dumps(value, ensure_ascii=False).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def session(self):
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get('Cookie', ''))
            token = jar.get('gamehub_admin')
            key = token.value if token else ''
        except cookies.CookieError:
            return False
        with self.app.lock:
            return self.app.sessions.get(key, 0) > time.time()

    def require_auth(self):
        if not self.session():
            raise Problem('请先登录管理后台', 401)

    def body(self):
        if self.headers.get('Transfer-Encoding'):
            raise Problem('不支持分块请求')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise Problem('请求长度无效')
        if not 0 < length <= 65536:
            raise Problem('请求内容太大或为空', 413)
        if self.headers.get_content_type() != 'application/json':
            raise Problem('请求应为 JSON', 415)
        try:
            result = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise Problem('JSON 内容无效')
        if not isinstance(result, dict):
            raise Problem('JSON 应为对象')
        return result

    def same_origin(self):
        origin = self.headers.get('Origin')
        host = self.headers.get('Host')
        if not origin or urlsplit(origin).netloc != host or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise Problem('请求来源无效，请从本站管理页操作', 403)

    def login(self, body):
        address = self.headers.get('X-Real-IP', self.client_address[0])
        now = time.time()
        with self.app.lock:
            attempts = [t for t in self.app.attempts.get(address, []) if t > now - 300]
            self.app.attempts[address] = attempts
            if len(attempts) >= 10:
                raise Problem('尝试过于频繁，请 5 分钟后再试', 429)
            attempts.append(now)
        password = body.get('password', '')
        if not isinstance(password, str) or len(password) > 200:
            raise Problem('密码错误', 401)
        auth = self.app.auth
        candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(auth['salt']), 240000).hex()
        if not hmac.compare_digest(candidate, auth['hash']):
            raise Problem('密码错误', 401)
        token = secrets.token_urlsafe(32)
        with self.app.lock:
            self.app.sessions = {k: v for k, v in self.app.sessions.items() if v > now}
            self.app.sessions[token] = now + 43200
            self.app.attempts.pop(address, None)
        secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
        self.reply({'authenticated': True}, headers={'Set-Cookie': 'gamehub_admin=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + secure})

    def serve_file(self, job, key):
        value = job.get('result', {}).get('files', {}).get(key)
        if not value:
            raise Problem('资源未注册', 404)
        path = Path(value).resolve()
        root = Path(job['result']['folder']).resolve()
        derived = (self.app.state / 'imports' / job['id'] / 'derived').resolve()
        if (root not in path.parents and derived not in path.parents) or not path.is_file():
            raise Problem('资源路径无效', 403)
        stats = path.stat()
        if [stats.st_size, stats.st_mtime_ns] != job['fileStats'][key]:
            raise Problem('资源已变化，请管理员重新扫描', 409)
        size = stats.st_size
        start, end, status_code = 0, size - 1, 200
        rng = self.headers.get('Range')
        if rng:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', rng)
            if not match or not any(match.groups()):
                return self.reply(b'', 416, {'Content-Range': 'bytes */' + str(size)})
            left, right = match.groups()
            start = int(left) if left else max(0, size - int(right))
            end = min(size - 1, int(right)) if left and right else size - 1
            if start > end or start >= size:
                return self.reply(b'', 416, {'Content-Range': 'bytes */' + str(size)})
            status_code = 206
        self.send_response(status_code)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'private, no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if status_code == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        if self.command != 'HEAD':
            with path.open('rb') as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = stream.read(min(262144, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)

    def route(self):
        url = urlsplit(self.path)
        path, query = unquote(url.path), parse_qs(url.query)
        method = self.command
        if method in ('GET', 'HEAD'):
            if path == '/api/session':
                return self.reply(dict(authenticated=self.session()))
            match = re.fullmatch(r'/game-files/([a-f0-9]{24})/(.+)', path)
            if match:
                job = self.app.get(match[1])
                if job['status'] != 'published':
                    self.require_auth()
                return self.serve_file(job, '/' + match[2])
            self.require_auth()
            if path == '/api/engines':
                return self.reply({'engines': [dict(id=a.id, label=a.label, available=True, description='XP3 游戏 · NAS 目录 / ZIP / 7z') for a in ADAPTERS.values()]})
            if path == '/api/browse':
                return self.reply(self.app.browse(query.get('path', [''])[0]))
            if path == '/api/imports':
                jobs = self.app.jobs()
                # The activity feed polls frequently; don't resend full resource maps.
                for job in jobs:
                    job.pop('fileStats', None)
                    if 'result' in job:
                        for field in ('files', 'compatibility', 'media', 'identity'):
                            job['result'].pop(field, None)
                return self.reply({'imports': jobs})
            if path == '/api/games':
                return self.reply(json.loads((self.app.site / 'data/games.json').read_text(encoding='utf8')))
            match = re.fullmatch(r'/api/imports/([a-f0-9]{24})(/preview)?', path)
            if match:
                job = self.app.get(match[1])
                if match[2]:
                    if job['id'] not in self.app.probes:
                        raise Problem('请先启动浏览器检查', 409)
                    engine_path = self.app.site / job['result']['runtime'].lstrip('/')
                    markup = engine_path.read_text(encoding='utf8')
                    base = job['result']['runtime'].rsplit('/', 1)[0] + '/'
                    markup = markup.replace('<head>', '<head><base href="' + base + '"><script src="/assets/webgal-admin-v1/probe-bridge.js"></script>', 1)
                    return self.reply(markup.encode(), kind='text/html; charset=utf-8')
                return self.reply(job)
        elif method == 'POST':
            self.same_origin()
            body = self.body()
            if path == '/api/login':
                return self.login(body)
            self.require_auth()
            if path == '/api/logout':
                jar = cookies.SimpleCookie(self.headers.get('Cookie', ''))
                with self.app.lock:
                    self.app.sessions.pop(jar['gamehub_admin'].value, None)
                return self.reply({'ok': True}, headers={'Set-Cookie': 'gamehub_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'})
            if path == '/api/password':
                with self.app.lock:
                    self.app.set_password(body.get('password'))
                    (self.app.state / 'admin-password.txt').unlink(missing_ok=True)
                return self.reply({'ok': True})
            if path == '/api/imports':
                return self.reply(self.app.create(body), 202)
            match = re.fullmatch(r'/api/imports/([a-f0-9]{24})/(probe|result|publish|retry)', path)
            if match:
                identifier, action = match.groups()
                if action == 'retry':
                    return self.reply(self.app.retry(identifier), 202)
                if action == 'probe':
                    return self.reply(self.app.probe_start(identifier))
                if action == 'result':
                    return self.reply(self.app.probe_result(identifier, body))
                return self.reply(self.app.publish(identifier, body))
        raise Problem('接口不存在', 404)

    def handle_request(self):
        self.connection.settimeout(30)
        try:
            self.route()
        except Problem as error:
            # Rejected POST bodies may be unread; don't parse them as the next request.
            if self.command == 'POST':
                self.close_connection = True
            self.reply({'error': str(error)}, error.status)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception as error:
            print('ERROR', type(error).__name__, str(error), flush=True)
            self.reply({'error': '服务处理失败，请查看后台日志'}, 500)

    do_GET = do_HEAD = do_POST = handle_request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--port', type=int, default=8182)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf8'))
    app = App(args.site, args.state, config)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.app = app
    print('Gamehub admin listening on loopback port', args.port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
