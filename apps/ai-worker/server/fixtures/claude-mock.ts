// Adapt existing article fixtures at the test transport boundary, never in production.
type FixtureFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function claudeFixture(fixtureFetch: FixtureFetch, port = '11434'): FixtureFetch {
  return async (url, init) => {
    if (String(url) !== 'https://api.anthropic.com/v1/messages') return fixtureFetch(url, init);
    const input = JSON.parse(String(init?.body));
    const [system, schema] = input.system.split('\nReturn only a JSON object matching this schema, without Markdown: ');
    const messages = [{ role: 'system', content: system }, ...input.messages.map((message: any) => {
      const images = message.content.filter((block: any) => block.type === 'image').map((block: any) => block.source.data);
      return { role: message.role, content: message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''), ...(images.length ? { images } : {}) };
    })];
    const response = await fixtureFetch(`http://127.0.0.1:${port}/api/chat`, {
      ...init, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3:4b', stream: false, format: JSON.parse(schema), options: { num_predict: input.max_tokens }, messages }),
    });
    if (!response.ok) return response;
    const result = await response.json();
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: result.message.content }] });
  };
}
if (process.env.CLAUDE_FIXTURE_PORT) globalThis.fetch = claudeFixture(globalThis.fetch, process.env.CLAUDE_FIXTURE_PORT);
