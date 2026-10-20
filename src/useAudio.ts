import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { createProgressPersistence } from './progressPersistence';
import type { LoopMode, Paper, Progress, Sentence } from './types';

export function useAudio(paper: Paper | null, progress: Progress[], onError: (message: string) => void, onProgress?: (progress: Progress) => void) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const paperRef = useRef(paper);
  const loadedPaperRef = useRef<Paper | null>(null);
  const progressRef = useRef(progress);
  const recentProgressRef = useRef(new Map<string, Progress>());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const errorRef = useRef(onError);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  paperRef.current = paper; progressRef.current = progress; errorRef.current = onError;
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);
  const [loopMode, setLoopState] = useState<LoopMode>('off');
  const [repeatCount, setRepeatCount] = useState(3);
  const [gap, setGap] = useState(1);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const loopRef = useRef<LoopMode>('off');
  const sentenceRef = useRef<Sentence | null>(null);
  const abRef = useRef<{ a: number | null; b: number | null }>({ a: null, b: null });
  const repeatRef = useRef(3), gapRef = useRef(1), countRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const secondsRef = useRef(0), activeIdRef = useRef<string | null>(null);
  const loadedRef = useRef(false), saveErrorRef = useRef(false), listeningErrorRef = useRef(false);
  // In-place proofreading may replace the same paper object without reloading
  // its audio; keep those sentence bounds current, but retain the old paper
  // until its final position has been saved when switching to another paper.
  if (paper?.id === activeIdRef.current) loadedPaperRef.current = paper;
  const persistencePausedRef = useRef(false);
  const progressPersistenceRef = useRef<ReturnType<typeof createProgressPersistence> | null>(null);
  if (!progressPersistenceRef.current) progressPersistenceRef.current = createProgressPersistence(async (updated, beacon) => {
    const response = await fetch(`/api/progress/${encodeURIComponent(updated.paperId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated), keepalive: beacon });
    if (!response.ok) throw new Error('Progress save failed');
    saveErrorRef.current = false; onProgressRef.current?.(updated);
  }, () => {
    if (!saveErrorRef.current) errorRef.current('播放进度暂未保存，请检查本地服务是否仍在运行。');
    saveErrorRef.current = true;
  });
  useEffect(() => { progressPersistenceRef.current?.initialize(progress); }, [progress]);
  const currentSentence = paper?.passages.flatMap(p => p.sentences).find(s => s.end > s.start && position >= s.start && position < s.end) || null;

  const clearWait = useCallback(() => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = null; setWaiting(false);
  }, []);

  const flushListening = useCallback((id?: string | null, beacon = false) => {
    const paperId = id || activeIdRef.current;
    if (!paperId || secondsRef.current < 0.05) return;
    const seconds = Math.min(15, secondsRef.current);
    secondsRef.current -= seconds;
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/listening', new Blob([JSON.stringify({ paperId, seconds })], { type: 'application/json' }));
      return;
    }
    api('/api/listening', 'POST', { paperId, seconds }).then(() => { listeningErrorRef.current = false; }).catch(() => {
      secondsRef.current += seconds;
      if (!listeningErrorRef.current) errorRef.current('播放时长暂未保存，连接恢复后会重试。');
      listeningErrorRef.current = true;
    });
  }, []);

  const save = useCallback((beacon = false): Promise<void> => {
    const audio = audioRef.current;
    const paperId = activeIdRef.current;
    if (!audio || !paperId || !loadedRef.current || persistencePausedRef.current) return saveQueueRef.current;
    const sentence = loadedPaperRef.current?.passages.flatMap(p => p.sentences).find(s => s.end > s.start && audio.currentTime >= s.start && audio.currentTime < s.end);
    const updated: Progress = { paperId, position: audio.currentTime || 0, rate: audio.playbackRate, sentenceId: sentence?.id, loopMode: loopRef.current, updatedAt: new Date().toISOString() };
    recentProgressRef.current.set(paperId, updated);
    if (beacon) return progressPersistenceRef.current!.save(updated, true);
    saveQueueRef.current = progressPersistenceRef.current!.save(updated);
    return saveQueueRef.current;
  }, []);

  const restoreProgress = useCallback((restored: Progress[]) => {
    progressPersistenceRef.current?.reset(restored);
    recentProgressRef.current = new Map(restored.map(item => [item.paperId, item]));
    progressRef.current = restored;
    const saved = restored.find(item => item.paperId === activeIdRef.current), audio = audioRef.current;
    if (audio && loadedRef.current) {
      audio.currentTime = Math.max(0, Math.min(saved?.position || 0, audio.duration || 0));
      audio.playbackRate = saved?.rate || 1; setPosition(audio.currentTime); setRateState(audio.playbackRate);
    }
    persistencePausedRef.current = false;
  }, []);

  const beginRestore = useCallback(async () => {
    clearWait(); audioRef.current?.pause(); flushListening();
    const pending = save(); persistencePausedRef.current = true; await pending;
  }, [clearWait, flushListening, save]);
  const endRestore = useCallback(() => { persistencePausedRef.current = false; }, []);

  const setLoopMode = useCallback((mode: LoopMode) => {
    clearWait(); stopAtRef.current = null; countRef.current = 0;
    loopRef.current = mode; setLoopState(mode);
  }, [clearWait]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !paperRef.current?.audioAssetId) return;
    clearWait();
    const repeatedSentence = loopRef.current === 'sentence' ? sentenceRef.current : null;
    // Pausing during the inter-sentence gap has already counted the completed
    // playback. Resume at its start instead of counting the same end again.
    if (repeatedSentence && audio.currentTime >= repeatedSentence.end - 0.015) audio.currentTime = repeatedSentence.start;
    if (audio.ended || (audio.duration && audio.currentTime >= audio.duration)) audio.currentTime = 0;
    try { await audio.play(); } catch { errorRef.current('音频尚未播放成功，请重试；也可以在资料状态中检查音频。'); }
  }, [clearWait]);

  const pause = useCallback(() => {
    clearWait(); audioRef.current?.pause(); save(); flushListening();
  }, [clearWait, save, flushListening]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !loadedRef.current) return;
    clearWait(); stopAtRef.current = null;
    audio.currentTime = Math.max(0, Math.min(audio.duration || paperRef.current?.duration || 0, seconds));
    setPosition(audio.currentTime); save();
  }, [clearWait, save]);

  const playRange = useCallback((start: number, end: number) => {
    if (!(end > start)) { errorRef.current('这段资料的时间轴还没有完成校对。'); return; }
    setLoopMode('off'); seek(start); stopAtRef.current = end; void play();
  }, [setLoopMode, seek, play]);

  const loopSentence = useCallback((sentence: Sentence | null) => {
    if (!sentence || sentence.end <= sentence.start) { errorRef.current('请先选择有时间轴的句子。'); return; }
    sentenceRef.current = sentence; setLoopMode('sentence'); seek(sentence.start); void play();
  }, [setLoopMode, seek, play]);

  const setRate = useCallback((value: number) => {
    const audio = audioRef.current; if (audio) { audio.playbackRate = value; audio.preservesPitch = true; }
    setRateState(value); save();
  }, [save]);

  const setAB = useCallback((start: number | null, end: number | null) => {
    if (start !== null) start = Math.max(0, Math.min(start, audioRef.current?.duration || paperRef.current?.duration || 0));
    if (end !== null) end = Math.max(0, Math.min(end, audioRef.current?.duration || paperRef.current?.duration || 0));
    setA(start); setB(end); abRef.current = { a: start, b: end };
    if (loopRef.current === 'ab' && (start === null || end === null || end - start < 0.2)) setLoopMode('off');
  }, [setLoopMode]);

  const startAB = useCallback(() => {
    const { a: start, b: end } = abRef.current;
    if (start === null || end === null || end - start < 0.2) { errorRef.current('请设置 A、B 两个位置，B 至少比 A 晚 0.2 秒。'); return; }
    setLoopMode('ab'); seek(start); void play();
  }, [setLoopMode, seek, play]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    save(); flushListening(); clearWait(); audio.pause();
    loadedRef.current = false; activeIdRef.current = paper?.id || null; loadedPaperRef.current = paper;
    setPosition(0); setDuration(paper?.duration || 0); setSessionSeconds(0); setLoopMode('off'); setAB(null, null);
    if (!paper?.audioAssetId) { audio.removeAttribute('src'); audio.load(); return; }
    audio.src = `/media/${encodeURIComponent(paper.audioAssetId)}`;
    const saved = recentProgressRef.current.get(paper.id) || progressRef.current.find(p => p.paperId === paper.id);
    const onLoaded = () => {
      loadedRef.current = true;
      if (saved) { audio.currentTime = Math.min(saved.position || 0, audio.duration || 0); audio.playbackRate = saved.rate || 1; setRateState(audio.playbackRate); }
      else { audio.playbackRate = 1; setRateState(1); }
      audio.preservesPitch = true; setDuration(audio.duration || paper.duration); setPosition(audio.currentTime);
    };
    audio.addEventListener('loadedmetadata', onLoaded); audio.load();
    return () => { audio.removeEventListener('loadedmetadata', onLoaded); };
  // Progress changes must not reload the global audio element.
  }, [paper?.id, paper?.audioAssetId, clearWait, flushListening, save, setAB, setLoopMode]);

  useEffect(() => {
    const audio = audioRef.current; if (!audio) return;
    const onPause = () => { setPlaying(false); save(); flushListening(); };
    const onPlay = () => setPlaying(true);
    const onTime = () => setPosition(audio.currentTime);
    const onError = () => { if (audio.getAttribute('src')) errorRef.current('无法读取这份音频。请检查资料文件，或重新导入音频。'); setPlaying(false); };
    const processLoopBoundary = () => {
      if (timeoutRef.current !== null) return false;
      const range = loopRef.current === 'sentence' && sentenceRef.current ? { start: sentenceRef.current.start, end: sentenceRef.current.end } : loopRef.current === 'ab' && abRef.current.a !== null && abRef.current.b !== null ? { start: abRef.current.a, end: abRef.current.b } : null;
      if (!range || audio.currentTime < range.end - 0.015) return false;
      if (loopRef.current === 'sentence') {
        countRef.current += 1;
        if (repeatRef.current !== 0 && countRef.current >= repeatRef.current) {
          audio.pause(); loopRef.current = 'off'; setLoopState('off'); setPosition(audio.currentTime);
        } else {
          audio.pause(); setWaiting(true);
          timeoutRef.current = setTimeout(() => { timeoutRef.current = null; setWaiting(false); audio.currentTime = range.start; void audio.play().catch(onError); }, gapRef.current * 1000);
        }
      } else {
        const resume = audio.paused || audio.ended;
        audio.currentTime = range.start;
        if (resume) void audio.play().catch(onError);
      }
      return true;
    };
    const onEnded = () => {
      // Physical media end pauses the element before the next animation frame.
      // Process its active range here too, ignoring an obsolete queued event.
      if (timeoutRef.current !== null || !audio.ended && audio.currentTime < audio.duration - 0.02) return;
      if (processLoopBoundary()) return;
      if (loopRef.current === 'all') { audio.currentTime = 0; void audio.play().catch(onError); }
      else { setPlaying(false); save(); flushListening(); }
    };
    audio.addEventListener('pause', onPause); audio.addEventListener('play', onPlay); audio.addEventListener('timeupdate', onTime); audio.addEventListener('error', onError); audio.addEventListener('ended', onEnded);
    let raf = 0;
    const boundary = () => {
      if (!audio.paused && timeoutRef.current === null) {
        if (stopAtRef.current !== null && audio.currentTime >= stopAtRef.current) { audio.pause(); stopAtRef.current = null; }
        processLoopBoundary();
      }
      raf = requestAnimationFrame(boundary);
    };
    raf = requestAnimationFrame(boundary);
    let previousWall = performance.now(), previousAudio = audio.currentTime, sinceSave = 0;
    const ticker = setInterval(() => {
      const now = performance.now(), elapsed = Math.min(15, (now - previousWall) / 1000);
      if (!audio.paused && !audio.seeking && audio.readyState >= 3 && audio.currentTime !== previousAudio) {
        const advancement = audio.currentTime - previousAudio;
        const actualSeconds = advancement >= 0 ? Math.min(elapsed, advancement / audio.playbackRate) : elapsed;
        secondsRef.current += actualSeconds; setSessionSeconds(value => value + actualSeconds);
        if (secondsRef.current >= 10) flushListening();
      }
      previousWall = now; previousAudio = audio.currentTime; sinceSave += 0.25;
      if (sinceSave >= 2) { sinceSave = 0; save(); }
    }, 250);
    const onUnload = () => { save(true); flushListening(undefined, true); };
    window.addEventListener('pagehide', onUnload);
    return () => { cancelAnimationFrame(raf); clearInterval(ticker); clearWait(); audio.removeEventListener('pause', onPause); audio.removeEventListener('play', onPlay); audio.removeEventListener('timeupdate', onTime); audio.removeEventListener('error', onError); audio.removeEventListener('ended', onEnded); window.removeEventListener('pagehide', onUnload); };
  }, [save, flushListening, clearWait]);

  return { audioRef, playing, position, duration, rate, loopMode, repeatCount, gap, a, b, waiting, sessionSeconds, currentSentence, play, pause, seek, playRange, loopSentence, setLoopMode, setRate, setAB, startAB, save, restoreProgress, beginRestore, endRestore,
    setRepeatCount: (value: number) => { repeatRef.current = value; setRepeatCount(value); countRef.current = 0; },
    setGap: (value: number) => { gapRef.current = value; setGap(value); },
  };
}

export type AudioController = ReturnType<typeof useAudio>;
