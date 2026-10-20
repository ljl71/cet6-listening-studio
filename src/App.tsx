import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, AudioLines, Bookmark, BookOpen, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3, FileAudio, FileCheck2, FolderOpen, Headphones, Info, LayoutGrid, ListFilter, LoaderCircle, Moon, Pause, PencilLine, Play, Repeat, RotateCcw, Search, Settings2, ShieldCheck, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Sun, TrendingUp, Upload, Volume2, X } from 'lucide-react';
import { api, clock, dateLabel, safeStorage } from './api';
import { OPTIONS, QUALITY_LABEL, STATUS_LABEL, TYPE_LABEL } from './types';
import type { Annotation, Attempt, Health, Paper, PaperSummary, Passage, PassageType, Progress, Quality, Sentence, Stats } from './types';
import { useAudio } from './useAudio';
import type { AudioController } from './useAudio';

type Page = 'library' | 'practice' | 'review' | 'records';
type TranscriptMode = 'hidden' | 'english' | 'bilingual';
const PAGE_INFO = { library: ['真题库', 'YOUR LISTENING LIBRARY'], practice: ['听力工作台', 'FOCUS. LISTEN. UNDERSTAND.'], review: ['错题与收藏', 'A LITTLE BETTER, EVERY TIME.'], records: ['学习记录', 'EVERY MINUTE COUNTS.'] };
const qualityKeys = Object.keys(QUALITY_LABEL) as (keyof Quality)[];
const pageFromHash = (): Page => { const value = location.hash.slice(1); return ['library', 'practice', 'review', 'records'].includes(value) ? value as Page : 'library'; };
const paperReady = (paper?: Paper | PaperSummary | null) => !!paper && qualityKeys.every(key => paper.quality[key] === 'verified') && (('questions' in paper ? paper.questions.length : paper.questionCount) === 25) && (('passages' in paper ? paper.passages.length : paper.passageCount) === 7) && !!paper.audioAssetId;
const percentage = (correct: number, total: number) => total ? `${Math.round(correct / total * 100)}%` : '—';
const passagePlaybackStart = (section: Passage) => {
  const first = section.sentences[0];
  return Math.max(0, Math.min(section.start, first && first.end > first.start ? first.start : section.start));
};

export default function App() {
  const [page, setPageState] = useState<Page>(pageFromHash);
  const [theme, setTheme] = useState(() => safeStorage.get('tingjian-theme', 'light'));
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [cache, setCache] = useState<Record<string, Paper>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const attemptsRef = useRef<Attempt[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [stats, setStats] = useState<Stats>({ listeningSeconds: 0, byPaper: {} });
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState('');
  const [activeId, setActiveId] = useState('');
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [passageId, setPassageId] = useState('');
  const [selectedSentenceId, setSelectedSentenceId] = useState('');
  const [attemptSelections, setAttemptSelections] = useState<Record<string, string>>({});
  const [transcript, setTranscript] = useState<TranscriptMode>('hidden');
  const [follow, setFollow] = useState(true);
  const [settings, setSettings] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewTab, setReviewTab] = useState<'wrong' | 'favorite' | 'notes'>('wrong');
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const creating = useRef(new Map<string, Promise<Attempt>>());
  const navigationIntent = useRef<{ paperId: string; questionId?: string; sentenceId?: string; type?: PassageType; reveal?: boolean } | null>(null);
  const [navigationNonce, setNavigationNonce] = useState(0);
  const paper = cache[activeId] || null;
  const notify = useCallback((message: string) => setToast(message), []);
  const updateProgress = useCallback((updated: Progress) => setProgress(value => [...value.filter(item => item.paperId !== updated.paperId), updated]), []);
  const player = useAudio(paper, progress, notify, updateProgress);
  const sortedAttempts = useMemo(() => [...attempts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [attempts]);
  const currentAttempt = attempts.find(a => a.id === attemptSelections[activeId]) || sortedAttempts.find(a => a.paperId === activeId && a.status === 'draft') || sortedAttempts.find(a => a.paperId === activeId) || null;
  const passage = paper?.passages.find(p => p.id === passageId) || paper?.passages[0] || null;
  const selectedSentence = paper?.passages.flatMap(p => p.sentences).find(s => s.id === selectedSentenceId) || player.currentSentence;

  const go = useCallback((next: Page) => { setPageState(next); location.hash = next; }, []);
  const upsertAttempt = useCallback((attempt: Attempt) => {
    const next = [...attemptsRef.current.filter(item => item.id !== attempt.id), attempt];
    attemptsRef.current = next; setAttempts(next);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [h, p, a, pr, an, st] = await Promise.all([api<Health>('/api/health'), api<PaperSummary[]>('/api/papers'), api<Attempt[]>('/api/attempts'), api<Progress[]>('/api/progress'), api<Annotation[]>('/api/annotations'), api<Stats>('/api/stats')]);
      setHealth(h); setPapers(p); setAttempts(a); attemptsRef.current = a; setProgress(pr); setAnnotations(an); setStats(st); setOffline(false);
      setActiveId(id => id || [...pr].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0]?.paperId || p.find(item => item.audioAssetId)?.id || p[0]?.id || '');
    } catch (error) { setOffline(true); notify(`本地服务暂时无法连接：${(error as Error).message}`); }
    finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = theme; safeStorage.set('tingjian-theme', theme); }, [theme]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 6000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { const onHash = () => setPageState(pageFromHash()); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => {
    if (page !== 'library' && page !== 'records') return;
    let cancelled = false;
    const update = () => api<Stats>('/api/stats').then(value => { if (!cancelled) setStats(value); }).catch(() => undefined);
    void update(); const interval = setInterval(() => void update(), 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [page]);
  useEffect(() => {
    if (!activeId || cache[activeId]) return;
    let cancelled = false;
    api<Paper>(`/api/papers/${encodeURIComponent(activeId)}`).then(data => { if (!cancelled) setCache(value => ({ ...value, [data.id]: data })); }).catch(error => notify(error.message));
    return () => { cancelled = true; };
  }, [activeId, cache, notify]);
  useEffect(() => { setPassageId(''); setSelectedSentenceId(''); setTranscript('hidden'); setInspector(false); }, [activeId]);
  useEffect(() => {
    const intent = navigationIntent.current;
    if (!intent || paper?.id !== intent.paperId) return;
    const section = paper.passages.find(p => intent.type ? p.type === intent.type : p.id === paper.questions.find(q => q.id === intent.questionId)?.passageId || p.sentences.some(s => s.id === intent.sentenceId));
    setPassageId(section?.id || ''); setSelectedSentenceId(intent.sentenceId || ''); setTranscript(intent.reveal ? 'english' : 'hidden');
    navigationIntent.current = null;
  }, [activeId, paper, navigationNonce]);
  useEffect(() => {
    if (page !== 'review' && page !== 'records') return;
    const needed = [...new Set([...attempts.map(a => a.paperId), ...annotations.map(a => a.paperId)])].filter(id => !cache[id]);
    if (!needed.length) return;
    let cancelled = false;
    void Promise.allSettled(needed.map(id => api<Paper>(`/api/papers/${encodeURIComponent(id)}`))).then(results => {
      if (cancelled) return;
      const fetched: Record<string, Paper> = {};
      results.forEach(result => { if (result.status === 'fulfilled') fetched[result.value.id] = result.value; });
      if (Object.keys(fetched).length) setCache(value => ({ ...value, ...fetched }));
    });
    return () => { cancelled = true; };
  }, [page, attempts, annotations, cache]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (settings || event.altKey || event.ctrlKey || event.metaKey || target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); if (player.playing || player.waiting) player.pause(); else void player.play(); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); player.seek(player.position - 5); }
      if (event.code === 'ArrowRight') { event.preventDefault(); player.seek(player.position + 5); }
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        const sentences = paper?.passages.flatMap(p => p.sentences).filter(s => s.end > s.start) || [];
        const index = sentences.findIndex(s => s.id === (player.currentSentence?.id || selectedSentence?.id));
        const next = sentences[Math.max(0, Math.min(sentences.length - 1, index + (event.code === 'ArrowDown' ? 1 : -1)))];
        if (next) { event.preventDefault(); setSelectedSentenceId(next.id); player.setLoopMode('off'); player.seek(next.start); }
      }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [paper, player, selectedSentence, settings]);

  const ensureAttempt = async (assisted = false, paperId = activeId): Promise<Attempt> => {
    const chosen = attemptsRef.current.find(item => item.paperId === paperId && item.id === attemptSelections[paperId]) || [...attemptsRef.current].reverse().find(item => item.paperId === paperId && item.status === 'draft');
    if (chosen?.status === 'draft') {
      if (assisted && !chosen.assisted) { const updated = { ...chosen, assisted: true }; upsertAttempt(updated); await api(`/api/attempts/${chosen.id}`, 'PATCH', { assisted: true }); return updated; }
      return chosen;
    }
    let pending = creating.current.get(paperId);
    if (!pending) {
      pending = api<Attempt>('/api/attempts', 'POST', { paperId, mode: attemptsRef.current.some(a => a.paperId === paperId && a.status === 'submitted') ? 'review' : 'first' }).then(attempt => {
        upsertAttempt(attempt); setAttemptSelections(value => ({ ...value, [paperId]: attempt.id })); return attempt;
      }).finally(() => { creating.current.delete(paperId); });
      creating.current.set(paperId, pending);
    }
    const created = await pending;
    const latest = attemptsRef.current.find(item => item.id === created.id) || created;
    if (assisted && !latest.assisted) {
      const updated = { ...latest, assisted: true }; upsertAttempt(updated);
      await api(`/api/attempts/${created.id}`, 'PATCH', { assisted: true }); return updated;
    }
    return latest;
  };
  const answer = async (questionId: string, option: 'A' | 'B' | 'C' | 'D') => {
    const paperId = activeId;
    try {
      const draft = await ensureAttempt(transcript !== 'hidden' || inspector, paperId);
      const latest = attemptsRef.current.find(a => a.id === draft.id) || draft;
      const updated = { ...latest, answers: { ...latest.answers, [questionId]: option } }; upsertAttempt(updated);
      saveQueue.current = saveQueue.current.catch(() => undefined).then(() => api(`/api/attempts/${draft.id}`, 'PATCH', { answers: updated.answers, assisted: updated.assisted }));
      await saveQueue.current;
    } catch (error) { notify(`答案还未保存：${(error as Error).message}`); }
  };
  const reveal = async (mode: TranscriptMode) => {
    const paperId = activeId;
    if (mode !== 'hidden' && currentAttempt?.status !== 'submitted' && paper?.questions.length) {
      try { await ensureAttempt(true); } catch (error) { notify((error as Error).message); return; }
    }
    if (activeIdRef.current === paperId) setTranscript(mode);
  };
  const submit = async () => {
    if (!paper?.questions.length) return;
    setSubmitting(true);
    try { const draft = await ensureAttempt(transcript !== 'hidden'); await saveQueue.current; const result = await api<Attempt>(`/api/attempts/${draft.id}/submit`, 'POST'); upsertAttempt(result); notify('已交卷。错题可以直接回到原文回听。'); }
    catch (error) { notify((error as Error).message); }
    finally { setSubmitting(false); }
  };
  const newAttempt = async () => {
    try { const result = await api<Attempt>('/api/attempts', 'POST', { paperId: activeId, mode: attempts.some(a => a.paperId === activeId && a.status === 'submitted') ? 'review' : 'first' }); upsertAttempt(result); setAttemptSelections(v => ({ ...v, [activeId]: result.id })); setTranscript('hidden'); notify('已开始新一次练习，本次成绩单独记录。'); }
    catch (error) { notify((error as Error).message); }
  };
  const openPaper = (id: string, type?: PassageType) => { if (id !== activeId) { player.pause(); setActiveId(id); } if (type) { navigationIntent.current = { paperId: id, type, reveal: false }; setNavigationNonce(value => value + 1); } else setPassageId(''); go('practice'); };
  const selectSentence = (sentence: Sentence) => { setSelectedSentenceId(sentence.id); if (sentence.end > sentence.start) { player.setLoopMode('off'); player.seek(sentence.start); } else notify('这句话还没有有效时间轴，可在校对面板中补齐。'); };
  const saveAnnotation = async (annotation: Annotation) => {
    try { const result = await api<Annotation>(`/api/annotations/${encodeURIComponent(annotation.id)}`, 'PUT', annotation); setAnnotations(value => [...value.filter(item => item.id !== result.id), result]); notify(annotation.favorite ? '已保存到收藏与笔记。' : '笔记已保存。'); }
    catch (error) { notify((error as Error).message); }
  };
  const replayQuestion = (questionId: string, full = false) => {
    const question = paper?.questions.find(q => q.id === questionId), section = paper?.passages.find(p => p.id === question?.passageId);
    if (!question || !section) return;
    setPassageId(section.id);
    const evidence = section.sentences.filter(s => question.evidenceSentenceIds?.includes(s.id) && s.end > s.start);
    if (!full && !evidence.length) notify('这题的答案依据句还没有标注，先为你播放对应整篇。');
    if (full || !evidence.length) player.playRange(passagePlaybackStart(section), section.end);
    else { setSelectedSentenceId(evidence[0].id); player.playRange(Math.max(0, evidence[0].start - 2), Math.min(player.duration, evidence[evidence.length - 1].end + 2)); }
  };
  const openReview = async (paperId: string, questionId?: string, sentenceId?: string) => {
    try {
      const previous = [...attemptsRef.current].reverse().find(item => item.paperId === paperId && item.status === 'submitted');
      if (previous) setAttemptSelections(value => ({ ...value, [paperId]: previous.id }));
      else await ensureAttempt(true, paperId);
      navigationIntent.current = { paperId, questionId, sentenceId, reveal: true };
      if (paperId !== activeId) { player.pause(); setActiveId(paperId); }
      setNavigationNonce(value => value + 1); go('practice');
    } catch (error) { notify((error as Error).message); }
  };

  const readyCount = papers.filter(p => p.ready).length;
  const firsts = sortedAttempts.filter((a, index, all) => a.status === 'submitted' && a.mode === 'first' && !a.assisted && !all.slice(index + 1).some(b => b.paperId === a.paperId && b.status === 'submitted' && b.mode === 'first' && !b.assisted));
  const firstCorrect = firsts.reduce((sum, a) => sum + (a.result?.correct || 0), 0), firstTotal = firsts.reduce((sum, a) => sum + (a.result?.total || 0), 0);
  const selectedAnnotation = annotations.find(a => a.paperId === activeId && a.sentenceId === selectedSentence?.id);
  return (
    <div className="app-shell">
      <audio ref={player.audioRef} preload="metadata" aria-label="全局听力播放器" />
      <aside className="sidebar">
        <a className="brand" href="#library" aria-label="听见，返回真题库"><span className="brand-symbol"><AudioLines size={27} /></span><span>听见<span className="brand-dot">.</span><small>六级听力练习室</small></span></a>
        <div className="sidebar-label">学习空间 <span>WORKSPACE</span></div>
        <nav aria-label="主导航">
          {([{ key: 'library', icon: LayoutGrid }, { key: 'practice', icon: Headphones }, { key: 'review', icon: Bookmark }, { key: 'records', icon: TrendingUp }] as const).map(item => <button key={item.key} aria-label={PAGE_INFO[item.key][0]} title={PAGE_INFO[item.key][0]} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => go(item.key)}><item.icon size={19} /><span>{PAGE_INFO[item.key][0]}</span>{item.key === 'practice' && player.playing && <span className="playing-dot" />}{item.key === 'review' && annotations.filter(a => a.favorite).length > 0 && <span className="nav-count">{annotations.filter(a => a.favorite).length}</span>}</button>)}
        </nav>
        <div className="sidebar-tip"><span className="tip-icon"><Sparkles size={19} /></span><strong>把每一句，听明白。</strong><p>先盲听，再对照。<br />留一点时间给反复练习。</p><span className="tiny-line" /></div>
        <div className="sidebar-bottom"><span className={`local-indicator ${offline ? 'error' : ''}`} />{offline ? '本地服务未连接' : '本地资料 · 安心保存'}<button className="icon-button" title="切换浅色/深色模式" aria-label="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb">我的学习空间 <ChevronRight size={14} /> <span>{PAGE_INFO[page][0]}</span></div><div className="topbar-actions"><span className="local-tag"><ShieldCheck size={14} /> 仅在本机</span><button className="icon-button" aria-label="导入、备份与设置" onClick={() => setSettings(true)}><Settings2 size={19} /></button><span className="profile-avatar">听</span></div></header>
        <main className={`main-content ${page === 'practice' ? 'practice-main' : ''}`}>
          {loading ? <div className="loading-state"><LoaderCircle className="spin" size={28} /><h2>正在打开你的练习室</h2><p>读取本机题库和学习记录…</p></div> : offline ? <EmptyState icon={FolderOpen} title="练习室暂时没有连接" description="请保持本地服务窗口运行，再重新连接。已有资料与学习记录仍保存在电脑里。" action={<button className="button primary" onClick={() => { setLoading(true); void refresh(); }}>重新连接</button>} /> : <>
            {page === 'library' && <Library papers={papers} attempts={attempts} progress={progress} readyCount={readyCount} seconds={stats.listeningSeconds} firstAccuracy={percentage(firstCorrect, firstTotal)} onOpen={openPaper} onSettings={() => setSettings(true)} loadingPaperId={activeId && !paper ? activeId : ''} />}
            {page === 'practice' && <>
              {!paper ? <EmptyState icon={Headphones} title={activeId ? '正在读取这套资料' : '从一套真题开始'} description="在真题库选择年份和套题，然后进入你的练习工作台。" action={<button className="button primary" onClick={() => go('library')}>前往真题库 <ArrowRight size={16} /></button>} /> : <>
                <div className="practice-heading"><button className="back-link" onClick={() => go('library')}><ArrowLeft size={16} /> 真题库</button><div className="practice-title-row"><div><span className="eyebrow">{PAGE_INFO.practice[1]}</span><h1>{paper.title}</h1><p>{paper.originalPeriod ? `${paper.originalPeriod} · ` : ''}{paper.questions.length} 道题 · {paper.passages.length} 篇材料 <span className="dot-sep">·</span> {currentAttempt?.mode === 'review' ? '复习练习' : '首次练习'}{currentAttempt?.assisted && <span className="assist-badge">辅助练习</span>}</p></div><div className="heading-actions"><button className="button subtle" onClick={async () => { if (!inspector && currentAttempt?.status !== 'submitted') { try { await ensureAttempt(true); } catch (error) { notify((error as Error).message); return; } } if (activeIdRef.current === activeId) setInspector(!inspector); }}><SlidersHorizontal size={16} /> 资料与校对</button>{currentAttempt?.status === 'submitted' ? <button className="button primary" onClick={() => void newAttempt()}><RotateCcw size={16} /> 再练一次</button> : <button className="button primary" disabled={submitting || !paper.questions.length} onClick={() => void submit()}>{submitting ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} 交卷批改</button>}</div></div></div>
                {!paperReady(paper) && <div className="notice compact"><Info size={17} /><span>这套资料仍在整理，当前可练习已补齐的内容。{paper.quality.answers !== 'verified' ? '答案待核验，暂不进行正式批改。' : '逐句时间轴待人工校对，请留意播放边界。'}</span><QualityPills quality={paper.quality} compact /></div>}
                {currentAttempt?.status === 'submitted' && currentAttempt.result && <ResultBanner attempt={currentAttempt} />}
                {inspector && <TimingPanel paper={paper} selected={selectedSentence} onSaved={updated => { setCache(value => ({ ...value, [updated.id]: updated })); void api<PaperSummary[]>('/api/papers').then(setPapers); }} notify={notify} />}
                <div className={`workspace ${transcript === 'hidden' ? 'transcript-hidden' : ''}`}>
                  <aside className="passage-sidebar"><div className="panel-title">篇章目录 <span>{paper.passages.length.toString().padStart(2, '0')}</span></div><div role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') { setPassageId(''); player.setLoopMode('off'); player.seek(0); } }} className={`full-track ${!passageId ? 'selected' : ''}`} onClick={() => { setPassageId(''); player.setLoopMode('off'); player.seek(0); }}><FileAudio size={17} /><span>完整听力<small>{clock(player.duration || paper.duration)}</small></span><button className="mini-play" aria-label="播放完整听力" onClick={event => { event.stopPropagation(); player.setLoopMode('off'); player.seek(0); void player.play(); }}><Play size={13} fill="currentColor" /></button></div>
                    {(Object.keys(TYPE_LABEL) as PassageType[]).map(type => <div className="passage-group" key={type}><span className="section-label">{TYPE_LABEL[type]}</span>{paper.passages.filter(p => p.type === type).map(section => <button key={section.id} className={`passage-item ${passage?.id === section.id && passageId ? 'selected' : ''}`} onClick={() => { setPassageId(section.id); if (section.end > section.start) { player.setLoopMode('off'); player.seek(passagePlaybackStart(section)); } }}><span className="passage-number">{section.order.toString().padStart(2, '0')}</span><span>{section.title || `${TYPE_LABEL[type]} ${section.order}`}<small>{section.end > section.start ? `${clock(passagePlaybackStart(section))} — ${clock(section.end)}` : '时间轴待补齐'}</small></span>{section.end > section.start && <Play className="passage-play" size={13} onClick={event => { event.stopPropagation(); setPassageId(section.id); player.playRange(passagePlaybackStart(section), section.end); }} />}</button>)}</div>)}
                    <div className="keyboard-hint"><span>练习快捷键</span><p><kbd>空格</kbd> 播放 / 暂停</p><p><kbd>←</kbd><kbd>→</kbd> 前后 5 秒</p><p><kbd>↑</kbd><kbd>↓</kbd> 上 / 下一句</p></div>
                  </aside>
                  <section className="transcript-panel"><div className="panel-toolbar"><div><span className="section-label">INTENSIVE LISTENING</span><h3>{transcript === 'hidden' ? '专注听，先自己作答' : '逐句精听'}</h3></div><select aria-label="原文显示方式" value={transcript} onChange={event => void reveal(event.target.value as TranscriptMode)}><option value="hidden">隐藏原文</option><option value="english">仅英文</option><option value="bilingual">中英对照</option></select></div>
                    {transcript === 'hidden' ? <div className="blind-listening"><div className="sound-orbit"><span /><span /><Headphones size={38} strokeWidth={1.5} /></div><span className="eyebrow">LISTEN FIRST</span><h2>让耳朵，先走一步。</h2><p>不急着看原文。<br />完成作答后，再回来听懂每一句。</p><button className="button primary" disabled={!paper.audioAssetId} onClick={() => void player.play()}><Play size={16} fill="currentColor" />{player.position > 0 ? '继续听力' : '开始播放'}</button><button className="text-button" onClick={() => void reveal('english')}>显示英文原文 <ChevronRight size={14} /></button><small>交卷前查看原文会标记为辅助练习</small></div> : <><div className="transcript-options"><label className="toggle-label"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> 跟随播放</label><span>{paper.quality.timing === 'verified' ? '时间轴已核验' : '候选时间轴 · 待校对'}</span></div><Transcript passages={passageId && passage ? [passage] : paper.passages} activeId={player.currentSentence?.id} selectedId={selectedSentence?.id} mode={transcript} follow={follow} onSelect={selectSentence} favorites={annotations.filter(a => a.favorite).map(a => a.sentenceId || '')} onFavorite={sentence => void saveAnnotation({ id: `${activeId}:s:${sentence.id}`, paperId: activeId, sentenceId: sentence.id, text: annotations.find(a => a.sentenceId === sentence.id && a.paperId === activeId)?.text || '', reason: annotations.find(a => a.sentenceId === sentence.id && a.paperId === activeId)?.reason, favorite: !annotations.find(a => a.sentenceId === sentence.id && a.paperId === activeId)?.favorite, updatedAt: '' })} />
                      {selectedSentence && <NoteEditor key={`${activeId}:${selectedSentence.id}`} annotation={selectedAnnotation} paperId={activeId} sentence={selectedSentence} onSave={saveAnnotation} />}</>}
                  </section>
                  <section className="questions-panel"><div className="panel-toolbar"><div><span className="section-label">YOUR ANSWERS</span><h3>{currentAttempt?.status === 'submitted' ? '答题结果' : '听力试题'}</h3></div><span className="answer-progress">{Object.keys(currentAttempt?.answers || {}).length}<small> / {paper.questions.length}</small></span></div><div className="question-scroll">{paper.questions.length ? (passageId ? paper.questions.filter(q => q.passageId === passageId) : paper.questions).map(question => <div className="question-card" key={question.id}><div className="question-topline"><strong>Question {question.number.toString().padStart(2, '0')}</strong>{currentAttempt?.status === 'submitted' && <span className={currentAttempt.answers[question.id] === question.answer ? 'answer-correct' : 'answer-wrong'}>{currentAttempt.answers[question.id] === question.answer ? '回答正确' : currentAttempt.answers[question.id] ? '需要回听' : '未作答'}</span>}</div>{currentAttempt?.status === 'submitted' && question.prompt && <p className="question-prompt">{question.prompt}</p>}<div className="question-options">{OPTIONS.map(option => <button key={option} disabled={currentAttempt?.status === 'submitted'} className={`answer-option ${currentAttempt?.answers[question.id] === option ? 'chosen' : ''} ${currentAttempt?.status === 'submitted' && option === question.answer ? 'correct' : ''} ${currentAttempt?.status === 'submitted' && option === currentAttempt.answers[question.id] && option !== question.answer ? 'wrong' : ''}`} onClick={() => void answer(question.id, option)}><span className="option-letter">{option}</span><span>{question.options[option]}</span>{currentAttempt?.status === 'submitted' && option === question.answer && <Check size={15} />}</button>)}</div>{currentAttempt?.status === 'submitted' && <div className="explanation"><strong>正确答案 {question.answer || '待核验'}</strong>{question.explanation && <p>{question.explanation}</p>}<div className="replay-actions"><button className="text-button" onClick={() => replayQuestion(question.id)}><Volume2 size={14} /> 依据句回听</button><button className="text-button" onClick={() => replayQuestion(question.id, true)}>整篇回听</button></div>{currentAttempt.answers[question.id] !== question.answer && <select aria-label={`第${question.number}题错因`} value={annotations.find(a => a.questionId === question.id)?.reason || ''} onChange={event => void saveAnnotation({ id: `${activeId}:q:${question.id}`, paperId: activeId, questionId: question.id, text: '', favorite: false, reason: event.target.value, updatedAt: '' })}><option value="">标记错因…</option>{['词汇不认识', '连读没听清', '理解错误', '定位错误'].map(reason => <option key={reason}>{reason}</option>)}</select>}</div>}</div>) : <EmptyState icon={FileCheck2} title="试题待补齐" description="这套资料还没有完整选项。补齐后即可在这里作答。" />}</div><div className="draft-status"><span className="local-indicator" />{currentAttempt?.status === 'submitted' ? `交卷于 ${dateLabel(currentAttempt.submittedAt)}` : '选择答案后自动保存到本机'}</div></section>
                </div>
              </>}
            </>}
            {page === 'review' && <Review papers={papers} cache={cache} attempts={sortedAttempts} annotations={annotations} tab={reviewTab} setTab={setReviewTab} onOpen={openReview} onLibrary={() => go('library')} onDelete={async id => { try { await api(`/api/annotations/${encodeURIComponent(id)}`, 'DELETE'); setAnnotations(value => value.filter(a => a.id !== id)); } catch (error) { notify((error as Error).message); } }} />}
            {page === 'records' && <Records papers={papers} attempts={sortedAttempts} firsts={firsts} stats={stats} onOpen={(id, attemptId) => { if (attemptId) setAttemptSelections(value => ({ ...value, [id]: attemptId })); openPaper(id); }} onRefresh={() => void api<Stats>('/api/stats').then(setStats).catch(error => notify(error.message))} />}
          </>}
        </main>
      </div>
      <PlayerBar paper={paper} player={player} selectedSentence={selectedSentence || null} onOpen={() => go('practice')} />
      {settings && <SettingsModal onClose={() => setSettings(false)} notify={notify} onRefresh={async () => { await refresh(); if (activeId) { const updated = await api<Paper>(`/api/papers/${encodeURIComponent(activeId)}`); setCache(value => ({ ...value, [updated.id]: updated })); } }} beforeRestore={player.beginRestore} afterRestore={async () => { try { const restored = await api<Progress[]>('/api/progress'); setProgress(restored); player.restoreProgress(restored); } finally { player.endRestore(); } }} health={health} papers={papers} />}
      {toast && <div className="toast" role="status"><Info size={18} /><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={16} /></button></div>}
    </div>
  );
}

function QualityPills({ quality, compact = false }: { quality: Quality; compact?: boolean }) {
  return <div className={`quality-pills ${compact ? 'compact' : ''}`}>{qualityKeys.map(key => <span key={key} title={`${QUALITY_LABEL[key]}：${STATUS_LABEL[quality[key]]}`} className={`quality-pill ${quality[key]}`}>{quality[key] === 'verified' ? <Check size={10} /> : <span className="status-dot" />}{QUALITY_LABEL[key]}{!compact && <small>{STATUS_LABEL[quality[key]]}</small>}</span>)}</div>;
}

function EmptyState({ icon: Icon, title, description, action }: { icon: typeof Headphones; title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={30} strokeWidth={1.4} /></span><h2>{title}</h2><p>{description}</p>{action}</div>;
}

function ResultBanner({ attempt }: { attempt: Attempt }) {
  if (!attempt.result) return null;
  return <div className="result-banner"><span className="result-icon"><CheckCircle2 size={29} /></span><div><span className="eyebrow">本次练习完成{attempt.assisted ? ' · 辅助练习' : ''}</span><h3>答对 {attempt.result.correct} <small>/ {attempt.result.total} 题</small></h3></div><div className="result-breakdown">{(Object.keys(TYPE_LABEL) as PassageType[]).map(type => <span key={type}>{TYPE_LABEL[type]}<strong>{attempt.result!.byType[type]?.correct || 0}<small> / {attempt.result!.byType[type]?.total || 0}</small></strong></span>)}</div><span className="muted">{attempt.result.unanswered} 题未答 · 正确率 {percentage(attempt.result.correct, attempt.result.total)}</span></div>;
}

function Transcript({ passages, activeId, selectedId, mode, follow, onSelect, favorites, onFavorite }: { passages: Passage[]; activeId?: string; selectedId?: string; mode: TranscriptMode; follow: boolean; onSelect: (sentence: Sentence) => void; favorites: string[]; onFavorite: (sentence: Sentence) => void }) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (follow) activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [activeId, follow]);
  return <div className="transcript-scroll">{passages.length ? passages.map(section => <div className="transcript-section" key={section.id}>
    <div className="transcript-section-heading"><span>{section.order.toString().padStart(2, '0')}</span><h4>{section.title}</h4><small>{TYPE_LABEL[section.type]}</small></div>
    {section.sentences.length ? section.sentences.map((sentence, index) => {
      const paragraph = section.sourceParagraphs?.find(item => item.sourceId === sentence.sourceParagraphId);
      const showParagraph = mode === 'bilingual' && paragraph?.translation && !sentence.translation && section.sentences[index + 1]?.sourceParagraphId !== sentence.sourceParagraphId;
      return <div key={sentence.id} ref={sentence.id === activeId ? activeRef : null} className={['sentence', sentence.id === activeId ? 'current' : '', sentence.id === selectedId ? 'selected' : ''].join(' ')}>
        <button className="sentence-content" onClick={() => onSelect(sentence)}><span className="sentence-time">{sentence.end > sentence.start ? clock(sentence.start) : '--:--'}</span><span className="sentence-words">{sentence.text}{mode === 'bilingual' && sentence.translation && <span className="translation">{sentence.translation}</span>}</span></button>
        {showParagraph && <div className="paragraph-translation"><small>段落译文</small><p>{paragraph.translation}</p></div>}
        <button className={['sentence-bookmark', favorites.includes(sentence.id) ? 'saved' : ''].join(' ')} title="收藏这句话" aria-label="收藏这句话" onClick={() => onFavorite(sentence)}><Bookmark size={15} fill={favorites.includes(sentence.id) ? 'currentColor' : 'none'} /></button>
      </div>;
    }) : <p className="muted section-empty">这一篇的英文原文正在补齐。</p>}
  </div>) : <EmptyState icon={BookOpen} title="原文待补齐" description="导入配套资料后，可以在这里逐句精听。" />}</div>;
}

function NoteEditor({ annotation, paperId, sentence, onSave }: { annotation?: Annotation; paperId: string; sentence: Sentence; onSave: (annotation: Annotation) => Promise<void> }) {
  const [text, setText] = useState(annotation?.text || '');
  const [reason, setReason] = useState(annotation?.reason || '');
  return <div className="note-editor"><div><PencilLine size={14} /><strong>这一句的笔记</strong><span>{clock(sentence.start)}</span></div><textarea value={text} onChange={event => setText(event.target.value)} placeholder="记下没听清的词、连读，或你的理解…" rows={2} /><div className="note-actions"><select aria-label="句子错因" value={reason} onChange={event => setReason(event.target.value)}><option value="">添加错因标签</option>{['词汇不认识', '连读没听清', '理解错误', '定位错误'].map(item => <option key={item}>{item}</option>)}</select><button className="text-button" onClick={() => void onSave({ id: annotation?.id || `${paperId}:s:${sentence.id}`, paperId, sentenceId: sentence.id, text, reason, favorite: annotation?.favorite || false, updatedAt: '' })}>保存笔记 <Check size={13} /></button></div></div>;
}

function Library({ papers, attempts, progress, readyCount, seconds, firstAccuracy, onOpen, onSettings, loadingPaperId }: { papers: PaperSummary[]; attempts: Attempt[]; progress: Progress[]; readyCount: number; seconds: number; firstAccuracy: string; onOpen: (id: string, type?: PassageType) => void; onSettings: () => void; loadingPaperId: string }) {
  const [year, setYear] = useState('all'), [month, setMonth] = useState('all'), [status, setStatus] = useState('all'), [query, setQuery] = useState(''), [type, setType] = useState('all');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const years = [...new Set(papers.map(p => p.year))].sort((a, b) => b - a);
  const completed = new Set(attempts.filter(a => a.status === 'submitted').map(a => a.paperId));
  const started = new Set(attempts.map(a => a.paperId));
  const shown = [...papers].filter(p => (year === 'all' || p.year === +year) && (month === 'all' || p.month === +month) && (!query || `${p.title} ${p.year} ${p.variant}`.toLowerCase().includes(query.toLowerCase())) && (type === 'all' || p.passageCount > 0) && (status === 'all' || status === 'ready' && p.ready || status === 'unfinished' && started.has(p.id) && !completed.has(p.id) || status === 'completed' && completed.has(p.id) || status === 'new' && !started.has(p.id) || status === 'pending' && !p.ready)).sort((a, b) => b.year - a.year || b.month - a.month || String(a.variant).localeCompare(String(b.variant)));
  const recentProgress = [...progress].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find(item => (item.position > 0 || started.has(item.paperId)) && papers.some(p => p.id === item.paperId && p.audioAssetId));
  const recent = papers.find(p => p.id === recentProgress?.paperId);
  const resume = recent || papers.find(p => p.audioAssetId);
  return <>
    <div className="page-heading"><div><span className="eyebrow">{PAGE_INFO.library[1]}</span><h1>每一次认真听，<span>都算数。</span></h1><p>从历年真题出发，找到你的听力节奏。</p></div><button className="button outlined" onClick={onSettings}><Upload size={16} /> 导入资料</button></div>
    <div className="library-hero"><div className="hero-copy"><span className="hero-label"><span /> CET–6 LISTENING STUDIO</span><h2>听得懂的，<br />才是自己的。</h2><p>整套练习建立节奏，逐句精听找到细节。<br />你的六级听力，值得一个专注的空间。</p><button className="button warm" onClick={() => resume ? onOpen(resume.id) : onSettings()}><Play size={15} fill="currentColor" />{recent ? '继续上次练习' : resume ? '开始第一套练习' : '导入第一套资料'}<ArrowRight size={15} /></button>{resume && <span className="hero-resume-label">{resume.title}{recentProgress && recent ? ` · 已听至 ${clock(recentProgress.position)}` : ''}</span>}</div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="record-disc"><div className="record-groove" /><div className="record-center"><AudioLines size={42} strokeWidth={1.4} /></div></div><div className="art-small-note">LISTEN A LITTLE.<br /><b>GROW A LITTLE.</b></div><div className="art-spark">✦</div><span className="art-caption">A SPACE FOR YOUR EARS.</span></div></div>
    <div className="stat-strip"><div><span className="stat-icon blue"><BookOpen size={21} /></span><span><small>历年资料</small><strong>{papers.length}<em>套</em></strong></span><span className="stat-detail">{years.length ? `${Math.min(...years)} — ${Math.max(...years)}` : '等待导入'}</span></div><div><span className="stat-icon orange"><CheckCircle2 size={21} /></span><span><small>已完成练习</small><strong>{completed.size}<em>套</em></strong></span><span className="stat-detail">每一步都有记录</span></div><div><span className="stat-icon green"><Clock3 size={21} /></span><span><small>累计听力</small><strong>{Math.floor(seconds / 60)}<em>分钟</em></strong></span><span className="stat-detail">真实播放时长</span></div><div><span className="stat-icon purple"><TrendingUp size={21} /></span><span><small>首次正确率</small><strong>{firstAccuracy}</strong></span><span className="stat-detail">仅未查看提示的练习</span></div></div>
    <div className="collection-heading"><div><span className="eyebrow">THE COLLECTION</span><h2>历年六级真题 <span>{papers.length}</span></h2></div><div className="collection-tools"><div className="search-field"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索年份或套题…" aria-label="搜索真题" />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}</div><div className="view-toggle"><button className={layout === 'grid' ? 'active' : ''} aria-label="卡片视图" onClick={() => setLayout('grid')}><LayoutGrid size={16} /></button><button className={layout === 'list' ? 'active' : ''} aria-label="列表视图" onClick={() => setLayout('list')}><ListFilter size={17} /></button></div></div></div>
    <div className="filter-row"><div className="year-tabs"><button className={year === 'all' ? 'active' : ''} onClick={() => setYear('all')}>全部年份</button>{years.map(y => <button key={y} className={year === String(y) ? 'active' : ''} onClick={() => setYear(String(y))}>{y}{y === 2026 && <i />}</button>)}</div><div className="filter-selects"><select aria-label="按月份筛选" value={month} onChange={event => setMonth(event.target.value)}><option value="all">全部月份</option>{[3, 6, 7, 9, 12].map(m => <option key={m} value={m}>{m} 月</option>)}</select><select aria-label="按题型筛选" value={type} onChange={event => setType(event.target.value)}><option value="all">全部题型</option>{(Object.keys(TYPE_LABEL) as PassageType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select><select aria-label="按练习状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="ready">已核验资料</option><option value="new">尚未练习</option><option value="unfinished">练习中</option><option value="completed">已完成</option><option value="pending">资料待校对</option></select></div></div>
    <div className="coverage-notice"><div><FolderOpen size={17} /><span>资料整理进度 <strong>{readyCount} / {papers.length}</strong> 套已完整核验</span><span className="coverage-line"><i style={{ width: `${papers.length ? readyCount / papers.length * 100 : 0}%` }} /></span></div><span>{readyCount === papers.length && papers.length ? '目标资料已核验' : '音频、试题、答案、原文、时间轴均核验后计入完成'}</span></div>
    {shown.length ? <div className={`paper-grid ${layout === 'list' ? 'paper-list' : ''}`}>{shown.map((item, index) => {
      const recentAttempt = [...attempts].filter(a => a.paperId === item.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const played = progress.find(p => p.paperId === item.id);
      const available = !!item.audioAssetId;
      return <article className="paper-card" key={item.id}><div className={`paper-art tone-${index % 4}`}><span className="paper-art-year">{item.year}<small>{String(item.month).padStart(2, '0')} / CET 6</small></span><span className="paper-art-icon"><AudioLines size={36} strokeWidth={1.2} /></span><span className="paper-art-lines"><i /><i /><i /><i /><i /><i /><i /></span><span className={`paper-status ${item.ready ? 'ready' : available ? 'candidate' : 'missing'}`}>{item.ready ? <Check size={11} /> : available ? <Clock3 size={11} /> : <FolderOpen size={11} />}{item.ready ? '已完整核验' : available ? '资料待校对' : '资料待补齐'}</span></div><div className="paper-card-body"><div className="paper-card-top"><span className="paper-kicker">{item.year} 年 · {item.month} 月</span>{completed.has(item.id) && <span className="completed-mini"><CheckCircle2 size={12} /> 已练习</span>}</div><h3>{item.title}</h3><p className="paper-meta"><Headphones size={13} />{item.duration > 0 ? `${Math.round(item.duration / 60)} 分钟` : '音频待补齐'}<span>·</span>{item.questionCount} 道题<span>·</span>{item.passageCount} 篇</p><QualityPills quality={item.quality} compact /><div className="card-bottom"><span>{recentAttempt?.status === 'submitted' ? `最近答对 ${recentAttempt.result?.correct || 0}/${recentAttempt.result?.total || 25}` : played && played.position > 0 ? `上次听至 ${clock(played.position)}` : available ? '从这里开始，听懂每一句' : '可查看来源与资料状态'}</span><button className="card-play" aria-label={`打开${item.title}`} onClick={() => onOpen(item.id, type === 'all' ? undefined : type as PassageType)}>{loadingPaperId === item.id ? <LoaderCircle size={16} className="spin" /> : available ? <Play size={14} fill="currentColor" /> : <ChevronRight size={17} />}</button></div></div></article>;
    })}</div> : <EmptyState icon={Search} title={papers.length ? '还没有符合条件的资料' : '你的真题库，准备就绪'} description={papers.length ? '试着更换年份、状态，或清空搜索条件。' : '导入公开真题资料后，音频、试题和原文会一起出现在这里。'} action={<button className="button outlined" onClick={() => { if (!papers.length) onSettings(); else { setYear('all'); setMonth('all'); setStatus('all'); setQuery(''); } }}>{papers.length ? '重置筛选' : '导入资料'}</button>} />}
    <div className="page-footnote"><span className="small-brand"><AudioLines size={15} /> 听见</span><span>专注于学习本身。资料与进度，保存在你的电脑。</span><span>共 {shown.length} 套资料</span></div>
  </>;
}

function PlayerBar({ paper, player, selectedSentence, onOpen }: { paper: Paper | null; player: AudioController; selectedSentence: Sentence | null; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const moveSentence = (direction: number) => {
    const sentences = paper?.passages.flatMap(p => p.sentences).filter(s => s.end > s.start) || [];
    const index = sentences.findIndex(s => s.id === (player.currentSentence?.id || selectedSentence?.id));
    const next = sentences[Math.max(0, Math.min(sentences.length - 1, index + direction))];
    if (next) { player.setLoopMode('off'); player.seek(next.start); }
  };
  return <footer className="player-bar"><div className="player-track" onClick={onOpen} role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') onOpen(); }}><span className={`track-art ${player.playing ? 'is-playing' : ''}`}><AudioLines size={24} /></span><div><strong>{paper?.title || '选择一套真题，开始认真听。'}</strong><small>{player.waiting ? `句间停顿 ${player.gap} 秒` : paper?.audioAssetId ? player.currentSentence ? '逐句精听 · 跟上每一句的节奏' : '本地音频 · 进度自动保存' : '本地听力练习室'}</small></div></div><div className="player-center"><div className="play-controls"><button className="icon-button" disabled={!paper?.audioAssetId} title="快退 5 秒" aria-label="快退5秒" onClick={() => player.seek(player.position - 5)}><span className="seconds-icon"><RotateCcw size={19} /><i>5</i></span></button><button className="icon-button" disabled={!paper?.audioAssetId} title="上一句" aria-label="上一句" onClick={() => moveSentence(-1)}><SkipBack size={19} /></button><button className="main-play" disabled={!paper?.audioAssetId} aria-label={player.playing || player.waiting ? '暂停播放' : '播放听力'} onClick={() => player.playing || player.waiting ? player.pause() : void player.play()}>{player.playing || player.waiting ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><button className="icon-button" disabled={!paper?.audioAssetId} title="下一句" aria-label="下一句" onClick={() => moveSentence(1)}><SkipForward size={19} /></button><button className="icon-button" disabled={!paper?.audioAssetId} title="快进 5 秒" aria-label="快进5秒" onClick={() => player.seek(player.position + 5)}><span className="seconds-icon forward"><RotateCcw size={19} /><i>5</i></span></button></div><div className="play-timeline"><span>{clock(player.position)}</span><input aria-label="播放进度" type="range" min="0" max={player.duration || 1} step="0.1" value={Math.min(player.position, player.duration || 1)} onChange={event => player.seek(+event.target.value)} style={{ '--progress': `${player.duration ? player.position / player.duration * 100 : 0}%` } as React.CSSProperties} /><span>{clock(player.duration)}</span></div></div><div className="player-tools"><select aria-label="播放倍速" value={player.rate} onChange={event => player.setRate(+event.target.value)}>{[0.75, 0.9, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate.toFixed(rate === 1 || rate === 2 ? 1 : 2).replace(/0$/, rate === 1 || rate === 2 ? '0' : '')}×</option>)}</select><button className={`loop-button ${player.loopMode !== 'off' ? 'active' : ''}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Repeat size={18} /><span>{player.loopMode === 'off' ? '复读' : player.loopMode === 'sentence' ? '单句复读' : player.loopMode === 'ab' ? 'A–B 复读' : '整套循环'}</span><ChevronDown size={12} /></button></div>{expanded && <div className="loop-popover"><div className="popover-title"><strong>让细节再清楚一点</strong><button className="icon-button" aria-label="关闭复读控制" onClick={() => setExpanded(false)}><X size={16} /></button></div><div className="loop-modes">{(['off', 'sentence', 'ab', 'all'] as const).map(mode => <button key={mode} className={player.loopMode === mode ? 'active' : ''} onClick={() => { if (mode === 'sentence') player.loopSentence(selectedSentence || player.currentSentence); else if (mode === 'ab') player.startAB(); else player.setLoopMode(mode); }}>{({ off: '顺序播放', sentence: '单句复读', ab: 'A–B 复读', all: '整套循环' })[mode]}</button>)}</div><div className="loop-row"><label>单句播放次数<select value={player.repeatCount} onChange={event => player.setRepeatCount(+event.target.value)}>{[1, 3, 5, 0].map(count => <option key={count} value={count}>{count ? `${count} 次` : '无限次'}</option>)}</select></label><label>句间停顿<select value={player.gap} onChange={event => player.setGap(+event.target.value)}>{[0, 1, 2, 3].map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label></div><div className="ab-controls"><div><button onClick={() => player.setAB(player.position, player.b)}>设置 A</button><label>A<input aria-label="A点秒数" type="number" min="0" step="0.1" value={player.a === null ? '' : Math.round(player.a * 100) / 100} onChange={event => player.setAB(event.target.value === '' ? null : +event.target.value, player.b)} /></label></div><div><button onClick={() => player.setAB(player.a, player.position)}>设置 B</button><label>B<input aria-label="B点秒数" type="number" min="0" step="0.1" value={player.b === null ? '' : Math.round(player.b * 100) / 100} onChange={event => player.setAB(player.a, event.target.value === '' ? null : +event.target.value)} /></label></div></div><p>位置单位为秒，可微调。有限次单句复读结束后暂停。</p><button className="button primary full-width" disabled={!paper?.audioAssetId} onClick={() => player.startAB()}><Repeat size={14} /> 播放 A–B 区间</button></div>}</footer>;
}

function Review({ papers, cache, attempts, annotations, tab, setTab, onOpen, onLibrary, onDelete }: { papers: PaperSummary[]; cache: Record<string, Paper>; attempts: Attempt[]; annotations: Annotation[]; tab: 'wrong' | 'favorite' | 'notes'; setTab: (tab: 'wrong' | 'favorite' | 'notes') => void; onOpen: (paperId: string, questionId?: string, sentenceId?: string) => Promise<void>; onLibrary: () => void; onDelete: (id: string) => Promise<void> }) {
  const [filter, setFilter] = useState('all');
  const latest = attempts.filter((a, index, all) => a.status === 'submitted' && !all.slice(0, index).some(b => b.paperId === a.paperId && b.status === 'submitted'));
  const wrong = latest.flatMap(a => (cache[a.paperId]?.questions || []).filter(q => q.answer && a.answers[q.id] !== q.answer).map(q => ({ attempt: a, question: q })));
  const favorites = annotations.filter(a => a.favorite), notes = annotations.filter(a => a.text || a.reason);
  const list = (tab === 'favorite' ? favorites : notes).filter(a => filter === 'all' || a.paperId === filter);
  return <><div className="page-heading"><div><span className="eyebrow">{PAGE_INFO.review[1]}</span><h1>把没听懂的，<span>慢慢听懂。</span></h1><p>每一道错题、每一句收藏，都是下一次进步的起点。</p></div><span className="page-count"><Bookmark size={20} /> {favorites.length} 句收藏</span></div><div className="review-summary"><div><strong>{wrong.length}</strong><span>待回听错题</span></div><div><strong>{favorites.length}</strong><span>值得再听的句子</span></div><div><strong>{notes.length}</strong><span>笔记与错因</span></div><p><Headphones size={27} strokeWidth={1.3} />听懂一句，就多一点笃定。</p></div><div className="review-toolbar"><div className="segment-tabs">{([{ id: 'wrong', label: '错题回听', count: wrong.length }, { id: 'favorite', label: '句子收藏', count: favorites.length }, { id: 'notes', label: '我的笔记', count: notes.length }] as const).map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}<span>{item.count}</span></button>)}</div><select aria-label="按套题筛选复习" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部套题</option>{papers.filter(p => attempts.some(a => a.paperId === p.id) || annotations.some(a => a.paperId === p.id)).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>{tab === 'wrong' ? wrong.filter(item => filter === 'all' || item.attempt.paperId === filter).length ? <div className="review-grid">{wrong.filter(item => filter === 'all' || item.attempt.paperId === filter).map(({ attempt, question }) => <article className="review-card" key={`${attempt.id}:${question.id}`}><div className="review-card-meta"><span>{papers.find(p => p.id === attempt.paperId)?.title}</span><span className="wrong-tag">第 {question.number} 题</span></div><h3>{question.prompt || `Question ${question.number.toString().padStart(2, '0')}`}</h3><div className="review-answer"><span>你的答案 <b>{attempt.answers[question.id] || '未作答'}</b></span><span>正确答案 <b className="answer-correct">{question.answer}</b></span></div><p>{question.explanation || question.options[question.answer!]}</p><div className="review-card-footer"><span>{annotations.find(a => a.questionId === question.id)?.reason || '尚未标记错因'}</span><button className="button subtle" onClick={() => void onOpen(attempt.paperId, question.id)}><Headphones size={15} /> 回到原文</button></div></article>)}</div> : <EmptyState icon={CheckCircle2} title="还没有待回听的错题" description="完成一次听力练习并交卷后，错题会自动整理到这里。" action={<button className="button primary" onClick={onLibrary}>去练一套 <ArrowRight size={15} /></button>} /> : list.length ? <div className="review-grid">{list.map(annotation => {
    const sentence = cache[annotation.paperId]?.passages.flatMap(p => p.sentences).find(s => s.id === annotation.sentenceId);
    const question = cache[annotation.paperId]?.questions.find(q => q.id === annotation.questionId);
    return <article className="review-card sentence-review-card" key={annotation.id}><div className="review-card-meta"><span>{papers.find(p => p.id === annotation.paperId)?.title || annotation.paperId}</span>{annotation.favorite && <Bookmark size={15} fill="currentColor" />}</div><h3>{sentence?.text || (question ? `Question ${question.number}` : '笔记')}</h3>{sentence?.translation && <p>{sentence.translation}</p>}{annotation.text && <blockquote>{annotation.text}</blockquote>}{annotation.reason && <span className="reason-tag">{annotation.reason}</span>}<div className="review-card-footer"><button className="text-button muted" onClick={() => void onDelete(annotation.id)}>移除记录</button><button className="button subtle" onClick={() => void onOpen(annotation.paperId, annotation.questionId, annotation.sentenceId)}><Play size={14} /> 回到这句</button></div></article>;
  })}</div> : <EmptyState icon={Bookmark} title={tab === 'favorite' ? '留住值得再听的一句' : '给你的理解，留个位置'} description={tab === 'favorite' ? '在精听原文中点击书签，就能把句子收藏到这里。' : '在原文下方写下笔记，或给错题添加一个错因标签。'} action={<button className="button outlined" onClick={onLibrary}>打开真题库</button>} />}</>;
}

function Records({ papers, attempts, firsts, stats, onOpen, onRefresh }: { papers: PaperSummary[]; attempts: Attempt[]; firsts: Attempt[]; stats: Stats; onOpen: (id: string, attemptId?: string) => void; onRefresh: () => void }) {
  const submitted = attempts.filter(a => a.status === 'submitted');
  const firstCorrect = firsts.reduce((sum, a) => sum + (a.result?.correct || 0), 0), firstTotal = firsts.reduce((sum, a) => sum + (a.result?.total || 0), 0);
  return <><div className="page-heading"><div><span className="eyebrow">{PAGE_INFO.records[1]}</span><h1>你的认真，<span>有迹可循。</span></h1><p>看见练习积累，也找到下一步的方向。</p></div><button className="button outlined" onClick={onRefresh}><RotateCcw size={15} /> 更新时长</button></div><div className="record-metrics"><div><span>累计实际听力</span><strong>{Math.floor(stats.listeningSeconds / 60)}<small> 分钟</small></strong><p>{clock(stats.listeningSeconds)} · 仅统计真实播放</p></div><div><span>已提交练习</span><strong>{submitted.length}<small> 次</small></strong><p>已练 {new Set(submitted.map(a => a.paperId)).size} 套不同真题</p></div><div><span>首次正确率</span><strong>{percentage(firstCorrect, firstTotal)}</strong><p>{firsts.length} 次首次独立练习</p></div></div><div className="records-two-col"><section className="white-panel"><div className="section-heading"><h3>分题型表现</h3><span>首次独立作答</span></div>{(Object.keys(TYPE_LABEL) as PassageType[]).map(type => {
    const correct = firsts.reduce((sum, a) => sum + (a.result?.byType[type]?.correct || 0), 0), total = firsts.reduce((sum, a) => sum + (a.result?.byType[type]?.total || 0), 0);
    return <div className="type-performance" key={type}><div><span>{TYPE_LABEL[type]}</span><strong>{percentage(correct, total)}</strong></div><div className="performance-track"><i style={{ width: `${total ? correct / total * 100 : 0}%` }} /></div><small>{correct} / {total} 题</small></div>;
  })}</section><section className="white-panel"><div className="section-heading"><h3>最近在听</h3><Headphones size={18} /></div>{Object.entries(stats.byPaper).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, seconds]) => <button className="listening-row" key={id} onClick={() => onOpen(id)}><span className="listening-row-icon"><AudioLines size={20} /></span><span><strong>{papers.find(p => p.id === id)?.title || id}</strong><small>累计 {Math.floor(seconds / 60)} 分 {Math.floor(seconds % 60)} 秒</small></span><ChevronRight size={16} /></button>)}{!Object.keys(stats.byPaper).length && <p className="muted panel-empty">播放第一段听力，积累就从这一刻开始。</p>}</section></div><section className="white-panel attempts-panel"><div className="section-heading"><h3>每一次练习</h3><span>{attempts.length} 条记录 · 草稿实时保存</span></div>{attempts.length ? <div className="table-scroll"><table><thead><tr><th>练习资料</th><th>时间</th><th>练习类型</th><th>作答结果</th><th>状态</th><th /></tr></thead><tbody>{attempts.map(a => <tr key={a.id}><td><strong>{papers.find(p => p.id === a.paperId)?.title || a.paperId}</strong></td><td>{dateLabel(a.submittedAt || a.createdAt)}</td><td>{a.mode === 'first' ? '首次练习' : '复习练习'}{a.assisted && <small className="assist-badge">辅助</small>}</td><td>{a.status === 'submitted' ? `${a.result?.correct || 0} / ${a.result?.total || 25} · ${percentage(a.result?.correct || 0, a.result?.total || 25)}` : `${Object.keys(a.answers).length} 题已作答`}</td><td><span className={`table-status ${a.status}`}>{a.status === 'submitted' ? '已交卷' : '草稿'}</span></td><td><button className="text-button" onClick={() => onOpen(a.paperId, a.id)}>查看 <ArrowRight size={13} /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={TrendingUp} title="记录从第一套开始" description="每次作答、每段播放都会保存在这里。" />}</section><p className="record-note"><Info size={14} />首次正确率只计算未看提示的首次作答。复习与辅助练习单独记录；这里的正确率不是官方报道分。</p></>;
}

function SettingsModal({ onClose, notify, onRefresh, beforeRestore, afterRestore, health, papers }: { onClose: () => void; notify: (message: string) => void; onRefresh: () => Promise<void>; beforeRestore: () => Promise<void>; afterRestore: () => Promise<void>; health: Health | null; papers: PaperSummary[] }) {
  const [tab, setTab] = useState<'backup' | 'import' | 'coverage'>('backup');
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<{ name: string; size: number; createdAt: string }[]>([]);
  const [paperFile, setPaperFile] = useState<File | null>(null), [audioFile, setAudioFile] = useState<File | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api<typeof backups>('/api/backups').then(setBackups).catch(error => notify(error.message));
    const previous = document.activeElement as HTMLElement;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select, textarea') || [])];
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1]?.focus(); }
        else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0]?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey); return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [notify, onClose]);
  const restore = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { const data = JSON.parse(await file.text()); await beforeRestore(); await api('/api/backup/import', 'POST', data); await onRefresh(); notify('学习记录已恢复，恢复前的记录已自动备份。'); }
    catch (error) { notify(`恢复未完成：${(error as Error).message}`); }
    finally { try { await afterRestore(); } catch (error) { notify((error as Error).message); } setBusy(false); if (restoreInput.current) restoreInput.current.value = ''; }
  };
  const importPaper = async () => {
    if (!paperFile) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(await paperFile.text());
      const importedPaper = parsed.paper || parsed;
      let audioBase64: string | undefined;
      if (audioFile) {
        if (audioFile.size > 100 * 1024 * 1024) throw new Error('单份音频请控制在 100 MB 以内。');
        audioBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('音频读取失败')); reader.readAsDataURL(audioFile); });
      }
      await api('/api/import', 'POST', { paper: importedPaper, audioBase64, audioName: audioFile?.name }); await onRefresh(); notify('资料已导入，本套已有学习记录会保留。'); setPaperFile(null); setAudioFile(null);
    } catch (error) { notify(`导入未完成：${(error as Error).message}`); }
    finally { setBusy(false); }
  };
  const download = async (url: string, filename: string) => {
    if (url === '/api/backup/full') {
      // Let the browser receive the ZIP stream directly; the corpus can be
      // several gigabytes and should not be assembled as a page-owned Blob.
      const link = document.createElement('a');
      link.href = url; link.download = filename; document.body.append(link);
      link.click(); link.remove();
      notify('正在导出完整资料包，请在浏览器下载记录中查看进度。');
      return;
    }
    setBusy(true);
    try { const result = await fetch(url); if (!result.ok) throw new Error((await result.json().catch(() => ({}))).error || '导出失败'); const objectUrl = URL.createObjectURL(await result.blob()); const link = document.createElement('a'); link.href = objectUrl; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); notify('资料已准备好，请在浏览器下载记录中查看。'); }
    catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={dialogRef}><div className="modal-heading"><div><span className="eyebrow">YOUR LOCAL SPACE</span><h2 id="settings-title">资料与设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={20} /></button></div><div className="segment-tabs modal-tabs">{([{ id: 'backup', label: '记录与备份' }, { id: 'import', label: '导入真题' }, { id: 'coverage', label: '资料完整度' }] as const).map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</div><div className="modal-content">{busy && <div className="modal-busy"><LoaderCircle className="spin" size={17} /> 正在处理，请稍候…</div>}{tab === 'backup' && <><div className="local-data-note"><ShieldCheck size={23} /><div><strong>你的积累，留在本机。</strong><p>作答、进度、收藏和笔记保存到电脑，清理浏览器缓存不会清除学习记录。</p></div></div><div className="setting-action"><span className="setting-action-icon"><ArrowDownToLine size={21} /></span><div><strong>导出学习记录</strong><p>轻量 JSON 文件，包含作答、进度、收藏及笔记。</p></div><button className="button outlined" disabled={busy} onClick={() => void download('/api/backup/export', `听见-学习记录-${new Date().toISOString().slice(0, 10)}.json`)}>导出 JSON</button></div><div className="setting-action"><span className="setting-action-icon"><FolderOpen size={21} /></span><div><strong>完整资料包</strong><p>将本机音频、题库、学习记录一并保存为 ZIP。</p></div><button className="button outlined" disabled={busy} onClick={() => void download('/api/backup/full', '听见-完整资料备份.zip')}>导出 ZIP</button></div><div className="setting-action"><span className="setting-action-icon"><RotateCcw size={21} /></span><div><strong>恢复学习记录</strong><p>按记录编号合并；导入之前自动保存当前记录。</p></div><button className="button outlined" disabled={busy} onClick={() => restoreInput.current?.click()}>选择 JSON</button><input hidden type="file" ref={restoreInput} accept=".json,application/json" onChange={event => void restore(event.target.files?.[0])} /></div><div className="backup-list"><div className="section-heading"><h3>自动备份</h3><span>每日首次启动 · 保留最近 7 份</span></div>{backups.length ? backups.slice(0, 7).map(backup => <div key={backup.name}><FileCheck2 size={15} /><span>{dateLabel(backup.createdAt)}</span><small>{(backup.size / 1024).toFixed(1)} KB</small><CheckCircle2 size={14} /></div>) : <p className="muted">首次启动后会在本机建立备份。</p>}</div></>}{tab === 'import' && <><p className="settings-intro">导入配套试卷文件和原始音频，建立你自己的真题资料。支持 MP3、M4A、WAV 等浏览器可播放的音频格式。</p><label className="file-drop"><FileCheck2 size={28} /><strong>{paperFile?.name || '选择试卷 JSON 文件'}</strong><span>包含考试信息、25 道题、原文与句子时间轴</span><input type="file" accept=".json,application/json" onChange={event => setPaperFile(event.target.files?.[0] || null)} /></label><label className="file-drop secondary"><FileAudio size={25} /><strong>{audioFile?.name || '选择配套音频（可选）'}</strong><span>单文件最大 100 MB · 相同音频自动去重</span><input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" onChange={event => setAudioFile(event.target.files?.[0] || null)} /></label><div className="notice"><Info size={16} /><span>导入文件需与本项目资料格式一致，可参考 data/papers 中的文件。缺少核验的内容会保留“待校对”状态；导入不会覆盖已有学习记录。</span></div><button className="button primary full-width" disabled={!paperFile || busy} onClick={() => void importPaper()}><Upload size={16} />导入这套资料</button></>}{tab === 'coverage' && <><div className="coverage-large"><span><strong>{papers.filter(p => p.ready).length}</strong> / {papers.length}</span><h3>套资料完成全部核验</h3><p>完整音频、25 道题、答案、英文原文、逐句时间轴。</p></div><div className="coverage-table">{[2020, 2021, 2022, 2023, 2024, 2025, 2026].map(year => { const rows = papers.filter(p => p.year === year); return <div key={year}><strong>{year}<small>{year === 2026 ? '6 月增补' : '完整年份'}</small></strong><span>{rows.length} 套目录</span><span>{rows.filter(p => p.audioAssetId).length} 套有音频</span><span className="answer-correct">{rows.filter(p => p.ready).length} 套已核验</span></div>; })}</div><div className="notice"><Info size={16} /><span>目录中有条目不代表资料齐全。候选时间轴需要逐句校对，未核验的答案不会进行正式批改。</span></div></>}</div><div className="modal-footer"><span className="local-indicator" /><span>听见 v{health?.version || '0.1.0'} · 本机应用</span><span>所有资源只供你的学习整理</span></div></div></div>;
}

function TimingPanel({ paper, selected, onSaved, notify }: { paper: Paper; selected: Sentence | null | undefined; onSaved: (paper: Paper) => void; notify: (message: string) => void }) {
  const [passages, setPassages] = useState<Passage[]>(() => structuredClone(paper.passages));
  const [editingId, setEditingId] = useState(selected?.id || paper.passages.flatMap(p => p.sentences)[0]?.id || '');
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const section = passages.find(p => p.sentences.some(s => s.id === editingId));
  const sentence = section?.sentences.find(s => s.id === editingId);
  const allSentences = passages.flatMap(p => p.sentences), reviewed = allSentences.filter(s => s.reviewed && s.end > s.start).length;
  useEffect(() => { if (selected?.id) setEditingId(selected.id); }, [selected?.id]);
  const editSentence = (change: Partial<Sentence>) => { setPassages(value => value.map(p => ({ ...p, sentences: p.sentences.map(s => s.id === editingId ? { ...s, ...change } : s) }))); setDirty(true); };
  const editSection = (change: Partial<Passage>) => { setPassages(value => value.map(p => p.id === section?.id ? { ...p, ...change } : p)); setDirty(true); };
  const save = async (markVerified: boolean) => {
    setBusy(true);
    try { const updated = await api<Paper>(`/api/papers/${encodeURIComponent(paper.id)}/timing`, 'PUT', { passages, markVerified }); onSaved(updated); setPassages(structuredClone(updated.passages)); setDirty(false); notify(markVerified ? '原文与时间轴已由人工逐句确认，资料状态已更新。' : '时间轴已保存，原文件已自动备份。'); }
    catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="timing-panel"><div className="section-heading"><div><h3><SlidersHorizontal size={18} /> 资料检查与逐句校对</h3><p>音频版本、句子时间及核验状态始终对应这套原始录音。</p></div><QualityPills quality={paper.quality} /></div><div className="timing-source"><strong>资料来源</strong>{paper.sources.length ? paper.sources.map((source, index) => <a key={`${source.url}:${index}`} href={source.url} target="_blank" rel="noreferrer">{source.label || source.kind} <ArrowRight size={12} /></a>) : <span className="muted">来源待补齐</span>}</div>{paper.notes?.length ? <div className="paper-notes">{paper.notes.map((note, index) => <p key={index}>{note}</p>)}</div> : null}{sentence && section ? <><div className="timing-navigation"><select aria-label="选择待校对句子" value={editingId} onChange={event => setEditingId(event.target.value)}>{passages.map(p => <optgroup key={p.id} label={p.title}>{p.sentences.map((s, index) => <option key={s.id} value={s.id}>{s.reviewed ? '✓ ' : ''}{index + 1}. {s.text.slice(0, 70)}</option>)}</optgroup>)}</select><button className="icon-button" aria-label="上一条校对句子" onClick={() => setEditingId(allSentences[Math.max(0, allSentences.findIndex(s => s.id === editingId) - 1)].id)}><ChevronLeft size={17} /></button><button className="icon-button" aria-label="下一条校对句子" onClick={() => setEditingId(allSentences[Math.min(allSentences.length - 1, allSentences.findIndex(s => s.id === editingId) + 1)].id)}><ChevronRight size={17} /></button><span>{reviewed} / {allSentences.length} 句已人工确认</span></div><div className="timing-fields"><label>句子起点（秒）<input aria-label="句子起点" type="number" min="0" step="0.05" value={sentence.start} onChange={event => editSentence({ start: +event.target.value, reviewed: false })} /></label><label>句子终点（秒）<input aria-label="句子终点" type="number" min="0" step="0.05" value={sentence.end} onChange={event => editSentence({ end: +event.target.value, reviewed: false })} /></label><label>本篇起点（秒）<input type="number" min="0" step="0.05" value={section.start} onChange={event => editSection({ start: +event.target.value })} /></label><label>本篇终点（秒）<input type="number" min="0" step="0.05" value={section.end} onChange={event => editSection({ end: +event.target.value })} /></label></div><div className="timing-text"><label>英文原文<textarea rows={2} value={sentence.text} onChange={event => editSentence({ text: event.target.value, reviewed: false })} /></label><label>中文译文（可选）<textarea rows={2} value={sentence.translation || ''} onChange={event => editSentence({ translation: event.target.value, reviewed: false })} /></label></div><div className="timing-actions"><label className="toggle-label"><input type="checkbox" checked={sentence.reviewed} onChange={event => editSentence({ reviewed: event.target.checked })} /> 已对照录音，人工确认这句话文字和边界准确</label><button className="button outlined" disabled={!dirty || busy} onClick={() => void save(false)}>保存校对</button><button className="button primary" disabled={busy || reviewed !== allSentences.length || !allSentences.length} title="所有句子与其他资料核验通过后，手动标记完成" onClick={() => void save(true)}><ShieldCheck size={15} /> 确认原文与时间轴核验</button></div></> : <p className="muted">还没有句子可校对。请先通过资料导入补齐英文原文及候选句子。</p>}</section>;
}
