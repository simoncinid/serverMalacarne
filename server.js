// server.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { OpenAI } = require('openai');

// ——— chiavi
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY?.trim() });
const ASSISTANT_ID = (process.env.ASSISTANT_ID || '').trim();

if (!process.env.OPENAI_KEY || !ASSISTANT_ID)
  throw new Error('⚠️  Manca OPENAI_KEY o ASSISTANT_ID nel .env su Render');

const app = express();
app.use(express.json());
app.use(cors());                 // aperto a tutti. Se vuoi, limita col parametro origin

// ---- POST /api/conversation -----------------------------------------------
app.post('/api/conversation', async (req, res) => {
  const { threadId, message } = req.body;
  let id = threadId;
  try {
    if (!id) {
      const th = await openai.beta.threads.create({
        messages: [{ role: 'user', content: message }]
      });
      id = th.id;
    } else {
      await openai.beta.threads.messages.create(id, {
        role: 'user', content: message
      });
    }

    let run = await openai.beta.threads.runs.create(id, { assistant_id: ASSISTANT_ID });
    while (run.status !== 'completed') {
      await new Promise(r => setTimeout(r, 600));
      run = await openai.beta.threads.runs.retrieve(id, run.id);
    }

    const msgs = await openai.beta.threads.messages.list(id);
    res.json({ threadId: id, messages: msgs.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/analyze -----------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  const { messages } = req.body;
  const prompt = `
You are a JSON extractor. From the conversation below, return ONLY a JSON with:
fullName, emailAddress, phoneNumber, description, userType.
If a field is missing, use an empty string.

Conversation:
${JSON.stringify(messages)}
`.trim();

  try {
    const comp = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Extract customer info to JSON.' },
        { role: 'user',   content: prompt }
      ]
    });
    let raw = comp.choices[0].message.content.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim();
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- start -----------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('🚀  backend in ascolto porta', PORT));
