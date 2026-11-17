"""Loopback static preview with byte ranges and browser isolation headers."""
import argparse
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import re

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy','same-origin')
        self.send_header('Cross-Origin-Embedder-Policy','require-corp')
        self.send_header('Accept-Ranges','bytes')
        super().end_headers()
    def send_head(self):
        self.remaining=None
        path=Path(self.translate_path(self.path))
        if not path.resolve().is_relative_to(Path(self.directory).resolve()):
            self.send_error(403); return None
        value=self.headers.get('Range')
        if not value or not path.is_file(): return super().send_head()
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',value.strip())
        size=path.stat().st_size
        start=end=0
        if match and size:
            first,last=match.groups()
            if first:
                start=int(first); end=min(int(last),size-1) if last else size-1
            elif last and int(last)>0:
                start=max(0,size-int(last)); end=size-1
            else: match=None
        if not match or not size or start>end or start>=size:
            self.send_response(416); self.send_header('Content-Range',f'bytes */{size}'); self.end_headers(); return None
        stream=path.open('rb'); stream.seek(start)
        self.remaining=end-start+1
        self.send_response(206)
        self.send_header('Content-Type',self.guess_type(str(path)))
        self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length',str(self.remaining)); self.end_headers()
        return stream
    def copyfile(self,source,output):
        if self.remaining is None: return super().copyfile(source,output)
        while self.remaining:
            block=source.read(min(65536,self.remaining))
            if not block: break
            output.write(block); self.remaining-=len(block)

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('directory',type=Path); parser.add_argument('port',type=int,nargs='?',default=8300)
    args=parser.parse_args(); root=args.directory.resolve()
    if not root.is_dir(): parser.error('Directory not found')
    server=ThreadingHTTPServer(('127.0.0.1',args.port),lambda *a,**kw:Handler(*a,directory=str(root),**kw))
    print(f'Preview: http://127.0.0.1:{args.port}/',flush=True); server.serve_forever()

if __name__=='__main__': main()
