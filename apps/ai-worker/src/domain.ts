export type Kind = "observation" | "inference" | "fiction";
export type Claim = {
  id: string;
  text: string;
  kind: Kind;
  sourceIds: string[];
  firstGeneration: number;
  origin?: ClaimOrigin;
  semanticMatch?: boolean;
  relation?: "new" | "inherited" | "human";
};
export type Article = {
  title: string;
  summary: string;
  situation: string;
  body: Claim[];
  alternatives: string[];
  quotes: string[];
  imagePrompt?: string;
  observedFacts?: string[];
  inferredFacts?: string[];
  inventedDetails?: string[];
};
export type Intervention = {
  deleted: string[];
  emphasized: string[];
  inserted: string;
  direction: string;
  imagePrompt?: string;
  replacementImage?: string;
};
export type Generation = {
  number: number;
  article: Article;
  intervention: Intervention;
  demo: boolean;
  id?: string;
  parentId?: string | null;
  generationNumber?: number;
  inputImage?: string;
  generatedImage?: string;
  imagePrompt?: string;
  claims?: Claim[];
  claimOrigins?: Record<string, ClaimOrigin>;
  humanInterventions?: Intervention;
  seed?: number;
  denoise?: number;
  generationDuration?: number;
  createdAt?: string;
  automatic?: boolean;
  changes?: Changes;
  imageComparisonError?: string;
  headline?: string;
  observedFacts?: string[];
  inferredFacts?: string[];
  inventedDetails?: string[];
  alternativeInterpretations?: string[];
};
export const emptyIntervention = (): Intervention => ({
  deleted: [],
  emphasized: [],
  inserted: "",
  direction: "",
});
export const articleSchema = {
  type: "object",
  required: ["title", "summary", "situation", "body", "alternatives", "quotes"],
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      description: "[허구]로 시작하는 구체적인 뉴스 헤드라인",
    },
    summary: {
      type: "string",
      description: "허구임을 밝히는 1~2문장의 기사 리드문",
    },
    situation: { type: "string" },
    body: {
      type: "array",
      description:
        "사건을 자연스럽게 전개하는 기사 본문. 각 항목은 한 문장이다.",
      minItems: 3,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "kind", "sourceIds"],
        properties: {
          text: { type: "string" },
          kind: {
            type: "string",
            enum: ["observation", "inference", "fiction"],
          },
          sourceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    alternatives: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "string" },
    },
    quotes: { type: "array", items: { type: "string" } },
  },
} as const;
export function validateArticle(value: unknown): asserts value is Article {
  const a = value as Article;
  if (
    !a ||
    !["title", "summary", "situation"].every(
      (k) =>
        typeof (a as unknown as Record<string, unknown>)[k] === "string" &&
        String((a as unknown as Record<string, unknown>)[k]).trim(),
    ) ||
    !Array.isArray(a.body) ||
    a.body.length < 3 ||
    a.body.length > 12 ||
    !a.body.every(
      (c) =>
        c &&
        typeof c.text === "string" &&
        c.text.trim() &&
        ["observation", "inference", "fiction"].includes(c.kind) &&
        Array.isArray(c.sourceIds) &&
        c.sourceIds.every((s) => typeof s === "string"),
    ) ||
    !Array.isArray(a.alternatives) ||
    a.alternatives.length !== 2 ||
    !a.alternatives.every((s) => typeof s === "string") ||
    !Array.isArray(a.quotes) ||
    !a.quotes.every((s) => typeof s === "string")
  )
    throw new Error(
      "모델 응답이 기사 JSON 형식과 일치하지 않습니다. 다시 시도해 주세요.",
    );
}
export function lineage(
  article: Omit<Article, "body"> & {
    body: Omit<Claim, "id" | "firstGeneration">[];
  },
  number: number,
  previous?: Article,
): Article {
  const allowed = new Map(previous?.body.map((c) => [c.id, c]) ?? []);
  return {
    ...article,
    body: article.body.map((c, i) => {
      const sourceIds = c.sourceIds.filter((id) => allowed.has(id));
      // Only exact reuse inherits a first appearance. Paraphrase links remain model assertions.
      const exact = previous?.body.find((p) => p.text.trim() === c.text.trim());
      return {
        ...c,
        id: `g${number}-c${i + 1}`,
        sourceIds,
        firstGeneration: exact?.firstGeneration ?? number,
        kind: number > 1 && c.kind === "observation" ? "inference" : c.kind,
      };
    }),
  };
}

export type ClaimOrigin =
  | "ORIGINAL_OBSERVATION"
  | "AI_INFERENCE"
  | "AI_INVENTION"
  | "INHERITED_AI_CLAIM"
  | "HUMAN_INTERVENTION";
export type Changes = {
  newClaimIds: string[];
  disappearedClaimIds: string[];
  inheritedClaimIds: string[];
  humanClaimIds: string[];
  imageAdded: string[];
  imageRemoved: string[];
  imageComparison: "AI_ESTIMATE" | "DEMO" | "UNAVAILABLE";
};
export type Session = {
  id: string;
  createdAt: string;
  original: { image: string; transcript: string };
  generations: Generation[];
  demo: boolean;
  job?: Job;
  reviewedGenerations?: number[];
};
export type Job = {
  id: string;
  sessionId: string;
  status: "running" | "stopping" | "completed" | "stopped" | "failed";
  phase: string;
  currentGeneration: number;
  targetGeneration: number;
  error?: string;
  cancellationWarning?: string;
  comfyPromptId?: string;
  createdAt: string;
};
export const isActiveJob = (job: Job | null) =>
  job?.status === "running" || job?.status === "stopping";
export const hasIntervention = (e: Intervention) =>
  !!(
    e.deleted.length ||
    e.emphasized.length ||
    e.inserted.trim() ||
    e.direction.trim() ||
    e.imagePrompt?.trim() ||
    e.replacementImage
  );
export const multimodalSchema = {
  ...articleSchema,
  required: [...articleSchema.required, "imagePrompt"],
  properties: {
    ...articleSchema.properties,
    imagePrompt: {
      type: "string",
      description:
        "English visual scene prompt for SDXL, no instructions or identifiable real people",
    },
    body: {
      ...articleSchema.properties.body,
      items: {
        ...articleSchema.properties.body.items,
        required: [...articleSchema.properties.body.items.required, "relation"],
        properties: {
          ...articleSchema.properties.body.items.properties,
          relation: { type: "string", enum: ["new", "inherited", "human"] },
        },
      },
    },
  },
} as const;
export function trackClaims(
  article: Article,
  number: number,
  previous: Article | undefined,
  edit: Intervention,
): Article {
  const allowed = new Map(
    previous?.body
      .filter((c) => !edit.deleted.includes(c.id))
      .map((c) => [c.id, c]) ?? [],
  );
  return {
    ...article,
    body: article.body.map((c, i) => {
      const sourceIds = [...new Set(c.sourceIds)].filter((id) =>
        allowed.has(id),
      );
      const inherited = c.relation === "inherited" && sourceIds.length > 0;
      const human = c.relation === "human" && !!edit.inserted.trim();
      const exact = [...allowed.values()].find(
        (p) => p.text.trim() === c.text.trim(),
      );
      const origin: ClaimOrigin = human
        ? "HUMAN_INTERVENTION"
        : inherited
          ? "INHERITED_AI_CLAIM"
          : number === 1 && c.kind === "observation"
            ? "ORIGINAL_OBSERVATION"
            : c.kind === "fiction"
              ? "AI_INVENTION"
              : "AI_INFERENCE";
      return {
        ...c,
        id: `g${number}-c${i + 1}`,
        sourceIds,
        firstGeneration: inherited
          ? Math.min(...sourceIds.map((id) => allowed.get(id)!.firstGeneration))
          : (exact?.firstGeneration ?? number),
        origin,
        semanticMatch: inherited && !exact,
        kind: number > 1 && c.kind === "observation" ? "inference" : c.kind,
      };
    }),
  };
}
export function migrateGeneration(
  g: Generation,
  previous?: Generation,
): Generation {
  return {
    ...g,
    id: g.id ?? `legacy-g${g.number}`,
    parentId:
      g.parentId ??
      previous?.id ??
      (previous ? `legacy-g${previous.number}` : null),
    generationNumber: g.number,
    claims: g.claims ?? g.article.body,
    imagePrompt: g.imagePrompt ?? g.article.imagePrompt ?? "",
    humanInterventions: g.humanInterventions ?? g.intervention,
  };
}
