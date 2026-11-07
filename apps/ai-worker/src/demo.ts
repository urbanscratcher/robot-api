import { lineage, type Article, type Intervention } from "./domain.ts";
export const demoTranscript =
  "[00:03] “아까 그 사람 봤어?”\n[00:07] [기록되지 않음]\n[00:10] “그건 절대 말하면 안 돼.”\n[00:14] [기록되지 않음]\n[00:17] “내일 다시 보자.”";
export function demoArticle(
  n: number,
  previous?: Article,
  edit?: Intervention,
): Article {
  const body =
    n === 1
      ? [
          {
            text: "“내일 다시 보자”라는 짧은 말이 부분 녹취에 남았다.",
            kind: "observation" as const,
            sourceIds: [],
          },
          {
            text: "빠진 대화 사이로 이어진 이 약속은 두 사람이 다음 만남을 계획했을 가능성을 남겼다.",
            kind: "inference" as const,
            sourceIds: [],
          },
          {
            text: "가상의 이야기에서는 테이블 위 붉은 봉투가 다음 날 만남의 초대장으로 등장했다.",
            kind: "fiction" as const,
            sourceIds: [],
          },
          {
            text: "가상의 편집국은 봉투를 둘러싼 약속이 조용한 회담으로 이어졌다는 서사를 덧붙였다.",
            kind: "fiction" as const,
            sourceIds: [],
          },
          {
            text: "그러나 누락된 대화에 어떤 맥락이 있었는지는 확인되지 않아, 만남의 목적을 단정할 수 없다.",
            kind: "inference" as const,
            sourceIds: [],
          },
          {
            text: "이 약속은 그저 친구 사이의 평범한 인사였을 가능성도 있다.",
            kind: "inference" as const,
            sourceIds: [],
          },
        ]
      : [
          ...(previous?.body
            .filter((c) => !edit?.deleted.includes(c.id))
            .slice(0, 3)
            .map((c) => ({
              text: c.text,
              kind: c.kind === "observation" ? ("inference" as const) : c.kind,
              sourceIds: [c.id],
            })) ?? []),
          {
            text: `[창작] ${n}번째 보도에서 이 만남은 도시 전체가 기다린 사건으로 부풀려졌다.`,
            kind: "fiction" as const,
            sourceIds: [],
          },
          ...(edit?.inserted.trim()
            ? [
                {
                  text: `[창작 / 관객 삽입] ${edit.inserted}`,
                  kind: "fiction" as const,
                  sourceIds: [],
                },
              ]
            : []),
          ...(edit?.direction.trim()
            ? [
                {
                  text: `[추론 / 관객 방향] ${edit.direction}`,
                  kind: "inference" as const,
                  sourceIds: [],
                },
              ]
            : []),
          ...(edit?.emphasized.length
            ? [
                {
                  text: "[창작] 편집자가 강조한 단서는 편집국의 최대 관심사가 되었다.",
                  kind: "fiction" as const,
                  sourceIds: edit.emphasized.filter(
                    (id) => !edit.deleted.includes(id),
                  ),
                },
              ]
            : []),
        ];
  while (body.length < 3)
    body.push({
      text: `[창작] 누락된 맥락을 편집국이 상상으로 채웠다. ${body.length}`,
      kind: "fiction",
      sourceIds: [],
    });
  return lineage(
    {
      title:
        n === 1
          ? "[허구] “내일 다시 보자” 사라진 대화, 예고된 만남"
          : "[허구] 비밀 회담에서 도시의 사건으로, 소문은 스스로 자란다",
      summary:
        "불완전한 대화에서 시작된 가상의 보도다. 실제 사건으로 확인된 내용은 없다.",
      situation: "추측: 서로 무관한 말들이 하나의 사건으로 묶였을 수 있다.",
      body: body.slice(0, 12),
      alternatives: [
        "친구 사이의 평범한 다음 약속일 수 있다.",
        "사진과 대화는 서로 무관한 장면일 수 있다.",
      ],
      quotes: n === 1 ? ["내일 다시 보자."] : [],
    },
    n,
    previous,
  );
}
export function makeDemoImage() {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 780;
  const x = c.getContext("2d")!;
  x.fillStyle = "#292b2a";
  x.fillRect(0, 0, 1200, 780);
  x.fillStyle = "#575952";
  x.fillRect(80, 60, 1040, 500);
  x.fillStyle = "#b3b4a8";
  x.fillRect(110, 85, 980, 450);
  x.fillStyle = "#383b36";
  for (let i = 0; i < 7; i++) x.fillRect(110 + i * 160, 85, 14, 450);
  x.fillStyle = "#60625c";
  x.beginPath();
  x.moveTo(0, 780);
  x.lineTo(110, 535);
  x.lineTo(1090, 535);
  x.lineTo(1200, 780);
  x.fill();
  x.fillStyle = "#212321";
  x.fillRect(270, 470, 650, 30);
  x.fillRect(310, 500, 16, 180);
  x.fillRect(850, 500, 16, 180);
  x.fillStyle = "#222522";
  x.beginPath();
  x.ellipse(470, 344, 38, 45, 0, 0, Math.PI * 2);
  x.fill();
  x.fillRect(425, 385, 90, 91);
  x.beginPath();
  x.ellipse(735, 360, 34, 41, 0, 0, Math.PI * 2);
  x.fill();
  x.fillRect(695, 397, 83, 79);
  x.fillStyle = "#c6332d";
  x.fillRect(574, 451, 65, 19);
  const pixels = x.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 24;
    pixels.data[i] += noise;
    pixels.data[i + 1] += noise;
    pixels.data[i + 2] += noise;
  }
  x.putImageData(pixels, 0, 0);
  return c.toDataURL("image/jpeg", 0.85);
}
