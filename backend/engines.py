"""Engine adapters. Detection is separate from compatibility and runtime validation."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import zlib

MAGIC = b'XP3\r\n \n\x1a\x8bg\x01'
MAX_INDEX = 32 * 1024 * 1024


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def inflate(data, limit):
    decoder = zlib.decompressobj()
    result = decoder.decompress(data, limit + 1)
    if len(result) > limit or not decoder.eof:
        raise ValueError('XP3 索引超过限制或已损坏')
    return result


def xp3_index(path, allow_protected=False):
    """Bounded standard XP3 parser; protected flags need a matched adapter."""
    size = path.stat().st_size
    with path.open('rb') as stream:
        if stream.read(11) != MAGIC:
            raise ValueError(path.name + ' 不是标准 XP3，可能加密或损坏')
        offset, = struct.unpack('<Q', stream.read(8))
        if not 19 <= offset < size:
            raise ValueError('XP3 索引偏移无效')
        stream.seek(offset)
        flag = stream.read(1)[0]
        if flag not in (0, 1):
            raise ValueError('此 XP3 使用尚未支持的索引格式')
        stored, = struct.unpack('<Q', stream.read(8))
        original = struct.unpack('<Q', stream.read(8))[0] if flag else stored
        if max(stored, original) > MAX_INDEX or stored > size - stream.tell():
            raise ValueError('XP3 索引长度无效')
        raw = stream.read(stored)
        index = inflate(raw, original) if flag else raw
        if len(index) != original:
            raise ValueError('XP3 索引不完整')
    entries = []
    pos = 0
    while pos < len(index):
        tag, length = struct.unpack_from('<4sQ', index, pos)
        end = pos + 12 + length
        if tag != b'File' or end > len(index) or end <= pos:
            raise ValueError('XP3 File 索引损坏')
        q, entry = pos + 12, {'segments': []}
        while q < end:
            kind, length = struct.unpack_from('<4sQ', index, q)
            data = index[q + 12:q + 12 + length]
            if q + 12 + length > end:
                raise ValueError('XP3 子索引损坏')
            if kind == b'info':
                flags, original, stored, count = struct.unpack_from('<IQQH', data)
                name = data[22:].decode('utf-16-le')
                if len(data[22:]) != count * 2:
                    raise ValueError('XP3 文件名索引损坏')
                if flags & 0x80000000 and not allow_protected:
                    raise ValueError('XP3 带保护标记，需要匹配并验证对应的兼容配置')
                entry.update(name=name, size=original, protected=bool(flags & 0x80000000))
            elif kind == b'adlr':
                if len(data) != 4:
                    raise ValueError('XP3 校验索引损坏')
                entry['checksum'] = struct.unpack('<I', data)[0]
            elif kind == b'segm':
                if len(data) % 28:
                    raise ValueError('XP3 数据段索引损坏')
                entry['segments'] = [struct.unpack_from('<IQQQ', data, i) for i in range(0, len(data), 28)]
            q += 12 + length
        if 'name' not in entry or not entry['segments']:
            raise ValueError('XP3 缺少文件信息')
        for flags, offset, original, stored in entry['segments']:
            if flags not in (0, 1) or offset < 19 or offset + stored > size:
                raise ValueError('XP3 数据段超出文件范围')
        if sum(s[2] for s in entry['segments']) != entry['size']:
            raise ValueError('XP3 数据段与文件长度不一致')
        entries.append(entry)
        pos = end
    return entries


def read_entry(path, entry, limit=16 * 1024 * 1024):
    """Read a bounded entry without executing it; used for startup identity checks."""
    if entry['size'] > limit:
        raise ValueError('XP3 启动文件超过检查限制')
    pieces = []
    with Path(path).open('rb') as stream:
        for flags, offset, original, stored in entry['segments']:
            if stored > limit:
                raise ValueError('XP3 数据段超过检查限制')
            stream.seek(offset)
            raw = stream.read(stored)
            data = inflate(raw, original) if flags & 1 else raw
            if len(data) != original:
                raise ValueError('XP3 数据段不完整')
            pieces.append(data)
    result = b''.join(pieces)
    if 'checksum' in entry and zlib.adler32(result) != entry['checksum']:
        raise ValueError('XP3 启动文件校验失败，可能需要专用解密适配器')
    return result


def discover_main(root):
    """Find startup content, not a particular archive filename. Keep patches secondary."""
    indexes, errors, candidates = {}, {}, []
    seen = 0
    for directory, dirs, names in os.walk(root, followlinks=False):
        folder = Path(directory)
        if len(folder.relative_to(root).parts) >= 5:
            dirs[:] = []
        dirs[:] = [d for d in dirs if not (folder / d).is_symlink()]
        for name in names:
            seen += 1
            if seen > 50000:
                raise ValueError('目录文件过多，请进入某一款游戏目录再添加')
            path = folder / name
            if path.suffix.lower() != '.xp3' or path.is_symlink():
                continue
            if len(indexes) + len(errors) >= 64:
                raise ValueError('发现过多 XP3，请选择单款游戏目录')
            try:
                entries = xp3_index(path, allow_protected=True)
                indexes[path] = entries
                if any(e['name'].replace('\\', '/').lower() == 'startup.tjs' for e in entries):
                    candidates.append(path)
            except (ValueError, struct.error, UnicodeError, IndexError) as error:
                errors[path] = str(error)
    if not candidates:
        if errors:
            first = next(iter(errors))
            raise ValueError('无法检查 ' + first.name + '：' + errors[first])
        raise ValueError('没有找到含 startup.tjs 的 XP3 主包；支持 data.xp3、启动游戏.xp3 等名称，请选择完整游戏目录或压缩包')
    folders = {p.parent for p in candidates}
    if len(folders) != 1:
        raise ValueError('目录中有多个游戏，请进入某一款游戏的目录再添加。')
    conventional = [p for p in candidates if p.name.lower() == 'data.xp3']
    if conventional:
        main = conventional[0]
    elif len(candidates) == 1:
        main = candidates[0]
    else:
        raise ValueError('多个非标准名称的 XP3 都含 startup.tjs，无法安全确定主包：' + '、'.join(p.name for p in candidates))
    return main, indexes, errors


class KrkrAdapter:
    id = 'krkrsdl2'
    label = 'KiriKiri / Krkr'
    extensions = ['.xp3']

    def scan(self, root, config, progress):
        progress('按 XP3 内容查找 startup.tjs 主包…')
        main, discovered, errors = discover_main(root)
        folder = main.parent
        files = {}
        for path in folder.rglob('*'):
            if path.is_symlink():
                raise ValueError('游戏目录中有符号链接，请使用完整的本地游戏文件')
            if not path.is_file():
                continue
            relative = path.relative_to(folder).as_posix()
            if path.suffix.lower() not in ('.xp3', '.wmv', '.mp4', '.avi', '.mpg', '.mpeg', '.tjs', '.ks', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.ogg', '.opus', '.wav', '.mp3', '.mid', '.oggloop'):
                continue
            # Only the virtual mount name changes. Physical and archived names stay intact.
            if path == main:
                relative = 'data.xp3'
            elif relative.lower() == 'data.xp3':
                raise ValueError('主包与另一个 data.xp3 冲突，需要显式适配')
            if not re.fullmatch(r'(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+', relative):
                raise ValueError('资源路径暂不受引擎加载器支持：' + relative)
            key = '/' + relative
            if any(k.lower() == key.lower() for k in files):
                raise ValueError('资源文件有大小写冲突：' + relative)
            files[key] = str(path)
            if len(files) > 20000:
                raise ValueError('散文件超过当前适配器限制，请使用 XP3 版游戏')
        # Root data is case normalized for the engine manifest.
        progress('正在检查 XP3 索引和游戏版本…')
        indexes = {}
        hashes = {key.lower(): digest(value) for key, value in files.items() if key.lower() in ('/data.xp3', '/patch.xp3')}
        match = next((p for p in config['profiles'] if p['identity'] == hashes), None)
        for key, value in files.items():
            if key.lower().endswith('.xp3'):
                if Path(value) in errors:
                    raise ValueError(Path(value).name + '：' + errors[Path(value)])
                indexes[key.lower()] = discovered.get(Path(value)) or xp3_index(Path(value), allow_protected=True)
        runtime = config['runtime']
        if match:
            runtime = match.get('runtime', runtime)
            expected = match['resources']
            missing = sorted(set(expected) - {k.lower() for k in files})
            if missing:
                raise ValueError('游戏文件不完整，缺少：' + '、'.join(missing))
            # Check every resource, so another game's voice/patch cannot reuse a profile.
            for key, value in files.items():
                if key.lower() in expected:
                    progress('校验资源：' + key)
                    if digest(value) != expected[key.lower()]:
                        raise ValueError('资源与兼容版本不符：' + key)
            compatibility = match['compatibility']
            media = match.get('media', {})
            name = match['name']
            adapter = match['id']
            verified = True
        else:
            startup = next(e for e in indexes['/data.xp3'] if e['name'].replace('\\', '/').lower() == 'startup.tjs')
            raw = read_entry(main, startup)
            if raw.startswith(b'TJS2'):
                if not raw.startswith(b'TJS2100\0'):
                    raise ValueError('启动脚本字节码版本尚未支持')
            elif raw[:2] not in (b'\xff\xfe', b'\xfe\xff', b'\xfe\xfe'):
                try:
                    raw.decode('utf-8-sig')
                except UnicodeError:
                    raise ValueError('启动脚本编码或加密格式尚未支持')
            compatibility = config['genericCompatibility']
            media, name, adapter, verified = {}, folder.name, 'krkr-standard', False
        media_sources = []
        if not verified:
            for key, entries in indexes.items():
                for entry in entries:
                    normalized = entry['name'].replace('\\', '/')
                    if Path(normalized).suffix.lower() in ('.wmv', '.mpg', '.mpeg', '.avi', '.mp4'):
                        media_sources.append(dict(archive=files[next(k for k in files if k.lower() == key)], entry=entry, name=Path(normalized).name))
            for key, value in files.items():
                if Path(key).suffix.lower() in ('.wmv', '.mpg', '.mpeg', '.avi', '.mp4'):
                    media_sources.append(dict(path=value, name=Path(key).name))
        plugins = sorted(p.name for p in folder.rglob('*') if p.suffix.lower() == '.dll')
        return dict(folder=str(folder), files=files, identity=hashes, fingerprint=hashes['/data.xp3'],
                    name=name, adapter=adapter, verifiedAdapter=verified, compatibility=compatibility,
                    media=media, mediaSources=media_sources, mainArchive=main.name, runtime=runtime, plugins=plugins,
                    archiveCount=len(indexes), resourceCount=sum(len(x) for x in indexes.values()),
                    totalBytes=sum(Path(v).stat().st_size for v in files.values()),
                    warnings=([] if verified else ['标准 Krkr 试适配：DLL 插件和后续剧情需试运行确认；识别出 XP3 不代表完整兼容。']) +
                             (['已将主包 ' + main.name + ' 映射为引擎内 data.xp3，原文件不变。'] if main.name != 'data.xp3' else []))


ADAPTERS = {KrkrAdapter.id: KrkrAdapter()}
