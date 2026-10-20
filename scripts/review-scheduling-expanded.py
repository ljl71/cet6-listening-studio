"""Independent retry with wider original-media context; no reference prompt."""
import json,hashlib,subprocess,time,sys,wave
from pathlib import Path
import numpy as np
import torch,whisper
sys.stdout.reconfigure(encoding='utf-8',errors='backslashreplace')
root=Path(__file__).resolve().parent.parent
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
folder=root/read(root/'runtime/remaining-review-location.json')['root']/'audio'
paper=read(root/'data/papers/cet6-2025-06-1.json');asset=read(root/'data/assets.json')[paper['audioAssetId']]
source=root/'data'/asset['path'];assert sha(source)==asset['sha256']
model=root/'runtime/whisper-python-cache/small.en.pt';assert sha(model)=='f953ad0fd29cacd07d5a9eda5624af0f6bcf2258be67c92b79389873d91e0872'
wav=folder/'scheduling-expanded.wav';output=folder/'scheduling-expanded.json'
subprocess.run([read(root/'runtime/media-tools.json')['ffmpeg'],'-nostdin','-hide_banner','-loglevel','error','-y','-ss','60','-i',str(source),'-t','25','-ar','16000','-ac','1','-c:a','pcm_s16le',str(wav)],check=True)
with wave.open(str(wav)) as w: audio=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype('float32')/32768
torch.set_num_threads(2);decoder=whisper.load_model(str(model),device='cpu');began=time.time()
result=decoder.transcribe(audio,language='en',fp16=False,temperature=0,beam_size=5,condition_on_previous_text=False,word_timestamps=True,verbose=False)
output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
meta={'identity':{'audioAssetId':paper['audioAssetId'],'mediaSha256':asset['sha256'],'sourceRange':{'start':60,'end':85},'targets':[{'kind':'transcript','sentenceId':'cet6-2025-06-1-p-1-5-s1'}],'modelSha256':sha(model)},'wavSha256':sha(wav),'recognitionSha256':sha(output),'expectedTranscriptSupplied':False,'elapsedSeconds':time.time()-began,'text':result['text'],'reason':'Earlier short crop omitted the actual target; repeat from wider independently decoded original audio, no expected text supplied.'}
(folder/'scheduling-expanded.meta.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(result['text'])
