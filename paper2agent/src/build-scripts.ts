export const READ_PAPER = `import pathlib,sys
path=pathlib.Path('/workspace/paper.input')
data=path.read_bytes()
if data.startswith(b'%PDF-'):
    from pypdf import PdfReader
    reader=PdfReader(path)
    if len(reader.pages)>200: raise ValueError('paper exceeds 200 pages')
    pieces=[]; length=0
    for page in reader.pages:
        text=page.extract_text() or ''
        pieces.append(text); length+=len(text)
        if length>=50000: break
    text='\\n'.join(pieces)
else:
    text=data.decode('utf-8',errors='replace')
    if '<html' in text[:2000].lower() or '<!doctype html' in text[:2000].lower():
        from html.parser import HTMLParser
        class Text(HTMLParser):
            def __init__(self): super().__init__(); self.parts=[]; self.hidden=0
            def handle_starttag(self,tag,attrs):
                if tag in ('script','style'): self.hidden+=1
            def handle_endtag(self,tag):
                if tag in ('script','style') and self.hidden: self.hidden-=1
            def handle_data(self,data):
                if not self.hidden: self.parts.append(data)
        parser=Text(); parser.feed(text); text='\\n'.join(parser.parts)
text=text.encode('utf-8')[:60000].decode('utf-8',errors='ignore')
if not text.strip(): raise ValueError('paper has no extractable text; supply paper text')
output=pathlib.Path('/workspace/paper.txt'); output.write_text(text); output.chmod(0o444)
print('Paper text prepared: '+str(len(text))+' characters')
`;

export const LOAD_VERIFICATION_PACKAGE = `import pathlib,tarfile,subprocess,os
root=pathlib.Path('/workspace/output')
with tarfile.open('/workspace/package.tar') as archive:
    for member in archive:
        name=pathlib.PurePosixPath(member.name)
        if not member.isfile() or name.is_absolute() or any(p in ('..','.') for p in name.parts): raise ValueError('invalid verification package member')
        path=root.joinpath(*name.parts); path.parent.mkdir(parents=True,exist_ok=True)
        source=archive.extractfile(member)
        with path.open('xb') as target:
            while chunk:=source.read(65536): target.write(chunk)
        path.chmod(0o444)
lock=root/'requirements.lock'
if lock.exists() and lock.read_text().strip():
    subprocess.run(['python','-I','-m','pip','install','--no-index','--no-deps','--only-binary=:all:','--require-hashes','--target','/workspace/deps','--find-links',str(root/'wheels'),'-r',str(lock)],check=True)
for directory in (root,pathlib.Path('/workspace/deps')):
    for item in sorted(directory.rglob('*'),reverse=True):
        if item.is_symlink(): raise ValueError('runtime dependency introduced a link')
        item.chmod(0o555 if item.is_dir() else 0o444)
    directory.chmod(0o555)
print('Fresh immutable verification environment prepared')
`;
