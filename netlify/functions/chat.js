// Wave Mobile AI agent — serverless endpoint (Netlify Functions).
// Keeps the Gemini API key on the server: set GEMINI_API_KEY in Netlify → Project configuration → Environment variables.

// Model names change over time, so try a few and fall back to whatever "flash" model the key can use.
const CANDIDATES = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean);
let cachedModel = null;

async function listFlash(key) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/i.test(m.name) && !/image|tts|audio|live|embedding/i.test(m.name))
      .map(m => m.name.replace(/^models\//, ""))
      .sort().reverse();
  } catch { return []; }
}

const SYSTEM = `You are the customer support AI agent of Wave Mobile, a mobile operator.
Rules:
- Answer ONLY using the knowledge base articles provided. Never invent prices, codes or policies.
- Reply in the same language as the customer's question.
- Keep answers short and friendly: 1–3 sentences.
- Classify every reply with a status:
  "answer"    – the knowledge base fully answers the question;
  "partial"   – the knowledge base answers only part of it (say what you don't know);
  "unknown"   – the question is about Wave Mobile / mobile services, but the knowledge base has no answer;
  "off_topic" – the question is not about Wave Mobile or mobile services at all.
- For "unknown": say honestly you don't have this information yet and offer to connect a human specialist.
- For "off_topic": politely say you can't help with questions like this, and ask if there is anything about their Wave Mobile plan or services you can help with. Do not answer the off-topic question.
Return JSON only: {"status": "...", "answer": "...", "sources": ["<article id>", ...], "confidence": <0..1>}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { statusCode: 503, body: JSON.stringify({ error: "no_key" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Bad JSON" }; }
  const question = String(body.question || "").slice(0, 500);
  const kb = Array.isArray(body.kb) ? body.kb.slice(0, 60) : [];
  if (!question) return { statusCode: 400, body: "Empty question" };

  const st = body.settings || {};
  const LANG = { en: "English", uk: "Ukrainian", pl: "Polish", de: "German" };
  const extra = [
    st.lang && st.lang !== "auto" ? `- Always reply in ${LANG[st.lang] || "English"}, whatever language the customer uses.` : "",
    st.kbOnly === false ? `- If the knowledge base has no answer but the question is about mobile services, you may answer from general knowledge; then use status "partial".` : "",
    st.off === "answer" ? `- For off-topic questions, DO answer briefly from general knowledge and use status "general" instead of "off_topic".` : "",
    st.human === false ? `- Never offer to connect a human; instead mention the free hotline 777 and the chat in the My Wave app.` : "",
    `- If the customer asks to talk to a person/human/operator, use status "handoff" and confirm a specialist will contact them${st.human === false ? " via hotline 777" : " (ask for their email)"}.`
  ].filter(Boolean).join("\n");
  const kbText = kb.map(a => `[${a.id}] ${a.title}\n${String(a.content).slice(0, 1200)}`).join("\n\n");
  const prompt = `${SYSTEM}\n${extra}\n\nKNOWLEDGE BASE:\n${kbText}\n\nCUSTOMER QUESTION:\n${question}`;

  const call = (model) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
    })
  });

  try {
    const tried = cachedModel ? [cachedModel] : [...CANDIDATES];
    let listed = false, r = null, lastStatus = 0, used = null;
    for (let i = 0; i < tried.length; i++) {
      r = await call(tried[i]);
      if (r.ok) { used = tried[i]; break; }
      lastStatus = r.status;
      if (r.status !== 404 && r.status !== 400) break;
      if (i === tried.length - 1 && !listed) {
        listed = true;
        const more = (await listFlash(key)).filter(m => !tried.includes(m));
        tried.push(...more.slice(0, 3));
      }
    }
    if (!used) return { statusCode: 502, body: JSON.stringify({ error: "model_error", status: lastStatus }) };
    cachedModel = used;
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    out.model = used;
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "server_error" }) };
  }
};
