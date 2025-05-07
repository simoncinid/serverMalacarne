/******************************************************************
 *  server.js – Backend Threads + Analyze + Email notifier        *
 *  © 2025 – ES Modules ready for Render                          *
 ******************************************************************/

/* -------------------- carica .env in locale ------------------- */
import { fileURLToPath } from 'url';
import { dirname } from 'path';
if (process.env.NODE_ENV !== 'production') {
  const { config } = await import('dotenv');
  config({ path: `${dirname(fileURLToPath(import.meta.url))}/.env` });
}

/* -------------------- librerie ------------------- */
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { OpenAI } from 'openai';

/* -------------------- variabili ambiente ------------------- */
const OPENAI_KEY         = (process.env.OPENAI_KEY         || '').trim();
const ASSISTANT_ID       = (process.env.ASSISTANT_ID       || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').trim();

// mittente e destinatario – modifica TO_EMAIL se necessario
const FROM_EMAIL = 'simoncinidiego10@gmail.com';
const TO_EMAIL   = 'simone@studiomalacarne.com'; // ← gmai.com: correggi se è un refuso

if (!OPENAI_KEY || !ASSISTANT_ID || !GMAIL_APP_PASSWORD) {
  console.error('❌  OPENAI_KEY, ASSISTANT_ID o GMAIL_APP_PASSWORD mancanti nelle variabili ambiente');
  process.exit(1);
}

/* -------------------- OpenAI ------------------- */
const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* -------------------- Nodemailer ------------------- */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: FROM_EMAIL,
    pass: GMAIL_APP_PASSWORD
  }
});

/* -------------------- Express ------------------- */
const app = express();
app.use(express.json());
app.use(cors()); // CORS aperto; restringi se necessario

/* -------------------- helper ------------------- */
function isComplete(obj) {
  return Object.values(obj).every(v => typeof v === 'string' && v.trim() !== '');
}

/* ==================================================================== *
 *  POST /api/conversation                                              *
 *  (alias /chat lato frontend)                                         *
 * ==================================================================== */
app.post('/api/conversation', async (req, res) => {
  const { threadId, message } = req.body;
  let id = threadId;

  try {
    /* ------ crea thread se non c'è ------ */
    if (!id) {
      const th = await openai.beta.threads.create({
        messages: [{ role: 'user', content: message }]
      });
      id = th.id;
    } else {
      await openai.beta.threads.messages.create(id, {
        role: 'user',
        content: message
      });
    }

    /* ------ avvia run ------ */
    let run = await openai.beta.threads.runs.create(id, { assistant_id: ASSISTANT_ID });

    while (run.status !== 'completed') {
      await new Promise(r => setTimeout(r, 800));
      run = await openai.beta.threads.runs.retrieve(id, run.id);
    }

    const msgs = await openai.beta.threads.messages.list(id);
    res.json({ threadId: id, messages: msgs.data });
  } catch (err) {
    console.error('❌ /api/conversation error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==================================================================== *
 *  POST /api/analyze                                                   *
 *  - se i dati sono completi ⇒ invia email e risponde {status:'finished'}
 *  - se incompleti     ⇒ NON fa nulla (nessuna mail) e risponde 204    *
 * ==================================================================== */
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
    /* ------ chiama GPT-4o per estrarre i dati ------ */
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Extract customer info to JSON.' },
        { role: 'user',   content: prompt }
      ]
    });

    /* ------ pulizia output ------ */
    let raw = completion.choices[0].message.content.trim();
    if (raw.startsWith('```'))
      raw = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    const data = JSON.parse(raw);

    /* ------ se completo invia mail ------ */
    if (isComplete(data)) {
      const mail = {
        from: `\"Chat Assistant\" <${FROM_EMAIL}>`,
        to: TO_EMAIL,
        subject: 'Nuovo contatto compilato',
        text: JSON.stringify(data, null, 2)
      };

      await transporter.sendMail(mail);
      return res.json({ status: 'finished', data });
    }

    /* ------ incompleto: non fare nulla, rispondi 204 No Content ------ */
    return res.status(204).end();
  } catch (err) {
    console.error('❌ /api/analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- avvio server ------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀  Backend in ascolto sulla porta ${PORT}`));
