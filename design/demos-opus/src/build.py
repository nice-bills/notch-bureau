import pathlib,sys
d=pathlib.Path(__file__).parent
css=(d/'core.css').read_text(); js=(d/'core.js').read_text(); icons=(d/'icons.html').read_text()
chrome='<div class="statusbar"><span class="num">9:41</span><span class="icons"><svg width="18" height="12" viewBox="0 0 18 12"><use href="#i-sig"/></svg><svg width="27" height="13" viewBox="0 0 27 13"><use href="#i-bat"/></svg></span></div><div class="island"></div><div class="homebar"></div>'
for src in sorted(d.glob('demo-*.src.html')):
    t=src.read_text().replace('/*@CORE_CSS*/',css).replace('//@CORE_JS',js).replace('<!--@ICONS-->',icons).replace('<!--@CHROME-->',chrome)
    out=d.parent/src.name.replace('.src','')
    out.write_text(t); print(out, len(t))
# round 3: Post is published from its own file so the round-2 link stays as the "before"
p=d.parent/'demo-3-post.html'; (d.parent/'demo-3-post-glass.html').write_text(p.read_text().replace('<title>Notch Post</title>','<title>Notch Post Glass</title>',1))
