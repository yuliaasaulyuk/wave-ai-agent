// Wave Mobile AI agent — serverless endpoint (Netlify Functions).
// Keeps the Gemini API key on the server: set GEMINI_API_KEY in Netlify → Site configuration → Environment variables.

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const SYSTEM = `You are the customer support AI agent of Wave Mobile, a mobile operator.
Rules:
- Answer ONLY using the knowledge base articles provided. Never invent prices, codes or policies.
- Reply in the same language as the customer's question (Ukrainian or English).
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

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: "model_error", status: r.status }) };
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const out = JSON.parse(text);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "server_error" }) };
  }
};
