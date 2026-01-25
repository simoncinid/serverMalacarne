/******************************************************************
 *  server.js – Backend Threads + Analyze + Email notifier        *
 *  © 2025 – ES Modules ready for Render                          *
 ******************************************************************/

console.log('📦 server.js caricato - avvio inizializzazione...');

/* -------------------- carica .env in locale ------------------- */
import { fileURLToPath } from 'url';
import { dirname } from 'path';
console.log('🔧 Inizializzazione server...');
console.log('🔧 NODE_ENV:', process.env.NODE_ENV);

if (process.env.NODE_ENV !== 'production') {
  try {
    const { config } = await import('dotenv');
    config({ path: `${dirname(fileURLToPath(import.meta.url))}/.env` });
    console.log('✅ .env caricato (locale)');
  } catch (err) {
    console.warn('⚠️  Impossibile caricare .env:', err.message);
  }
} else {
  console.log('✅ Modalità produzione (nessun .env)');
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
const FROM_EMAIL = 'reservationwebbitz@gmail.com';
const TO_EMAIL   = 'simone@studiomalacarne.com';

console.log('🔍 Verifica variabili ambiente...');
console.log('🔍 OPENAI_KEY presente:', !!OPENAI_KEY);
console.log('🔍 ASSISTANT_ID presente:', !!ASSISTANT_ID);
console.log('🔍 GMAIL_APP_PASSWORD presente:', !!GMAIL_APP_PASSWORD);

if (!OPENAI_KEY || !ASSISTANT_ID || !GMAIL_APP_PASSWORD) {
  console.error('❌  OPENAI_KEY, ASSISTANT_ID o GMAIL_APP_PASSWORD mancanti nelle variabili ambiente');
  process.exit(1);
}
console.log('✅ Tutte le variabili ambiente sono presenti');

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
console.log('🔧 Configurazione Express...');
const app = express();

// Middleware per loggare tutte le richieste
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`📥 [${timestamp}] ${req.method} ${req.path} - IP: ${req.ip || req.connection.remoteAddress}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`📦 Body ricevuto:`, JSON.stringify(req.body).substring(0, 200));
  }
  next();
});

app.use(express.json());
app.use(cors()); // CORS aperto; restringi se necessario
console.log('✅ Middleware Express configurati');

/* -------------------- Health Check ------------------- */
app.get('/health', (req, res) => {
  console.log('💚 Health check richiesto');
  const response = { status: 'ok', timestamp: new Date().toISOString() };
  console.log('💚 Health check response:', response);
  res.json(response);
});
console.log('✅ Endpoint /health configurato');

/* -------------------- helper ------------------- */
function isComplete(obj) {
  // Per inviare un lead basta avere almeno un contatto (email O telefono)
  const email = (obj.emailAddress || '').trim();
  const phone = (obj.phoneNumber || '').trim();
  
  // Almeno uno dei due contatti deve essere presente
  return email !== '' || phone !== '';
}

/* ==================================================================== *
 *  POST /api/conversation                                              *
 *  (alias /chat lato frontend)                                         *
 * ==================================================================== */
app.post('/api/conversation', async (req, res) => {
  console.log('💬 POST /api/conversation - Richiesta ricevuta');
  const { threadId, message } = req.body;
  console.log('💬 threadId:', threadId || 'nuovo');
  console.log('💬 message:', message?.substring(0, 100) || 'vuoto');
  let id = threadId;

  try {
    /* ------ crea thread se non c'è ------ */
    if (!id) {
      console.log('💬 Creazione nuovo thread...');
      const th = await openai.beta.threads.create({
        messages: [{ role: 'user', content: message }]
      });
      id = th.id;
      console.log('💬 Thread creato:', id);
    } else {
      console.log('💬 Aggiunta messaggio al thread esistente:', id);
      await openai.beta.threads.messages.create(id, {
        role: 'user',
        content: message
      });
      console.log('💬 Messaggio aggiunto al thread');
    }

    /* ------ avvia run ------ */
    console.log('💬 Avvio run con assistant_id:', ASSISTANT_ID);
    let run = await openai.beta.threads.runs.create(id, { assistant_id: ASSISTANT_ID });
    console.log('💬 Run creato, status iniziale:', run.status);

    let attempts = 0;
    while (run.status !== 'completed') {
      attempts++;
      console.log(`💬 Run status (tentativo ${attempts}):`, run.status);
      await new Promise(r => setTimeout(r, 800));
      run = await openai.beta.threads.runs.retrieve(id, run.id);
      
      if (run.status === 'failed') {
        console.error('💬 Run fallito:', run);
        throw new Error('Run fallito: ' + JSON.stringify(run));
      }
    }

    console.log('💬 Run completato, recupero messaggi...');
    const msgs = await openai.beta.threads.messages.list(id);
    console.log('💬 Messaggi recuperati:', msgs.data.length);
    console.log('💬 Invio risposta al client');
    res.json({ threadId: id, messages: msgs.data });
  } catch (err) {
    console.error('❌ /api/conversation error:', err);
    console.error('❌ Stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

/* ==================================================================== *
 *  POST /api/analyze                                                   *
 *  - se i dati sono completi ⇒ invia email e risponde {status:'finished'}
 *  - se incompleti     ⇒ NON fa nulla (nessuna mail) e risponde 204    *
 * ==================================================================== */
app.post('/api/analyze', async (req, res) => {
  console.log('🔍 POST /api/analyze - Richiesta ricevuta');
  const { messages } = req.body;
  console.log('🔍 Numero messaggi da analizzare:', messages?.length || 0);

  const prompt = `
You are a JSON extractor. From the conversation below, return ONLY a JSON with:
fullName, emailAddress, phoneNumber, description, userType.
If a field is missing, use an empty string.

Conversation:
${JSON.stringify(messages)}
`.trim();

  try {
    /* ------ chiama GPT-4o per estrarre i dati ------ */
    console.log('🔍 Chiamata a GPT-4o per estrazione dati...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Extract customer info to JSON.' },
        { role: 'user',   content: prompt }
      ]
    });
    console.log('🔍 Risposta GPT-4o ricevuta');

    /* ------ pulizia output ------ */
    let raw = completion.choices[0].message.content.trim();
    console.log('🔍 Raw response (primi 200 char):', raw.substring(0, 200));
    if (raw.startsWith('```'))
      raw = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    const data = JSON.parse(raw);
    console.log('🔍 Dati estratti:', JSON.stringify(data));

    /* ------ se completo invia mail ------ */
    const complete = isComplete(data);
    console.log('🔍 Dati completi?', complete);
    
    if (complete) {
      console.log('📧 Invio email a:', TO_EMAIL);
      const mail = {
        from: `\"Chat Assistant\" <${FROM_EMAIL}>`,
        to: TO_EMAIL,
        subject: 'Nuovo contatto compilato',
        text: JSON.stringify(data, null, 2)
      };

      await transporter.sendMail(mail);
      console.log('📧 Email inviata con successo');
      return res.json({ status: 'finished', data });
    }

    /* ------ incompleto: non fare nulla, rispondi 204 No Content ------ */
    console.log('🔍 Dati incompleti, risposta 204');
    return res.status(204).end();
  } catch (err) {
    console.error('❌ /api/analyze error:', err);
    console.error('❌ Stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- avvio server ------------------- */
const PORT = process.env.PORT || 8080;
console.log(`🔧 Tentativo di avvio sulla porta ${PORT}...`);

try {
  app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`🚀  Backend in ascolto sulla porta ${PORT}`);
    console.log(`🌐 Health check disponibile su: http://localhost:${PORT}/health`);
    console.log(`📡 Endpoint disponibili:`);
    console.log(`   - GET  /health`);
    console.log(`   - POST /api/conversation`);
    console.log(`   - POST /api/analyze`);
    console.log('='.repeat(50));
    console.log('✅ Server completamente avviato e pronto!');
  });
} catch (err) {
  console.error('❌ Errore durante l\'avvio del server:', err);
  console.error('❌ Stack:', err.stack);
  process.exit(1);
}

// Gestione errori non catturati
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
