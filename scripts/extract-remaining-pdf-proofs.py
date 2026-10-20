import json
from pathlib import Path
import fitz
root=Path(__file__).resolve().parent.parent
folder=root/json.loads((root/'runtime/remaining-review-location.json').read_text(encoding='utf-8'))['root']/'sources'
results=[]
for name,phrase in [('fltrp-colour-food-teacher-resource.pdf','1980 study'),('2021-12-complete-teacher-transcript.pdf','regarded as sufficient')]:
    doc=fitz.open(folder/name)
    pages=[]
    for index,page in enumerate(doc):
        text=page.get_text()
        if phrase in ' '.join(text.split()):
            image=folder/(Path(name).stem+f'-page-{index+1}.png')
            page.get_pixmap(matrix=fitz.Matrix(1.25,1.25)).save(image)
            pages.append({'page':index+1,'text':text,'image':str(image.relative_to(root)).replace('\\','/')})
    if not pages: raise ValueError('Expected source phrase not found: '+name)
    results.append({'file':name,'phrase':phrase,'pages':pages})
(folder/'pdf-excerpts.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps([{'file':r['file'],'pages':[p['page'] for p in r['pages']]} for r in results]))
