"""Prepare browser video from registered loose files or bounded XP3 segments."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zlib


def extract(source, target):
    entry = source['entry']
    if entry['size'] > 2 * 1024**3:
        raise ValueError('单个视频超过当前自动转换限制（2 GB）')
    checksum, written = 1, 0
    with Path(source['archive']).open('rb') as stream, target.open('wb') as output:
        for flags, offset, original, stored in entry['segments']:
            stream.seek(offset)
            left, produced = stored, 0
            decoder = zlib.decompressobj() if flags & 1 else None
            while left:
                block = stream.read(min(left, 262144))
                if not block:
                    raise ValueError('视频 XP3 数据不完整')
                left -= len(block)
                while block:
                    data = decoder.decompress(block, 262144) if decoder else block
                    block = decoder.unconsumed_tail if decoder else b''
                    produced += len(data)
                    written += len(data)
                    if produced > original or written > entry['size']:
                        raise ValueError('视频 XP3 数据段长度超出声明值')
                    checksum = zlib.adler32(data, checksum)
                    output.write(data)
            if produced != original or (decoder and not decoder.eof):
                raise ValueError('视频 XP3 数据段校验失败')
    if written != entry['size'] or ('checksum' in entry and checksum != entry['checksum']):
        raise ValueError('视频资源校验失败，可能需要专用解密适配器')


def prepare(sources, destination, job_id, progress):
    if not sources:
        return {}, {}
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ValueError('NAS 缺少 ffmpeg / ffprobe，无法自动准备浏览器视频')
    if len(sources) > 24:
        raise ValueError('视频数量超过自动转换限制，请先配置专用媒体适配')
    destination.mkdir(parents=True, exist_ok=True)
    media, files = {}, {}
    for number, source in enumerate(sources):
        name = source['name'].lower()
        if name in media:
            raise ValueError('视频同名冲突，需专用媒体配置：' + name)
        if not name.isascii() or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_.-' for c in name):
            raise ValueError('视频名称暂不受加载器支持：' + name)
        progress(f'正在准备浏览器视频 {number + 1}/{len(sources)}：{source["name"]}')
        extracted = destination / (str(number) + '-source' + Path(source['name']).suffix)
        if 'archive' in source:
            extract(source, extracted)
            original = extracted
        else:
            original = Path(source['path'])
        h = hashlib.sha256()
        with original.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        target = destination / (str(number) + '.mp4')
        partial = target.with_suffix('.partial.mp4')
        marker = target.with_suffix('.prepared.json')
        cached = {}
        if marker.is_file():
            try:
                cached = json.loads(marker.read_text())
            except (ValueError, OSError):
                pass
        if not (target.is_file() and cached.get('sourceSha256') == h.hexdigest() and cached.get('version') == 1 and cached.get('bytes') == target.stat().st_size):
            command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(original), '-map', '0:v:0', '-map', '0:a:0?',
                       '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                       '-b:a', '128k', '-movflags', '+faststart', '-threads', '2', str(partial)]
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=1800)
            if result.returncode:
                raise ValueError('视频转换失败：' + source['name'] + '；' + result.stderr.decode(errors='replace')[:300])
            partial.replace(target)
        metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
            'stream=codec_type,width,height,avg_frame_rate:format=duration', '-of', 'json', str(target)], timeout=30))
        video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
        numerator, denominator = map(int, video['avg_frame_rate'].split('/'))
        key = '/webmedia/' + target.name
        files[key] = str(target)
        media[name] = dict(url='/game-files/' + job_id + key, fps=numerator / denominator,
                           duration=float(metadata['format']['duration']), width=video['width'], height=video['height'], sourceSha256=h.hexdigest())
        marker.write_text(json.dumps(dict(sourceSha256=h.hexdigest(), version=1, bytes=target.stat().st_size)))
        extracted.unlink(missing_ok=True)
    return media, files
