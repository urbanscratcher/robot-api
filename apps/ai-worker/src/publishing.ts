export type PiezoLevel = 0 | 1 | 2;
export const PIEZO_LABELS = ["어그로성 기자", "조금 착하게", "완전 아첨"] as const;
export type NewsCard = { imageId: string; title: string; body: string };

export type Observation = {
  eventId: string;
  capturedAt: string;
  sensors: Record<string, string | number | boolean>;
  image?: string;
  audio?: string;
};
export type Publication = {
  input: Observation;
  status: 'received' | 'generating' | 'failed' | 'draft' | 'publishing' | 'published' | 'unknown' | 'skipped';
  awaitingInput?: boolean;
  revision: number;
  caption: string;
  imageUrl: string;
  uploadedImageId?: string;
  transcript?: string;
  error?: string;
  containerId?: string;
  mediaId?: string;
  publishedAt?: string;
  instagramUserId?: string;
  prompt?: string;
  piezoLevel?: PiezoLevel;
  cards?: NewsCard[];
  phase?: string;
  generationProgress?: { stage: 'ai_generating' | 'cards_generating'; current: number; total: number };
  generatedImagePrompt?: string;
  imageSeed?: number;
};
