"""Prepare pinned upstream sources plus KiriHub patches without changing originals."""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT=Path(__file__).resolve().parents[1]
def run(*args,cwd=None):
    subprocess.run(args,cwd=cwd,check=True)
def snapshot(source,destination,commit):
    raw=subprocess.check_output(['git','-C',str(source),'archive',commit])
    destination.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        # Archive entries come from a local git tree, not user-supplied games.
        for item in archive.getmembers():
            path=(destination/item.name).resolve()
            if not path.is_relative_to(destination.resolve()):
                raise ValueError('Archive path escapes destination')
            if item.isdir(): path.mkdir(parents=True,exist_ok=True)
            elif item.isfile():
                path.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(item) as src,path.open('wb') as dst: shutil.copyfileobj(src,dst)
            elif item.issym():
                # The Web build does not consume upstream convenience symlinks.
                print('Skipping upstream symlink:',item.name)
    entries=subprocess.check_output(['git','-C',str(source),'ls-tree','-r',commit]).decode().splitlines()
    for line in entries:
        meta,name=line.split('\t',1)
        mode,kind,revision=meta.split()
        if mode=='160000':
            child=source/name
            if not (child/'.git').exists():
                raise RuntimeError('Local submodule is not initialized: '+name)
            snapshot(child,destination/name,revision)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--local-source',type=Path)
    args=parser.parse_args()
    destination=args.destination.resolve()
    if destination.exists() and any(destination.iterdir()): raise SystemExit('Destination must be empty')
    lock=json.loads((ROOT/'engine/upstream-lock.json').read_text())
    if args.local_source:
        snapshot(args.local_source.resolve(),destination,lock['engine']['commit'])
    else:
        run('git','clone',lock['engine']['url'],str(destination))
        run('git','checkout',lock['engine']['commit'],cwd=destination)
        run('git','submodule','update','--init','--recursive',cwd=destination)
    for folder,patch in [(destination,'krkrsdl2.patch'),(destination/'external/krkrz','krkrz.patch')]:
        path=str(ROOT/'engine/patches'/patch)
        # A snapshot inside another git checkout must not discover that parent:
        # git apply would otherwise silently skip paths outside its cwd prefix.
        env={**os.environ,'GIT_CEILING_DIRECTORIES':str(folder.parent)}
        subprocess.run(['git','apply','--check',path],cwd=folder,env=env,check=True)
        subprocess.run(['git','apply',path],cwd=folder,env=env,check=True)
    shutil.copytree(ROOT/'engine/overlay',destination,dirs_exist_ok=True)
    if 'KIRIHUB_DEPS_ROOT' not in (destination/'CMakeLists.txt').read_text():
        raise RuntimeError('Engine patch was not applied')
    print('Prepared engine sources:',destination)

if __name__=='__main__': main()
