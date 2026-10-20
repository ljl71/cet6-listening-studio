export type Option = 'A' | 'B' | 'C' | 'D';
export type QualityState = 'missing' | 'candidate' | 'verified';
export type PassageType = 'conversation' | 'passage' | 'lecture';
export type LoopMode = 'off' | 'sentence' | 'ab' | 'all';
export type Quality = Record<'audio' | 'questions' | 'answers' | 'transcript' | 'timing', QualityState>;
export interface Source { url: string; label: string; kind: string; fetchedAt?: string; licenseNote?: string }
export interface Sentence { id: string; start: number; end: number; text: string; translation?: string; sourceParagraphId?: string; reviewed: boolean }
export interface Passage { id: string; order: number; type: PassageType; title: string; start: number; end: number; sentences: Sentence[]; sourceParagraphs?: { sourceId: string; text: string; translation?: string }[] }
export interface Question { id: string; number: number; passageId: string; options: Record<Option, string>; prompt?: string; answer?: Option; explanation?: string; evidenceSentenceIds?: string[] }
export interface Paper { id: string; title: string; year: number; month: number; actualDate?: string; originalPeriod?: string; variant: string; contentId: string; audioAssetId: string | null; duration: number; required: boolean; sources: Source[]; quality: Quality; passages: Passage[]; questions: Question[]; notes?: string[] }
export interface PaperSummary extends Omit<Paper, 'passages' | 'questions'> { passageCount: number; questionCount: number; ready: boolean }
export interface Attempt { id: string; paperId: string; mode: 'first' | 'review'; status: 'draft' | 'submitted'; answers: Record<string, Option>; assisted: boolean; createdAt: string; submittedAt?: string; result?: { correct: number; total: number; unanswered: number; byType: Record<PassageType, { correct: number; total: number }> } }
export interface Progress { paperId: string; position: number; rate: number; sentenceId?: string; loopMode?: LoopMode; updatedAt: string }
export interface Annotation { id: string; paperId: string; sentenceId?: string; questionId?: string; text: string; favorite: boolean; reason?: string; updatedAt: string }
export interface Stats { listeningSeconds: number; byPaper: Record<string, number> }
export interface Health { app: string; version: string; ready: boolean; corpus: { total: number; ready: number; missing: number; years: number[] } }
export const TYPE_LABEL: Record<PassageType, string> = { conversation: '长对话', passage: '听力篇章', lecture: '讲话 / 讲座' };
export const QUALITY_LABEL: Record<keyof Quality, string> = { audio: '音频', questions: '试题', answers: '答案', transcript: '原文', timing: '时间轴' };
export const STATUS_LABEL: Record<QualityState, string> = { missing: '待补齐', candidate: '待校对', verified: '已核验' };
export const OPTIONS: Option[] = ['A', 'B', 'C', 'D'];
